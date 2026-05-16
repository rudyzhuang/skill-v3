'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runWithTimeout } = require('./run-with-timeout.cjs');

/**
 * @param {string} projectRoot
 * @param {string[]} args
 * @param {{ stdio?: 'inherit' | 'pipe' }} [o]
 */
function git(projectRoot, args, o = {}) {
  const stdio = o.stdio || 'pipe';
  return spawnSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8', stdio });
}

function isInsideGitWorkTree(projectRoot) {
  const r = git(projectRoot, ['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' });
  return r.status === 0 && String(r.stdout || '').trim() === 'true';
}

function isCleanWorkingTree(projectRoot) {
  const r = git(projectRoot, ['status', '--porcelain'], { stdio: 'pipe' });
  if (r.status !== 0) return false;
  return String(r.stdout || '').trim() === '';
}

/** Paths ignored for merge-push cleanliness (nested worktrees are separate git dirs). */
const MERGE_PORCELAIN_IGNORE_PREFIXES = [
  '.agent-sessions/',
  '.pipeline/worktrees/',
];

function porcelainPath(line) {
  if (!line || line.length < 4) return '';
  return line.slice(3).trim().replace(/^"\{(.+)\}"$/, '$1').split(' -> ')[0].trim();
}

function isCleanWorkingTreeForMerge(projectRoot) {
  const r = git(projectRoot, ['status', '--porcelain'], { stdio: 'pipe' });
  if (r.status !== 0) return false;
  const blocking = String(r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((line) => {
      const p = porcelainPath(line);
      return !MERGE_PORCELAIN_IGNORE_PREFIXES.some(
        (prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix)
      );
    });
  return blocking.length === 0;
}

const MERGE_AUTOSTASH_MESSAGE = 'ai-code3:pre-merge-push-autostash';

/**
 * Stash dirty main worktree so feature-branch merges can proceed during autorun.
 * @returns {{ ok: boolean, stashed?: boolean, error?: string }}
 */
function prepareWorkingTreeForMerge(projectRoot) {
  if (isCleanWorkingTreeForMerge(projectRoot)) return { ok: true, stashed: false };
  const r = git(
    projectRoot,
    ['stash', 'push', '-u', '-m', MERGE_AUTOSTASH_MESSAGE],
    { stdio: 'pipe' }
  );
  const combined = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && !/No local changes to save/i.test(combined)) {
    return { ok: false, error: combined.trim() || `git stash failed (${r.status})` };
  }
  const stashed = r.status === 0 && !/No local changes to save/i.test(combined);
  if (!isCleanWorkingTreeForMerge(projectRoot)) {
    return { ok: false, error: 'working tree still dirty after autostash (excluding worktrees)' };
  }
  return { ok: true, stashed };
}

function popMergeAutostash(projectRoot) {
  const list = git(projectRoot, ['stash', 'list'], { stdio: 'pipe' });
  if (list.status !== 0) return;
  const first = String(list.stdout || '').split('\n').find((l) => l.trim());
  if (!first || !first.includes(MERGE_AUTOSTASH_MESSAGE)) return;
  git(projectRoot, ['stash', 'pop'], { stdio: 'pipe' });
}

function resolveWtPath(projectRoot, worktreePath) {
  if (!worktreePath || !String(worktreePath).trim()) return projectRoot;
  const s = String(worktreePath).trim();
  if (path.isAbsolute(s)) return s;
  return path.join(projectRoot, s);
}

/**
 * @param {string} projectRoot
 * @param {{ branch?: string, worktree_path?: string, feature_id?: string }} wt
 */
function resolveFeatureBranch(projectRoot, wt) {
  const b = wt?.branch != null ? String(wt.branch).trim() : '';
  if (b && b !== 'HEAD') return b;
  const wtPath = resolveWtPath(projectRoot, wt?.worktree_path);
  if (!fs.existsSync(wtPath)) return '';
  const r = git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' });
  if (r.status !== 0) return '';
  const head = String(r.stdout || '').trim();
  if (!head || head === 'HEAD') return '';
  return head;
}

/**
 * 优先 codegen.outputs.worktrees，否则 code_review.inputs.worktrees。
 * @param {object} doc stages.json 根文档
 */
function collectWorktreeRows(doc) {
  const cg = doc.stages?.codegen?.outputs?.worktrees;
  if (Array.isArray(cg) && cg.length > 0) return cg;
  const cr = doc.stages?.code_review?.inputs?.worktrees;
  return Array.isArray(cr) ? cr : [];
}

/**
 * 去重后的待合并 feature 分支列表（不含 target_branch）。
 * @returns {{ branch: string, feature_id: string }[]}
 */
function listFeatureBranchesToMerge(projectRoot, doc, targetBranch) {
  const rows = collectWorktreeRows(doc);
  const out = [];
  const seen = new Set();
  for (const w of rows) {
    const branch = resolveFeatureBranch(projectRoot, w);
    if (!branch || branch === targetBranch) continue;
    if (seen.has(branch)) continue;
    seen.add(branch);
    out.push({ branch, feature_id: String(w?.feature_id || '') });
  }
  return out;
}

function localBranchExists(projectRoot, branch) {
  const r = git(projectRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    stdio: 'pipe',
  });
  return r.status === 0;
}

function conflictFiles(projectRoot) {
  const r = git(projectRoot, ['diff', '--name-only', '--diff-filter=U'], { stdio: 'pipe' });
  if (r.status !== 0) return [];
  return String(r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergeAbort(projectRoot) {
  git(projectRoot, ['merge', '--abort'], { stdio: 'pipe' });
}

/**
 * @returns {{ ok: true, mergeCommit: string } | { ok: false, exit: 1|6, conflictFiles?: string[], stderr?: string }}
 */
function mergeFeatureBranchesIntoTarget(projectRoot, targetBranch, featureBranches) {
  const co = git(projectRoot, ['checkout', targetBranch], { stdio: 'pipe' });
  if (co.status !== 0) {
    return { ok: false, exit: 1, stderr: co.stderr || `checkout ${targetBranch} failed` };
  }

  for (const { branch } of featureBranches) {
    if (!localBranchExists(projectRoot, branch)) {
      return {
        ok: false,
        exit: 1,
        stderr: `feature branch not found locally: ${branch}`,
      };
    }
    const m = git(
      projectRoot,
      ['merge', '--no-ff', branch, '-m', `ai-code3 merge_push: merge ${branch} into ${targetBranch}`],
      { stdio: 'pipe' }
    );
    if (m.status === 0) continue;
    const files = conflictFiles(projectRoot);
    mergeAbort(projectRoot);
    return { ok: false, exit: 6, conflictFiles: files.length ? files : ['(merge failed)'], stderr: m.stderr };
  }

  const h = git(projectRoot, ['rev-parse', 'HEAD'], { stdio: 'pipe' });
  if (h.status !== 0) return { ok: false, exit: 1, stderr: h.stderr || 'rev-parse HEAD failed' };
  return { ok: true, mergeCommit: String(h.stdout || '').trim() };
}

function remoteExists(projectRoot, remote) {
  const r = git(projectRoot, ['remote', 'get-url', remote], { stdio: 'pipe' });
  return r.status === 0;
}

/**
 * 列出两个提交点之间的变更文件（含新增/修改/重命名/删除）。
 * @param {string} projectRoot
 * @param {string} fromRef
 * @param {string} toRef
 * @returns {string[]}
 */
function listChangedPathsBetween(projectRoot, fromRef, toRef) {
  if (!fromRef || !toRef) return [];
  const r = git(projectRoot, ['diff', '--name-only', `${fromRef}..${toRef}`], { stdio: 'pipe' });
  if (r.status !== 0) return [];
  return String(r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @returns {{ ok: true } | { ok: false, stderr?: string }}
 */
function pushTarget(projectRoot, remote, targetBranch) {
  const p = git(projectRoot, ['push', remote, targetBranch], { stdio: 'pipe' });
  if (p.status === 0) return { ok: true };
  return { ok: false, stderr: p.stderr || `git push failed (exit ${p.status})` };
}

/**
 * 每步 checkout / merge 独立超时（对齐 code3.md §15）。
 * @param {number} timeoutMsPerStep
 * @returns {Promise<{ ok: true, mergeCommit: string } | { ok: false, exit: 1|3|6, conflictFiles?: string[], stderr?: string, timedOut?: boolean }>}
 */
async function mergeFeatureBranchesIntoTargetAsync(projectRoot, targetBranch, featureBranches, timeoutMsPerStep) {
  let r = await runWithTimeout('git', ['-C', projectRoot, 'checkout', targetBranch], {
    timeoutMs: timeoutMsPerStep,
  });
  if (r.timedOut) return { ok: false, exit: 3, timedOut: true, stderr: 'checkout timed out' };
  if (r.code !== 0) return { ok: false, exit: 1, stderr: `git checkout ${targetBranch} failed` };

  for (const { branch } of featureBranches) {
    if (!localBranchExists(projectRoot, branch)) {
      return { ok: false, exit: 1, stderr: `feature branch not found locally: ${branch}` };
    }
    r = await runWithTimeout(
      'git',
      [
        '-C',
        projectRoot,
        'merge',
        '--no-ff',
        branch,
        '-m',
        `ai-code3 merge_push: merge ${branch} into ${targetBranch}`,
      ],
      { timeoutMs: timeoutMsPerStep }
    );
    if (r.timedOut) {
      mergeAbort(projectRoot);
      return { ok: false, exit: 3, timedOut: true, stderr: 'merge timed out' };
    }
    if (r.code !== 0) {
      const files = conflictFiles(projectRoot);
      mergeAbort(projectRoot);
      return {
        ok: false,
        exit: 6,
        conflictFiles: files.length ? files : ['(merge failed)'],
      };
    }
  }

  const h = git(projectRoot, ['rev-parse', 'HEAD'], { stdio: 'pipe' });
  if (h.status !== 0) return { ok: false, exit: 1, stderr: h.stderr || 'rev-parse HEAD failed' };
  return { ok: true, mergeCommit: String(h.stdout || '').trim() };
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, stderr?: string, timedOut?: boolean }>}
 */
async function pushTargetAsync(projectRoot, remote, targetBranch, timeoutMs) {
  const r = await runWithTimeout('git', ['-C', projectRoot, 'push', remote, targetBranch], { timeoutMs });
  if (r.timedOut) return { ok: false, stderr: 'git push timed out', timedOut: true };
  if (r.code !== 0) return { ok: false, stderr: `git push exited ${r.code}` };
  return { ok: true };
}

module.exports = {
  git,
  isInsideGitWorkTree,
  isCleanWorkingTree,
  isCleanWorkingTreeForMerge,
  prepareWorkingTreeForMerge,
  popMergeAutostash,
  MERGE_AUTOSTASH_MESSAGE,
  collectWorktreeRows,
  listFeatureBranchesToMerge,
  listChangedPathsBetween,
  mergeFeatureBranchesIntoTarget,
  mergeFeatureBranchesIntoTargetAsync,
  remoteExists,
  pushTarget,
  pushTargetAsync,
  resolveWtPath,
};

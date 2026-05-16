'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function git(cwd, args, stdio = 'pipe') {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio });
}

function sanitizeFeatureId(fid) {
  const s = String(fid || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
  return s || 'default';
}

function branchForFeature(fid) {
  return `v3-fc-${sanitizeFeatureId(fid)}`;
}

function worktreePathForFeature(projectRoot, fid) {
  return path.join(projectRoot, '.pipeline', 'worktrees', `v3-fc-${sanitizeFeatureId(fid)}`);
}

function parseWorktreeList(projectRoot) {
  const r = git(projectRoot, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of String(r.stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur && cur.path) out.push(cur);
      cur = { path: path.resolve(line.slice('worktree '.length).trim()), branch: '' };
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    }
  }
  if (cur && cur.path) out.push(cur);
  return out;
}

function isInsideGitWorkTree(cwd) {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && String(r.stdout || '').trim() === 'true';
}

function currentBranchAt(cwd) {
  const r = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) return '';
  return String(r.stdout || '').trim();
}

function branchExists(projectRoot, branch) {
  return git(projectRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

/**
 * @returns {{ ok: true, worktree_path: string, branch: string, reused: boolean } | { ok: false, error: string }}
 */
function removeWorktreeRegistration(projectRoot, wtPath) {
  if (fs.existsSync(wtPath)) {
    const rm = git(projectRoot, ['worktree', 'remove', '--force', wtPath]);
    if (rm.status !== 0) {
      return { ok: false, error: rm.stderr || `git worktree remove failed for ${wtPath}` };
    }
    return { ok: true };
  }
  git(projectRoot, ['worktree', 'prune']);
  return { ok: true };
}

function ensureFeatureWorktree(projectRoot, featureId, baseBranch) {
  const wtPath = path.resolve(worktreePathForFeature(projectRoot, featureId));
  const branch = branchForFeature(featureId);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  git(projectRoot, ['worktree', 'prune']);

  const list = parseWorktreeList(projectRoot);
  const reg = list.find((e) => e.path === wtPath);
  const wtValid =
    fs.existsSync(wtPath) && isInsideGitWorkTree(wtPath) && currentBranchAt(wtPath) === branch;

  if (reg && reg.branch === branch && wtValid) {
    return { ok: true, worktree_path: wtPath, branch, reused: true };
  }

  // Stale registration (e.g. prunable after git clean): drop and recreate.
  if (reg && !wtValid) {
    const dropped = removeWorktreeRegistration(projectRoot, wtPath);
    if (!dropped.ok) return dropped;
  }

  if (fs.existsSync(wtPath)) {
    if (wtValid) {
      return { ok: true, worktree_path: wtPath, branch, reused: true };
    }
    if (process.env.AI_CODE3_CODEGEN_RESET_WORKTREE === 'yes') {
      const dropped = removeWorktreeRegistration(projectRoot, wtPath);
      if (!dropped.ok) return dropped;
      try {
        if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
      } catch (e) {
        return { ok: false, error: `cannot remove ${wtPath}: ${e.message}` };
      }
    } else {
      return {
        ok: false,
        error: `path ${wtPath} exists and is not a matching worktree (set AI_CODE3_CODEGEN_RESET_WORKTREE=yes)`,
      };
    }
  }

  const base = baseBranch || 'main';
  let r;
  if (branchExists(projectRoot, branch)) {
    r = git(projectRoot, ['worktree', 'add', wtPath, branch]);
  } else {
    r = git(projectRoot, ['worktree', 'add', '-b', branch, wtPath, base]);
  }
  if (r.status !== 0) {
    return { ok: false, error: r.stderr || `git worktree add failed (${r.status})` };
  }
  return { ok: true, worktree_path: wtPath, branch, reused: false };
}

/**
 * @returns {{ ok: true, rows: { feature_id: string, branch: string, worktree_path: string }[] } | { ok: false, error: string }}
 */
function ensureAllFeatureWorktrees(projectRoot, featureIds, baseBranch) {
  const rows = [];
  for (const fid of featureIds) {
    const one = ensureFeatureWorktree(projectRoot, fid, baseBranch);
    if (!one.ok) return { ok: false, error: one.error };
    rows.push({
      feature_id: String(fid),
      branch: one.branch,
      worktree_path: one.worktree_path,
    });
  }
  return { ok: true, rows };
}

module.exports = {
  sanitizeFeatureId,
  branchForFeature,
  worktreePathForFeature,
  ensureFeatureWorktree,
  ensureAllFeatureWorktrees,
  parseWorktreeList,
};

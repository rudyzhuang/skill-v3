'use strict';

/**
 * 业务项目 Git 作用域：当 --project 位于更大 monorepo 内时，确保项目根有独立 .git，
 * 避免 codegen worktree 检出父仓整棵树、把 src/ scripts/ 写到仓库根目录。
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const gitSync = require('../../../ai-auto3/scripts/lib/git-pipeline-sync.cjs');

function git(projectRoot, args) {
  return spawnSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'ai-pipeline',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'ai-pipeline@local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'ai-pipeline',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'ai-pipeline@local',
    },
  });
}

/** @returns {string|null} 绝对路径；非 git 目录返回 null */
function getGitTopLevel(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) return null;
  const top = String(r.stdout || '').trim();
  return top ? path.resolve(top) : null;
}

function hasProjectDotGit(projectRoot) {
  const dotGit = path.join(projectRoot, '.git');
  return fs.existsSync(dotGit);
}

function isProjectGitRoot(projectRoot) {
  const top = getGitTopLevel(projectRoot);
  return top !== null && path.resolve(top) === path.resolve(projectRoot);
}

function isNestedInParentRepo(projectRoot) {
  if (!hasProjectDotGit(projectRoot)) {
    const top = getGitTopLevel(projectRoot);
    return top !== null && path.resolve(top) !== path.resolve(projectRoot);
  }
  return false;
}

/**
 * 在业务项目根初始化独立仓库（父仓 worktree 内也可嵌套 init）。
 * @returns {{ ok: boolean, action?: string, reason?: string, defaultBranch?: string }}
 */
function initProjectGitRepo(projectRoot, config = {}) {
  const gitCfg = config.git || {};
  const defaultBranch = gitCfg.default_branch || 'main';

  if (hasProjectDotGit(projectRoot) && isProjectGitRoot(projectRoot)) {
    return { ok: true, action: 'existing' };
  }

  const init = git(projectRoot, ['-c', 'init.templateDir=', 'init', '-b', defaultBranch]);
  if (init.status !== 0) {
    return { ok: false, reason: init.stderr || 'git_init_failed' };
  }

  gitSync.mergeGitignoreFromTemplate(projectRoot);
  gitSync.ensureInputsDir(projectRoot);

  const head = git(projectRoot, ['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) {
    git(projectRoot, ['add', '-A']);
    const st = git(projectRoot, ['status', '--porcelain']);
    if (st.status === 0 && String(st.stdout || '').trim()) {
      const commit = git(projectRoot, [
        'commit', '-m', 'chore(setup): initialize business project repository',
      ]);
      if (commit.status !== 0) {
        return { ok: false, reason: commit.stderr || 'initial_commit_failed' };
      }
    }
  }

  const remoteUrl = String(gitCfg.remote_url || gitCfg.repo_url || '').trim();
  if (remoteUrl) {
    const remoteName = gitCfg.remote || 'origin';
    const remotes = git(projectRoot, ['remote']);
    const names = String(remotes.stdout || '').split(/\s+/).filter(Boolean);
    if (!names.includes(remoteName)) {
      git(projectRoot, ['remote', 'add', remoteName, remoteUrl]);
    } else {
      git(projectRoot, ['remote', 'set-url', remoteName, remoteUrl]);
    }
  }

  return { ok: true, action: 'init_nested', defaultBranch };
}

/**
 * setup / codegen 入口：父仓子目录 → 嵌套 init；已是项目 git 根 → 跳过。
 */
function ensureProjectGitRepo(projectRoot, opts = {}) {
  const config = opts.config || {};
  const log = opts.log;

  if (isProjectGitRoot(projectRoot)) {
    return { ok: true, action: 'existing', nested: false };
  }

  if (isNestedInParentRepo(projectRoot) || !hasProjectDotGit(projectRoot)) {
    const parentTop = getGitTopLevel(projectRoot);
    const nested = parentTop && path.resolve(parentTop) !== path.resolve(projectRoot);

    if (nested) {
      reconcileMisscopedWorktrees(projectRoot, { log, parentGitRoot: parentTop });
    }

    const init = initProjectGitRepo(projectRoot, config);
    if (!init.ok) return init;

    if (log) {
      log.info('file_created', nested
        ? `业务项目位于父仓 ${parentTop} 内，已初始化独立 git 仓库`
        : '已初始化业务项目 git 仓库', {
        project: projectRoot,
        parent_git_root: nested ? parentTop : null,
        action: init.action,
      });
    }
    return { ...init, nested: Boolean(nested) };
  }

  return { ok: true, action: 'unknown', nested: false };
}

/**
 * 移除挂在父仓上的误 scope worktree（toplevel !== projectRoot）。
 */
function reconcileMisscopedWorktrees(projectRoot, opts = {}) {
  const log = opts.log;
  const worktreesDir = path.join(projectRoot, '.pipeline', 'worktrees');
  if (!fs.existsSync(worktreesDir)) return { removed: [] };

  const parentGitRoot = opts.parentGitRoot || (() => {
    const top = getGitTopLevel(projectRoot);
    if (top && path.resolve(top) !== path.resolve(projectRoot)) return top;
    return null;
  })();

  const removed = [];
  for (const name of fs.readdirSync(worktreesDir)) {
    const wtPath = path.join(worktreesDir, name);
    let st;
    try { st = fs.statSync(wtPath); } catch (_) { continue; }
    if (!st.isDirectory()) continue;

    const wtTop = getGitTopLevel(wtPath);
    if (!wtTop || path.resolve(wtTop) === path.resolve(projectRoot)) continue;

    try {
      execSync(`git worktree remove --force ${JSON.stringify(wtPath)}`, {
        cwd: wtTop,
        stdio: 'pipe',
      });
    } catch (_) {
      try {
        fs.rmSync(wtPath, { recursive: true, force: true });
      } catch (e2) {
        if (log) {
          log.warn('stage_failed', `无法移除误 scope worktree: ${wtPath}`, {
            error: e2.message, worktree_path: wtPath, git_root: wtTop,
          });
        }
        continue;
      }
    }
    removed.push(wtPath);
    if (log) {
      log.warn('file_updated', `已移除挂在父仓的误 scope worktree`, {
        worktree_path: wtPath,
        parent_git_root: parentGitRoot || wtTop,
        project: projectRoot,
      });
    }
  }
  return { removed };
}

module.exports = {
  getGitTopLevel,
  hasProjectDotGit,
  isProjectGitRoot,
  isNestedInParentRepo,
  initProjectGitRepo,
  ensureProjectGitRepo,
  reconcileMisscopedWorktrees,
};

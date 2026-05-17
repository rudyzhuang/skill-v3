'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** @see docs/input-spec.md §3.5 — prd_start 使用全仓 add -A，不在此表 */
const STAGE_TRACKED_PATHS = {
  prd_complete: ['inputs/', 'docs/', '.pipeline/'],
  prd_review: ['inputs/', 'docs/', '.pipeline/'],
  design: ['inputs/', 'docs/', '.pipeline/'],
  contract: ['inputs/', 'docs/', '.pipeline/'],
  design_review: ['inputs/', 'docs/', '.pipeline/'],
  codegen: ['inputs/', 'docs/', '.pipeline/', 'src/'],
  typecheck: ['inputs/', 'docs/', '.pipeline/', 'src/'],
  test: ['inputs/', 'docs/', '.pipeline/', 'src/'],
  code_review: ['inputs/', 'docs/', '.pipeline/', 'src/'],
  merge_push: ['inputs/', 'docs/', '.pipeline/', 'src/'],
};

const GITIGNORE_MARKER = '# Skill V3 业务项目默认 .gitignore';

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

function loadConfigDev(projectRoot) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function isInsideWorkTree(projectRoot) {
  const r = git(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && String(r.stdout || '').trim() === 'true';
}

function resolveSkillsGitignoreTemplate() {
  const candidates = [
    path.join(__dirname, '../../../docs/templates/.gitignore.template'),
    path.join(__dirname, '../../docs/templates/.gitignore.template'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function mergeGitignoreFromTemplate(projectRoot) {
  const tplPath = resolveSkillsGitignoreTemplate();
  const dest = path.join(projectRoot, '.gitignore');
  if (!tplPath) return { ok: true, merged: false, reason: 'no_template' };
  const tpl = fs.readFileSync(tplPath, 'utf8');
  if (fs.existsSync(dest)) {
    const cur = fs.readFileSync(dest, 'utf8');
    if (cur.includes(GITIGNORE_MARKER) || cur.includes('.agent-sessions/')) {
      return { ok: true, merged: false, reason: 'already_present' };
    }
    fs.writeFileSync(dest, `${cur.trimEnd()}\n\n${tpl}\n`, 'utf8');
    return { ok: true, merged: true, reason: 'appended' };
  }
  fs.writeFileSync(dest, `${tpl}\n`, 'utf8');
  return { ok: true, merged: true, reason: 'created' };
}

function ensureInputsDir(projectRoot) {
  const inputsDir = path.join(projectRoot, 'inputs');
  if (!fs.existsSync(inputsDir)) {
    fs.mkdirSync(inputsDir, { recursive: true });
    const readme = path.join(inputsDir, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        '# inputs\n\nPlace raw requirements here (e.g. `req.md`). Committed at prd bootstrap start.\n',
        'utf8'
      );
    }
  }
}

/**
 * 初始化本地仓库 + 配置默认分支；若 config 含 remote URL 则添加 origin。
 */
function initLocalAndRemote(projectRoot, config = {}) {
  const gitCfg = config.git || {};
  const defaultBranch = gitCfg.default_branch || 'main';
  const remoteName = gitCfg.remote || 'origin';
  const remoteUrl = String(gitCfg.remote_url || gitCfg.repo_url || '').trim();

  if (!isInsideWorkTree(projectRoot)) {
    const init = git(projectRoot, ['-c', 'init.templateDir=', 'init', '-b', defaultBranch]);
    if (init.status !== 0) {
      return { ok: false, reason: init.stderr || 'git_init_failed' };
    }
  }

  const head = git(projectRoot, ['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) {
    git(projectRoot, ['checkout', '-B', defaultBranch]);
  }

  if (remoteUrl) {
    const remotes = git(projectRoot, ['remote']);
    const has = String(remotes.stdout || '')
      .split(/\s+/)
      .filter(Boolean)
      .includes(remoteName);
    if (!has) {
      const add = git(projectRoot, ['remote', 'add', remoteName, remoteUrl]);
      if (add.status !== 0) {
        return { ok: false, reason: add.stderr || 'git_remote_add_failed' };
      }
    } else {
      git(projectRoot, ['remote', 'set-url', remoteName, remoteUrl]);
    }
  }

  return { ok: true, defaultBranch, remoteName, remoteConfigured: Boolean(remoteUrl) };
}

function pathsExist(projectRoot, relPaths) {
  return relPaths.filter((rel) => {
    const abs = path.join(projectRoot, rel);
    return fs.existsSync(abs);
  });
}

function commitTrackedPaths(projectRoot, relPaths, message) {
  const existing = pathsExist(projectRoot, relPaths);
  if (existing.length === 0) {
    return { ok: true, committed: false, reason: 'no_paths' };
  }
  const add = git(projectRoot, ['add', '-A', '--', ...existing]);
  if (add.status !== 0) {
    return { ok: false, reason: add.stderr || 'git_add_failed' };
  }
  const st = git(projectRoot, ['status', '--porcelain', '--', ...existing]);
  if (st.status !== 0) {
    return { ok: false, reason: st.stderr || 'git_status_failed' };
  }
  if (!String(st.stdout || '').trim()) {
    return { ok: true, committed: false, reason: 'clean' };
  }
  const commit = git(projectRoot, ['commit', '-m', message]);
  if (commit.status !== 0) {
    return { ok: false, reason: commit.stderr || 'git_commit_failed' };
  }
  const rev = git(projectRoot, ['rev-parse', 'HEAD']);
  const sha = rev.status === 0 ? String(rev.stdout || '').trim() : '';
  return { ok: true, committed: true, commit: sha };
}

/** prd bootstrap：项目根下全部文件入仓（受 .gitignore 约束，非仅 inputs/） */
function commitAllTracked(projectRoot, message) {
  const add = git(projectRoot, ['add', '-A']);
  if (add.status !== 0) {
    return { ok: false, reason: add.stderr || 'git_add_failed' };
  }
  const st = git(projectRoot, ['status', '--porcelain']);
  if (st.status !== 0) {
    return { ok: false, reason: st.stderr || 'git_status_failed' };
  }
  if (!String(st.stdout || '').trim()) {
    return { ok: true, committed: false, reason: 'clean' };
  }
  const commit = git(projectRoot, ['commit', '-m', message]);
  if (commit.status !== 0) {
    return { ok: false, reason: commit.stderr || 'git_commit_failed' };
  }
  const rev = git(projectRoot, ['rev-parse', 'HEAD']);
  const sha = rev.status === 0 ? String(rev.stdout || '').trim() : '';
  return { ok: true, committed: true, commit: sha };
}

function pushIfAllowed(projectRoot, config = {}) {
  const gitCfg = config.git || {};
  if (gitCfg.allow_push !== true) {
    return { ok: true, pushed: false, push_status: 'not_requested' };
  }
  const remote = gitCfg.remote || 'origin';
  const branch = gitCfg.default_branch || 'main';
  const remotes = git(projectRoot, ['remote']);
  if (remotes.status !== 0 || !String(remotes.stdout || '').includes(remote)) {
    return {
      ok: true,
      pushed: false,
      push_status: 'not_requested',
      reason: 'no_remote_configured',
    };
  }
  const push = git(projectRoot, ['push', '-u', remote, branch]);
  if (push.status !== 0) {
    return { ok: false, push_status: 'failed', reason: push.stderr || 'git_push_failed' };
  }
  return { ok: true, pushed: true, push_status: 'pushed' };
}

/**
 * @param {string} projectRoot
 * @param {'prd_start'|'prd_complete'|string} phaseKey
 * @param {{ featureId?: string, message?: string, config?: object }} opts
 */
function syncPipelineGit(projectRoot, phaseKey, opts = {}) {
  const config = opts.config || loadConfigDev(projectRoot);
  const relPaths = STAGE_TRACKED_PATHS[phaseKey];
  const isPrdStart = phaseKey === 'prd_start';
  if (!isPrdStart && !relPaths) {
    return { ok: false, reason: `unknown_phase:${phaseKey}` };
  }
  if (!isInsideWorkTree(projectRoot)) {
    return { ok: false, reason: 'not_a_git_repo', hint: 'run prd bootstrap first' };
  }
  const fid = opts.featureId ? String(opts.featureId) : '';
  const stagePart = phaseKey.replace(/_/g, '-');
  const msg =
    opts.message ||
    (fid
      ? `chore(pipeline): ${stagePart} feature ${fid}`
      : `chore(pipeline): ${stagePart}`);
  const commit = isPrdStart
    ? commitAllTracked(projectRoot, msg)
    : commitTrackedPaths(projectRoot, relPaths, msg);
  if (!commit.ok) return commit;
  const push = pushIfAllowed(projectRoot, config);
  return {
    ok: push.ok,
    phase: phaseKey,
    paths: isPrdStart ? ['(project root, git add -A)'] : relPaths,
    scope: isPrdStart ? 'entire_worktree' : 'paths',
    commit: commit.commit || null,
    committed: commit.committed,
    push_status: push.push_status || (push.pushed ? 'pushed' : 'not_requested'),
    push_error: push.reason || null,
  };
}

function syncAfterFeature(projectRoot, stageKey, featureId, opts = {}) {
  const map = {
    prd_review: 'prd_review',
    design: 'design',
    contract: 'contract',
    design_review: 'design_review',
    codegen: 'codegen',
    typecheck: 'typecheck',
    test: 'test',
    code_review: 'code_review',
    merge_push: 'merge_push',
  };
  const phase = map[stageKey];
  if (!phase) return { ok: true, skipped: true, reason: 'stage_not_configured' };
  return syncPipelineGit(projectRoot, phase, { ...opts, featureId });
}

module.exports = {
  STAGE_TRACKED_PATHS,
  initLocalAndRemote,
  mergeGitignoreFromTemplate,
  ensureInputsDir,
  commitAllTracked,
  syncPipelineGit,
  syncAfterFeature,
  isInsideWorkTree,
  loadConfigDev,
};

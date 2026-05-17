'use strict';

const fs = require('fs');
const path = require('path');

/** ai-code3 非 feature 工具链落盘目录（相对业务项目根） */
function pipelineAiCode3Dir(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'ai-code3');
}

function packageJsonPath(projectRoot) {
  return path.join(pipelineAiCode3Dir(projectRoot), 'package.json');
}

function hasToolingPackageJson(projectRoot) {
  return fs.existsSync(packageJsonPath(projectRoot));
}

/** 业务仓根或任一 worktree 是否仍有旧版根级 package.json（迁移前兼容） */
function hasLegacyRootPackageJson(projectRoot, worktreePaths = []) {
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) return true;
  for (const wt of worktreePaths) {
    if (wt && fs.existsSync(path.join(wt, 'package.json'))) return true;
  }
  return false;
}

function defaultNpmBuildCommand(projectRoot) {
  if (hasToolingPackageJson(projectRoot)) {
    const rel = path.relative(projectRoot, pipelineAiCode3Dir(projectRoot));
    return `npm run build --prefix ${rel.split(path.sep).join('/')}`;
  }
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) {
    return 'npm run build --if-present';
  }
  return '';
}

/**
 * worktree 内健康测试脚本（不依赖 worktree 根 package.json）
 * @param {string} worktreePath
 */
function healthTestCommandForWorktree(worktreePath) {
  const rel = path.join('src', 'backend', 'tests', 'health.test.cjs');
  const abs = path.join(worktreePath, rel);
  if (fs.existsSync(abs)) return `node ${rel}`;
  return '';
}

function resolveDefaultTestCommand(projectRoot, targets) {
  for (const row of targets) {
    const direct = healthTestCommandForWorktree(row.worktree_path);
    if (direct) return direct;
  }
  if (hasToolingPackageJson(projectRoot)) return 'npm test --if-present';
  const wts = targets.map((t) => t.worktree_path);
  if (hasLegacyRootPackageJson(projectRoot, wts)) return 'npm test --if-present';
  return '';
}

function worktreeHasRunnableTests(projectRoot, targets) {
  if (resolveDefaultTestCommand(projectRoot, targets)) return true;
  return (
    hasToolingPackageJson(projectRoot) ||
    hasLegacyRootPackageJson(
      projectRoot,
      targets.map((t) => t.worktree_path)
    )
  );
}

/**
 * health build 脚本读取的 feature 源码根（优先 codegen worktree，其次已合并的 projectRoot/src）
 * @param {object} doc stages.json
 * @param {string} projectRoot
 */
function resolveBuildWorktreeRoot(doc, projectRoot) {
  const rows = doc?.stages?.codegen?.outputs?.worktrees || [];
  for (const row of rows) {
    const raw = String(row?.worktree_path || '').trim();
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? raw : path.join(projectRoot, raw);
    if (fs.existsSync(path.join(abs, 'src'))) return abs;
  }
  if (fs.existsSync(path.join(projectRoot, 'src'))) return projectRoot;
  return projectRoot;
}

function buildCommandEnv(doc, projectRoot) {
  const wtRoot = resolveBuildWorktreeRoot(doc, projectRoot);
  const base = { AI_CODE3_PROJECT_ROOT: projectRoot, AI_CODE3_WORKTREE_ROOT: wtRoot };
  if (!hasToolingPackageJson(projectRoot)) return base;
  return base;
}

module.exports = {
  pipelineAiCode3Dir,
  packageJsonPath,
  hasToolingPackageJson,
  hasLegacyRootPackageJson,
  defaultNpmBuildCommand,
  healthTestCommandForWorktree,
  resolveDefaultTestCommand,
  worktreeHasRunnableTests,
  resolveBuildWorktreeRoot,
  buildCommandEnv,
};

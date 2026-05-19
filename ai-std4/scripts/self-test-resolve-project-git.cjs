'use strict';

/**
 * resolve-project-git 确定性自测
 *   node ai-std4/scripts/self-test-resolve-project-git.cjs
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  getGitTopLevel,
  isProjectGitRoot,
  ensureProjectGitRepo,
} = require('./libs/resolve-project-git.cjs');

function normalizeGitPath(p) {
  return path.resolve(String(p || ''));
}
const { createPipelinePaths } = require('./libs/pipeline-paths.cjs');

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`OK: ${msg}`);
  }
}

const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-parent-'));
const projectRoot = path.join(tmpParent, 'biz-app');

try {
  execSync('git init -b main', { cwd: tmpParent, stdio: 'ignore' });
  fs.writeFileSync(path.join(tmpParent, 'README.md'), '# parent\n');
  execSync('git add README.md && git commit -m "init parent"', { cwd: tmpParent, stdio: 'ignore' });
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'inputs'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'inputs', 'req.md'), '# test\n', 'utf8');
  fs.writeFileSync(
    path.join(projectRoot, 'docs', 'config.dev.json'),
    JSON.stringify({ git: { default_branch: 'main' } }, null, 2),
  );

  const parentTop = getGitTopLevel(projectRoot);
  assert(parentTop === normalizeGitPath(tmpParent), 'nested project resolves to parent toplevel before init');

  const paths = createPipelinePaths(projectRoot);
  const wtDir = path.join(paths.worktreesDir, 'v3-TEST-001');
  fs.mkdirSync(wtDir, { recursive: true });
  execSync(`git worktree add -b features/v3-TEST-001 ${JSON.stringify(wtDir)} HEAD`, {
    cwd: tmpParent,
    stdio: 'pipe',
  });
  const wtTop = getGitTopLevel(wtDir);
  assert(wtTop && wtTop !== normalizeGitPath(projectRoot), 'misscoped worktree is not scoped to project root');

  const init = ensureProjectGitRepo(projectRoot, { config: { git: { default_branch: 'main' } } });
  assert(init.ok, 'ensureProjectGitRepo ok');
  assert(isProjectGitRoot(projectRoot), 'after init, project is its own git root');
  assert(!fs.existsSync(wtDir), 'misscoped worktree removed during ensure');
} finally {
  fs.rmSync(tmpParent, { recursive: true, force: true });
}

if (failed > 0) {
  process.exit(1);
}
console.log(`\nAll ${failed === 0 ? 'tests' : ''} passed.`);

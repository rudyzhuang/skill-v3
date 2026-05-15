'use strict';

/**
 * 将临时目录初始化为 git 仓库并提交基线（供 codegen diff-guard）。
 * 使用 `git -c user.name=...` 单次传参，不写全局/本地 git config。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const skillRoot = path.join(__dirname, '..');
const fixtureDir = path.join(skillRoot, 'fixtures', 'smoke-project');
const runScript = path.join(skillRoot, 'scripts', 'run.cjs');

function runNode(args) {
  const r = spawnSync(process.execPath, [runScript, ...args], {
    stdio: 'inherit',
    cwd: skillRoot,
    env: process.env,
  });
  return r.status ?? 1;
}

function git(tmp, args) {
  const r = spawnSync('git', ['-C', tmp, ...args], { stdio: 'inherit' });
  return r.status ?? 1;
}

function main() {
  if (!fs.existsSync(fixtureDir)) {
    console.error('missing fixture', fixtureDir);
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-code3-smoke-'));
  fs.cpSync(fixtureDir, tmp, { recursive: true });

  if (git(tmp, ['init']) !== 0) process.exit(1);
  if (git(tmp, ['add', '-A']) !== 0) process.exit(1);
  if (
    git(tmp, [
      '-c',
      'user.name=ai-code3-smoke',
      '-c',
      'user.email=ai-code3-smoke@local.test',
      'commit',
      '-m',
      'smoke baseline',
    ]) !== 0
  ) {
    process.exit(1);
  }

  const proj = `--project=${tmp}`;
  if (runNode(['preflight', proj]) !== 0) process.exit(1);
  if (runNode(['all', '--stub-remaining', proj]) !== 0) process.exit(1);

  console.error(`smoke OK (fixture copy at ${tmp})`);
}

main();

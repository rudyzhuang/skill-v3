'use strict';

/**
 * P10：验证 **clean.cjs** 能移除 **v3-fc-*** worktree（须 **AI_CODE3_CLEAN_CONFIRM**）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const skillRoot = path.join(__dirname, '..');
const cleanScript = path.join(skillRoot, 'scripts', 'clean.cjs');

function git(tmp, args) {
  const r = spawnSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
  return r.status ?? 1;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-code3-clean-'));
  if (git(tmp, ['init']) !== 0) throw new Error('git init failed');
  fs.writeFileSync(path.join(tmp, 'README.md'), 'x\n', 'utf8');
  if (git(tmp, ['add', '-A']) !== 0) throw new Error('git add failed');
  if (
    git(tmp, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-m',
      'init',
    ]) !== 0
  ) {
    throw new Error('git commit failed');
  }
  const wt = path.join(tmp, '.pipeline', 'worktrees', 'v3-fc-smoke');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  if (git(tmp, ['worktree', 'add', '-b', 'v3-fc-smoke', wt, 'HEAD']) !== 0) {
    throw new Error('git worktree add failed');
  }
  if (!fs.existsSync(wt)) throw new Error('worktree path missing');

  const r = spawnSync(
    process.execPath,
    [cleanScript, `--project=${tmp}`],
    {
      cwd: skillRoot,
      encoding: 'utf8',
      env: { ...process.env, AI_CODE3_CLEAN_CONFIRM: 'yes' },
    }
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || 'clean exit non-zero');
    process.exit(1);
  }
  if (fs.existsSync(wt)) {
    console.error('worktree dir still exists after clean');
    process.exit(1);
  }
  const list = spawnSync('git', ['-C', tmp, 'worktree', 'list'], { encoding: 'utf8' });
  if ((list.stdout || '').includes('v3-fc-smoke')) {
    console.error('worktree still listed');
    process.exit(1);
  }
  console.error('ai-code3 self-test-clean: ok');
}

main();

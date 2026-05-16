'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { skillRoot } = require('./lib/paths.cjs');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function runRound(label) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ai-e2e3-smoke-'));
  const fixture = path.join(skillRoot(), 'test-fixtures', 'minimal');
  copyDir(fixture, tmp);
  process.env.AI_E2E3_SKIP_AGENT = '1';
  const r = spawnSync(process.execPath, [path.join(skillRoot(), 'scripts', 'run.cjs'), `--project=${tmp}`], {
    encoding: 'utf8',
    timeout: 120000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) {
    console.error(`${label} failed exit=${r.status}\n${out}`);
    return false;
  }
  const st = JSON.parse(fs.readFileSync(path.join(tmp, '.pipeline', 'stages.json'), 'utf8'));
  if (st.stages?.ui_e2e?.status !== 'completed' || !st.stages?.ui_e2e?.validation?.passed) {
    console.error(`${label} ui_e2e not passed:`, JSON.stringify(st.stages?.ui_e2e, null, 2));
    return false;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return true;
}

function main() {
  const skill = skillRoot();
  const npm = spawnSync('npm', ['ci'], { cwd: skill, encoding: 'utf8', stdio: 'pipe' });
  if (npm.status !== 0) {
    console.error('npm ci failed:', npm.stderr);
    process.exit(1);
  }
  if (!runRound('round-1') || !runRound('round-2')) {
    process.exit(1);
  }
  console.error('smoke: all passed');
  process.exit(0);
}

main();

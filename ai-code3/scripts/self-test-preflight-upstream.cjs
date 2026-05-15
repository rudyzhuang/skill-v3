'use strict';

/**
 * P10：**preflight** 在 **AI_CODE3_PREFLIGHT_UPSTREAM_GATES=yes** 时须检出 **§7.2** 门闸失败。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const skillRoot = path.join(__dirname, '..');
const fixtureStages = path.join(skillRoot, 'fixtures', 'smoke-project', '.pipeline', 'stages.json');
const fixtureConfig = path.join(skillRoot, 'fixtures', 'smoke-project', 'docs', 'config.dev.json');
const preflightScript = path.join(skillRoot, 'scripts', 'preflight.cjs');

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-code3-pf-up-'));
  fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.pipeline'), { recursive: true });
  fs.copyFileSync(fixtureConfig, path.join(tmp, 'docs', 'config.dev.json'));

  const doc = JSON.parse(fs.readFileSync(fixtureStages, 'utf8'));
  doc.stages.design_review.outputs.decision = 'pending';
  fs.writeFileSync(path.join(tmp, '.pipeline', 'stages.json'), JSON.stringify(doc, null, 2), 'utf8');

  const r = spawnSync(
    process.execPath,
    [preflightScript, `--project=${tmp}`],
    {
      cwd: skillRoot,
      encoding: 'utf8',
      env: { ...process.env, AI_CODE3_PREFLIGHT_UPSTREAM_GATES: 'yes' },
    }
  );
  if (r.status === 0) {
    console.error('expected preflight to fail when upstream gates fail');
    process.exit(1);
  }
  const err = `${r.stderr || ''}${r.stdout || ''}`;
  if (!err.includes('codegen_upstream_gate') && !err.includes('codegen blocked')) {
    console.error('expected stderr to mention codegen upstream gate, got:', err);
    process.exit(1);
  }
  console.error('ai-code3 self-test-preflight-upstream: ok');
}

main();

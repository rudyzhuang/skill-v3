#!/usr/bin/env node
'use strict';

/**
 * ai-dash3 smoke — 连续跑两轮（dash3.md §9）
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN = path.join(__dirname, 'run.cjs');
const FIXTURE = path.resolve(__dirname, '..', '..', 'ai-code3', 'fixtures', 'smoke-project');

function runRound(label) {
  if (!fs.existsSync(FIXTURE)) {
    console.error('smoke: missing fixture', FIXTURE);
    process.exit(1);
  }
  const tmpMd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dash3-smoke-')), 'dash.md');
  const cmds = [
    ['status', `--project=${FIXTURE}`],
    ['json', `--project=${FIXTURE}`],
    ['write-md', `--project=${FIXTURE}`, `--out=${tmpMd}`],
  ];
  for (const extra of cmds) {
    const r = spawnSync(process.execPath, [RUN, ...extra], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`smoke [${label}] failed:`, extra.join(' '), r.stderr || r.stdout);
      process.exit(1);
    }
    if (extra[0] === 'json') {
      const line = (r.stdout || '').trim();
      const o = JSON.parse(line);
      if (o.schema !== 'ai-dash3.summary.v1') {
        console.error('smoke: bad schema', o.schema);
        process.exit(1);
      }
      if (!Array.isArray(o.rows) || o.rows.length !== 14) {
        console.error('smoke: rows length', o.rows && o.rows.length);
        process.exit(1);
      }
    }
  }
  if (!fs.existsSync(tmpMd)) {
    console.error('smoke: missing', tmpMd);
    process.exit(1);
  }
}

for (let i = 1; i <= 2; i++) {
  runRound(`round-${i}`);
}
console.log('smoke: all passed (2 rounds)');

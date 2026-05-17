#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseActiveSessionsByFeature,
  resolveFeatureLog,
  buildInProgressFeatureLogs,
} = require('./lib/feature-logs.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dash3-flogs-'));
const sessionsRoot = path.join(root, '.agent-sessions', 'logs', 'sessions');
fs.mkdirSync(sessionsRoot, { recursive: true });

const autorunLog = path.join(sessionsRoot, 'sess-autorun.log');
fs.writeFileSync(
  autorunLog,
  [
    '2026-01-01T00:00:00.000Z autorun begin',
    '[ai-auto3] code3 codegen group 1/1 begin feature=F-X session=sess-codegen-x',
    '2026-01-01T00:01:00.000Z tail',
  ].join('\n'),
  'utf8'
);

const featureLogDir = path.join(root, '.agent-sessions', 'logs', 'features');
fs.mkdirSync(featureLogDir, { recursive: true });
fs.writeFileSync(
  path.join(featureLogDir, 'F-X.log'),
  ['2026-01-01T00:00:10.000Z alive: stage=codegen', '2026-01-01T00:00:40.000Z codegen running'].join('\n'),
  'utf8'
);

const active = parseActiveSessionsByFeature(autorunLog);
assert(active.get('F-X')?.session_id === 'sess-codegen-x', 'expected active session for F-X');

const log = resolveFeatureLog(root, 'F-X');
assert(log.source === 'feature', `expected feature source, got ${log.source}`);
assert(log.lines.length >= 2, 'expected tail lines');
assert(log.log_path.includes('logs/features/F-X.log'), 'expected feature log path');

const boardLogs = buildInProgressFeatureLogs(root, [
  { feature_id: 'F-X', feature_status: 'in_progress', current_stage_label: 'codegen' },
  { feature_id: 'F-Y', feature_status: 'pending' },
]);
assert(boardLogs.length === 1, `expected 1 in_progress log entry, got ${boardLogs.length}`);
assert(boardLogs[0].feature_id === 'F-X', 'expected F-X log');

console.log('ai-dash3 self-test-feature-logs: ok');

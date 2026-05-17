#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const agentLog = require('./agent-sessions-log.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-log-'));
const sessionId = 'sess-a';
const featureA = 'F-ONE';
const featureB = 'F-TWO';

agentLog.appendAgentLog(root, {
  sessionId,
  stageKey: 'codegen',
  featureIds: [featureA, featureB],
  skill: 'test',
  message: 'multi-sink line',
});

const sessionPath = agentLog.sessionLogPath(root, sessionId);
const stagePath = agentLog.stageLogPath(root, 'codegen');
const featAPath = agentLog.featureLogPath(root, featureA);
const featBPath = agentLog.featureLogPath(root, featureB);

assert(fs.existsSync(sessionPath), 'session log missing');
assert(fs.existsSync(stagePath), 'stage log missing');
assert(fs.existsSync(featAPath), 'feature A log missing');
assert(fs.existsSync(featBPath), 'feature B log missing');

const sessionText = fs.readFileSync(sessionPath, 'utf8');
assert(sessionText.includes('multi-sink line'), 'session log content');
assert(fs.readFileSync(stagePath, 'utf8').includes('multi-sink line'), 'stage log content');
assert(fs.readFileSync(featAPath, 'utf8').includes('multi-sink line'), 'feature A log content');

agentLog.appendHeartbeat(root, sessionId, 'test', 'tick', { featureIds: [featureA], stderrTag: 'selftest' });
assert(fs.readFileSync(sessionPath, 'utf8').includes('alive: stage=test'), 'heartbeat in session log');

const resolved = agentLog.resolveSessionLogPath(root, sessionId);
assert(resolved === sessionPath, 'resolveSessionLogPath should prefer logs/sessions');

console.log('self-test-agent-sessions-log: OK');

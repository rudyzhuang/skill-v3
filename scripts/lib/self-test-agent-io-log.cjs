#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const agentIo = require('./agent-io-log.cjs');
const agentLog = require('./agent-sessions-log.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-io-log-'));
const sessionId = 'sess-io';
process.env.AI_SESSION_ID = sessionId;

const ref = agentIo.promptRef({
  skill: 'ai-code3',
  relPath: 'scripts/lib/invoke-ai-code3-agent.cjs',
  symbol: 'buildCursorAgentPrompt',
});
assert(ref.includes('@skill/ai-code3'), 'promptRef format');

const { callId } = agentIo.logAgentIo(root, 'begin', {
  skill: 'ai-code3',
  stageKey: 'codegen',
  phase: 'impl',
  featureId: 'F-1',
  promptRef: ref,
  promptSha: agentIo.sha256Short('hello'),
  promptDynamic: 'feature_id=F-1',
});

agentIo.logAgentIo(root, 'end', {
  skill: 'ai-code3',
  stageKey: 'codegen',
  callId,
  phase: 'impl',
  featureId: 'F-1',
  ok: true,
  exitCode: 0,
  elapsedMs: 12,
  stdout: 'done\n',
});

const logPath = agentLog.sessionLogPath(root, sessionId);
const text = fs.readFileSync(logPath, 'utf8');
assert(text.includes('agent_io.begin'), 'begin event');
assert(text.includes('prompt_ref='), 'prompt ref');
assert(text.includes('agent_io.end'), 'end event');
assert(text.includes('stdout'), 'stdout block');

console.log('self-test-agent-io-log: OK');

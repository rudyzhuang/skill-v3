#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { detectCursorAgentBin, shellSingleQuote } = require('./lib/detect-agent-bin.cjs');

function testShellQuote() {
  assert.strictEqual(shellSingleQuote('/a/b'), "'/a/b'");
  assert.strictEqual(shellSingleQuote("a'b"), "'a'\\''b'");
}

function testDetectWithFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-agent-home-'));
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const agent = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(agent, '#!/bin/sh\necho ok\n', 'utf8');
  fs.chmodSync(agent, 0o755);
  const prev = process.env.HOME;
  delete process.env.AI_CODE3_AGENT_BIN;
  delete process.env.AI_CODEGEN_AGENT_BIN;
  process.env.HOME = home;
  try {
    assert.strictEqual(detectCursorAgentBin(null), agent);
  } finally {
    process.env.HOME = prev;
  }
}

function testEnsureWritesConfig() {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-skill-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-agent-home2-'));
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const agent = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(agent, '#!/bin/sh\necho ok\n', 'utf8');
  fs.chmodSync(agent, 0o755);

  const prevHome = process.env.HOME;
  delete process.env.AI_CODE3_AGENT_BIN;
  process.env.HOME = home;
  const r = spawnSync(process.execPath, [
    path.join(__dirname, 'ensure-agent-env.cjs'),
    `--skill-dir=${skillDir}`,
  ], { encoding: 'utf8' });
  process.env.HOME = prevHome;
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const cfg = fs.readFileSync(path.join(skillDir, 'config.env'), 'utf8');
  assert.ok(cfg.includes(`AI_CODE3_AGENT_BIN=${agent}`));
}

testShellQuote();
testDetectWithFakeHome();
testEnsureWritesConfig();
console.log('selftest-ensure-agent-env: OK');

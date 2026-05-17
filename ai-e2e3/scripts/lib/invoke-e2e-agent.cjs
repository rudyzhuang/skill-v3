'use strict';

const fs = require('fs');
const path = require('path');
const { runWithTimeout } = require('./run-with-timeout.cjs');
const agentIo = require('../../../scripts/lib/agent-io-log.cjs');

function buildPrompt({ scenario, baseUrl, mode, deviceId }) {
  const lines = [
    'You are ai-e2e3 external agent (non-interactive).',
    `Mode: ${mode} (use ${mode === 'browser' ? 'cursor-ide-browser MCP' : 'user-dart MCP'}).`,
    `Scenario ID: ${scenario.id}`,
    `Client target: ${scenario.client_target}`,
    `Platform: ${scenario.platform}`,
  ];
  if (deviceId) lines.push(`Flutter device id (already booted + app installed): ${deviceId}`);
  if (baseUrl) lines.push(`Base URL: ${baseUrl}`);
  lines.push(
    '',
    'Execute every step in the scenario JSON below against the running app.',
    'Write results JSON to AI_E2E3_UI_E2E_OUTPUT with shape:',
    '{ "scenario_id": "...", "passed": true|false, "error": "", "step_failed": null|"step_name" }',
    'Do not print secrets. Exit 0 only when done writing the file.',
    '',
    JSON.stringify(scenario, null, 2)
  );
  return lines.join('\n');
}

/**
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, code?: number, passed?: boolean, error?: string, duration_ms?: number }>}
 */
async function invokeE2eAgent({
  projectRoot,
  scenario,
  baseUrl,
  outputJsonPath,
  timeoutMs,
  mode,
  deviceId,
  sessionId,
}) {
  const bin =
    process.env.AI_E2E3_AGENT_BIN ||
    process.env.AI_CODE3_AGENT_BIN ||
    process.env.AI_CODEGEN_AGENT_BIN ||
    '';
  if (!bin.trim()) {
    agentIo.logAgentIo(projectRoot, 'skip', {
      skill: 'ai-e2e3',
      stageKey: 'ui_e2e',
      phase: 'ui_scenario',
      sessionId,
      reason: 'no_agent_bin',
      promptRef: agentIo.promptRef({
        skill: 'ai-e2e3',
        relPath: 'scripts/lib/invoke-e2e-agent.cjs',
        symbol: 'buildPrompt',
      }),
    });
    return { ok: false, skipped: true, reason: 'no_agent_bin' };
  }
  if (outputJsonPath && fs.existsSync(outputJsonPath)) {
    try {
      fs.unlinkSync(outputJsonPath);
    } catch {
      /* ignore */
    }
  }
  const env = {
    ...process.env,
    AI_E2E3_PROJECT: projectRoot,
    AI_E2E3_UI_E2E_OUTPUT: outputJsonPath || '',
    AI_E2E3_MODE: mode,
  };
  const promptText = buildPrompt({ scenario, baseUrl, mode, deviceId });
  const args = [];
  const cmdBase = path.basename(bin).toLowerCase();
  if (cmdBase === 'cursor-agent') {
    args.push('--print', '--trust', promptText);
  } else {
    args.push(promptText);
  }
  const promptRefStr = agentIo.promptRef({
    skill: 'ai-e2e3',
    relPath: 'scripts/lib/invoke-e2e-agent.cjs',
    symbol: 'buildPrompt',
  });
  const { callId } = agentIo.logAgentIo(projectRoot, 'begin', {
    skill: 'ai-e2e3',
    stageKey: 'ui_e2e',
    phase: 'ui_scenario',
    sessionId: sessionId || process.env.AI_SESSION_ID,
    agentBin: bin,
    promptRef: promptRefStr,
    promptSha: agentIo.sha256Short(promptText),
    promptDynamic: `scenario_id=${scenario?.id || ''} mode=${mode}`,
    outputPath: outputJsonPath,
    argvSummary: cmdBase === 'cursor-agent' ? '--print --trust <prompt>' : '<prompt>',
  });
  const t0 = Date.now();
  const r = await runWithTimeout(bin, args, { cwd: projectRoot, timeoutMs, env });
  const elapsed = Date.now() - t0;
  const finishLog = (extra) => {
    agentIo.logAgentIo(projectRoot, 'end', {
      skill: 'ai-e2e3',
      stageKey: 'ui_e2e',
      phase: 'ui_scenario',
      sessionId: sessionId || process.env.AI_SESSION_ID,
      callId,
      agentBin: bin,
      promptRef: promptRefStr,
      elapsedMs: elapsed,
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      outputPath: outputJsonPath,
      ...extra,
    });
  };
  if (r.timedOut) {
    finishLog({ ok: false, reason: 'agent_timed_out' });
    return { ok: false, error: 'agent timed out', duration_ms: elapsed, callId };
  }
  if (r.code !== 0) {
    finishLog({ ok: false, reason: `agent_exit_${r.code}` });
    return { ok: false, code: r.code, error: (r.stderr || '').slice(0, 500), duration_ms: elapsed, callId };
  }
  if (outputJsonPath && fs.existsSync(outputJsonPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(outputJsonPath, 'utf8'));
      finishLog({
        ok: true,
        outputSummary: agentIo.summarizeJsonFile(outputJsonPath),
      });
      return {
        ok: true,
        passed: j.passed !== false,
        error: j.error || '',
        duration_ms: elapsed,
        callId,
      };
    } catch (e) {
      finishLog({ ok: false, reason: 'invalid_agent_output' });
      return { ok: false, error: `invalid agent output: ${e.message}`, duration_ms: elapsed, callId };
    }
  }
  finishLog({ ok: true });
  return { ok: true, passed: true, duration_ms: elapsed, callId };
}

module.exports = { invokeE2eAgent, buildPrompt };

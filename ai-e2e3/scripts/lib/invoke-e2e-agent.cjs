'use strict';

const fs = require('fs');
const path = require('path');
const { runWithTimeout } = require('./run-with-timeout.cjs');

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
async function invokeE2eAgent({ projectRoot, scenario, baseUrl, outputJsonPath, timeoutMs, mode, deviceId }) {
  const bin =
    process.env.AI_E2E3_AGENT_BIN ||
    process.env.AI_CODE3_AGENT_BIN ||
    process.env.AI_CODEGEN_AGENT_BIN ||
    '';
  if (!bin.trim()) {
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
  const args = [];
  const cmdBase = path.basename(bin).toLowerCase();
  if (cmdBase === 'cursor-agent') {
    args.push('--print', '--trust', buildPrompt({ scenario, baseUrl, mode, deviceId }));
  } else {
    args.push(buildPrompt({ scenario, baseUrl, mode, deviceId }));
  }
  const t0 = Date.now();
  const r = await runWithTimeout(bin, args, { cwd: projectRoot, timeoutMs, env });
  if (r.timedOut) {
    return { ok: false, error: 'agent timed out', duration_ms: Date.now() - t0 };
  }
  if (r.code !== 0) {
    return { ok: false, code: r.code, error: (r.stderr || '').slice(0, 500), duration_ms: Date.now() - t0 };
  }
  if (outputJsonPath && fs.existsSync(outputJsonPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(outputJsonPath, 'utf8'));
      return {
        ok: true,
        passed: j.passed !== false,
        error: j.error || '',
        duration_ms: Date.now() - t0,
      };
    } catch (e) {
      return { ok: false, error: `invalid agent output: ${e.message}`, duration_ms: Date.now() - t0 };
    }
  }
  return { ok: true, passed: true, duration_ms: Date.now() - t0 };
}

module.exports = { invokeE2eAgent, buildPrompt };

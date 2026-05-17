'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { resolveWebBaseUrl, substitutePlaceholders } = require('./resolve-base-url.cjs');
const { runWithTimeout } = require('./run-with-timeout.cjs');
const { invokeE2eAgent } = require('./invoke-e2e-agent.cjs');
const { prepareMobileAndRun } = require('./mobile-device.cjs');
const {
  isSoakStrict,
  runWebScenarioWithExpects,
  mobileExpectsSatisfied,
} = require('./execute-expect.cjs');

function isStubMode(config) {
  if (isSoakStrict(config)) return false;
  if (process.env.AI_E2E3_SKIP_AGENT === '1') return true;
  return !!(config.ui_e2e && config.ui_e2e.stub_mode === true);
}

function httpGetStatus(urlStr, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      resolve({ ok: false, status: null, error: 'invalid url' });
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, error: 'timeout' });
    });
    req.on('error', (e) => resolve({ ok: false, status: null, error: e.message }));
    req.end();
  });
}

/**
 * Stub web: only validate navigate steps return 2xx/3xx.
 */
async function runWebScenarioStub(scenario, baseUrl, vars) {
  const t0 = Date.now();
  for (const step of scenario.steps || []) {
    const act = String(step.action || '').toLowerCase();
    if (act !== 'navigate') continue;
    const url = substitutePlaceholders(step.url || '', { ...vars, base_url: baseUrl });
    const r = await httpGetStatus(url);
    if (!r.ok) {
      return {
        passed: false,
        duration_ms: Date.now() - t0,
        error: `navigate ${url} failed: ${r.error || `status ${r.status}`}`,
        step_failed: act,
      };
    }
  }
  return { passed: true, duration_ms: Date.now() - t0, error: '', step_failed: null };
}

/**
 * @param {object} opts
 * @returns {Promise<object[]>}
 */
async function executeScenarios(opts) {
  const { projectRoot, config, stagesDoc, scenarios, outputJsonPath, agentTimeoutMs, sessionId } =
    opts;
  const stub = isStubMode(config);
  const results = [];
  /** @type {Record<string, { ok: boolean, deviceId?: string, error?: string, mode?: string }>} */
  const mobileReady = {};
  const vars = {
    base_url: '',
    test_user: process.env.AI_E2E3_TEST_USER || 'e2e@test.local',
    test_password: process.env.AI_E2E3_TEST_PASSWORD || '',
  };

  for (const scenario of scenarios) {
    const id = String(scenario.id || 'unknown');
    const platform = String(scenario.platform || 'web').toLowerCase();
    const ct = String(scenario.client_target || '');
    const t0 = Date.now();
    let row = {
      scenario_id: id,
      client_target: ct,
      platform,
      passed: false,
      duration_ms: 0,
      error: '',
      step_failed: null,
    };

    try {
      if (platform === 'web') {
        const baseUrl = resolveWebBaseUrl(config, stagesDoc, ct);
        if (!baseUrl) {
          row.error = `no base_url for client_target=${ct}`;
          row.step_failed = 'preflight';
        } else {
          vars.base_url = baseUrl;
          const hasExpect = (scenario.expect || []).length > 0;
          if (stub && !hasExpect) {
            const r = await runWebScenarioStub(scenario, baseUrl, vars);
            Object.assign(row, r);
          } else if (stub || (hasExpect && !process.env.AI_E2E3_AGENT_BIN)) {
            const r = await runWebScenarioWithExpects(scenario, baseUrl, vars, substitutePlaceholders);
            Object.assign(row, r);
            if (r.executor) row.executor = r.executor;
          } else {
            const agentRes = await invokeE2eAgent({
              projectRoot,
              scenario,
              baseUrl,
              outputJsonPath,
              timeoutMs: agentTimeoutMs,
              mode: 'browser',
              sessionId,
            });
            if (agentRes.skipped) {
              if (isSoakStrict(config)) {
                row.error = `AI_SOAK3_STRICT: Browser agent 未执行 (${agentRes.reason || 'skipped'})`;
                row.step_failed = 'agent';
              } else {
                const r = hasExpect
                  ? await runWebScenarioWithExpects(scenario, baseUrl, vars, substitutePlaceholders)
                  : await runWebScenarioStub(scenario, baseUrl, vars);
                Object.assign(row, r);
                if (!r.passed) row.error = `${row.error}; agent skipped: ${agentRes.reason}`;
              }
            } else if (!agentRes.ok) {
              row.error = agentRes.error || `agent exit ${agentRes.code}`;
              row.step_failed = 'agent';
            } else {
              row.passed = agentRes.passed !== false;
              row.error = agentRes.error || '';
              row.duration_ms = agentRes.duration_ms || Date.now() - t0;
            }
          }
        }
      } else if (platform === 'android' || platform === 'ios') {
        if (!mobileReady[platform]) {
          mobileReady[platform] = await prepareMobileAndRun(projectRoot, platform, config);
        }
        const prep = mobileReady[platform];
        if (!prep.ok) {
          row.error = prep.error || 'mobile device/build/install failed';
          row.step_failed = prep.unresolvable ? 'mobile_env_unsatisfied' : 'mobile_device';
          row.unresolvable = !!prep.unresolvable;
          row.blocker = prep.blocker || '';
        } else if (stub || process.env.AI_E2E3_SKIP_AGENT === '1') {
          const mobEv = mobileExpectsSatisfied(scenario, config, prep);
          row.passed = mobEv.passed;
          row.error = mobEv.error || '';
          if (mobEv.executor) row.executor = mobEv.executor;
          if (!mobEv.passed) row.step_failed = 'expect';
        } else {
          const agentRes = await invokeE2eAgent({
            projectRoot,
            scenario,
            baseUrl: '',
            outputJsonPath,
            timeoutMs: agentTimeoutMs,
            mode: 'dart',
            deviceId: prep.deviceId,
            sessionId,
          });
          if (agentRes.skipped) {
            if (isSoakStrict(config)) {
              row.passed = false;
              row.error = `AI_SOAK3_STRICT: Dart MCP agent 未执行 (${agentRes.reason || 'skipped'})`;
              row.step_failed = 'agent';
            } else {
              const mobEv = mobileExpectsSatisfied(scenario, config, prep);
              row.passed = mobEv.passed;
              row.error = mobEv.error || '';
            }
          } else {
            row.passed = agentRes.ok && agentRes.passed !== false;
            row.error = agentRes.error || '';
          }
        }
        if (prep.ok && prep.deviceId) row.device_id = prep.deviceId;
        if (prep.ok && prep.mode) row.run_mode = prep.mode;
      } else {
        row.error = `unsupported platform ${platform}`;
      }
    } catch (e) {
      row.error = String(e.message || e);
    }
    if (!row.duration_ms) row.duration_ms = Date.now() - t0;
    results.push(row);
  }
  return results;
}

module.exports = { executeScenarios, isStubMode };

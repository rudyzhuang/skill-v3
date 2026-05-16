'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { resolveWebBaseUrl, substitutePlaceholders } = require('./resolve-base-url.cjs');
const { runWithTimeout } = require('./run-with-timeout.cjs');
const { invokeE2eAgent } = require('./invoke-e2e-agent.cjs');

function isStubMode(config) {
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

async function runMobileScenarioStub(projectRoot, scenario) {
  const t0 = Date.now();
  const mobileRoot = path.join(projectRoot, 'src', 'mobile');
  const intDir = path.join(mobileRoot, 'integration_test');
  if (!fs.existsSync(intDir)) {
    return {
      passed: false,
      duration_ms: Date.now() - t0,
      error: 'stub: no integration_test/ under src/mobile',
      step_failed: 'mobile',
    };
  }
  const pubspec = path.join(mobileRoot, 'pubspec.yaml');
  if (!fs.existsSync(pubspec)) {
    return {
      passed: false,
      duration_ms: Date.now() - t0,
      error: 'stub: missing pubspec.yaml',
      step_failed: 'mobile',
    };
  }
  const r = await runWithTimeout('flutter', ['test', 'integration_test'], {
    cwd: mobileRoot,
    timeoutMs: 300000,
  });
  if (r.timedOut) {
    return { passed: false, duration_ms: Date.now() - t0, error: 'flutter test timed out', step_failed: 'mobile' };
  }
  if (r.code !== 0) {
    return {
      passed: false,
      duration_ms: Date.now() - t0,
      error: (r.stderr || r.stdout || 'flutter test failed').slice(0, 800),
      step_failed: 'mobile',
    };
  }
  return { passed: true, duration_ms: Date.now() - t0, error: '', step_failed: null };
}

/**
 * @param {object} opts
 * @returns {Promise<object[]>}
 */
async function executeScenarios(opts) {
  const { projectRoot, config, stagesDoc, scenarios, outputJsonPath, agentTimeoutMs } = opts;
  const stub = isStubMode(config);
  const results = [];
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
          if (stub) {
            const r = await runWebScenarioStub(scenario, baseUrl, vars);
            Object.assign(row, r);
          } else {
            const agentRes = await invokeE2eAgent({
              projectRoot,
              scenario,
              baseUrl,
              outputJsonPath,
              timeoutMs: agentTimeoutMs,
              mode: 'browser',
            });
            if (agentRes.skipped) {
              const r = await runWebScenarioStub(scenario, baseUrl, vars);
              Object.assign(row, r);
              if (!r.passed) row.error = `${row.error}; agent skipped: ${agentRes.reason}`;
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
        if (stub) {
          const r = await runMobileScenarioStub(projectRoot, scenario);
          Object.assign(row, r);
        } else {
          const agentRes = await invokeE2eAgent({
            projectRoot,
            scenario,
            baseUrl: '',
            outputJsonPath,
            timeoutMs: agentTimeoutMs,
            mode: 'dart',
          });
          if (agentRes.skipped) {
            const r = await runMobileScenarioStub(projectRoot, scenario);
            Object.assign(row, r);
          } else {
            row.passed = agentRes.ok && agentRes.passed !== false;
            row.error = agentRes.error || '';
            row.duration_ms = agentRes.duration_ms || Date.now() - t0;
          }
        }
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

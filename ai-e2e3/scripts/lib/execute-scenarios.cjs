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
const {
  beginHumanLog,
  finalizeHumanLog,
  screenshotsFromAgentJson,
  listScreenshotsInDir,
} = require('./ui-test-human-log.cjs');

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

  const stubMode = stub;
  const skipAgent = process.env.AI_E2E3_SKIP_AGENT === '1';

  for (const scenario of scenarios) {
    const id = String(scenario.id || 'unknown');
    const platform = String(scenario.platform || 'web').toLowerCase();
    const ct = String(scenario.client_target || '');
    const t0 = Date.now();
    const logStartedAt = Date.now();
    let humanCtx = null;
    let row = {
      scenario_id: id,
      client_target: ct,
      platform,
      passed: false,
      duration_ms: 0,
      error: '',
      step_failed: null,
    };

    const finishHumanLog = (agentJsonPath) => {
      if (!humanCtx) return;
      const fromAgent = screenshotsFromAgentJson(agentJsonPath);
      const shots =
        fromAgent.length > 0
          ? fromAgent
          : listScreenshotsInDir(humanCtx.screenshotDir, logStartedAt - 2000);
      finalizeHumanLog(humanCtx.writer, row, {
        screenshots: shots,
        stubNoScreenshots: stubMode || skipAgent,
      });
      row.human_log_path = path.relative(projectRoot, humanCtx.logPath);
    };

    try {
      if (platform === 'web') {
        const baseUrl = resolveWebBaseUrl(config, stagesDoc, ct);
        humanCtx = beginHumanLog(projectRoot, scenario, {
          baseUrl: baseUrl || '',
          stub: stubMode,
          skipAgent,
          platform,
          client_target: ct,
          executor: null,
        });
        if (!baseUrl) {
          row.error = `no base_url for client_target=${ct}`;
          row.step_failed = 'preflight';
        } else {
          vars.base_url = baseUrl;
          const hasExpect = (scenario.expect || []).length > 0;
          if (stub && !hasExpect) {
            humanCtx.writer.append('执行方式：HTTP stub（仅校验 navigate 状态码）');
            const r = await runWebScenarioStub(scenario, baseUrl, vars);
            Object.assign(row, r);
          } else if (stub || (hasExpect && !process.env.AI_E2E3_AGENT_BIN)) {
            humanCtx.writer.append('执行方式：HTTP 脚本校验 expect（非 Browser MCP）');
            const r = await runWebScenarioWithExpects(scenario, baseUrl, vars, substitutePlaceholders);
            Object.assign(row, r);
            if (r.executor) row.executor = r.executor;
          } else {
            humanCtx.writer.append('执行方式：外部 Agent + Browser MCP');
            const agentRes = await invokeE2eAgent({
              projectRoot,
              scenario,
              baseUrl,
              outputJsonPath,
              timeoutMs: agentTimeoutMs,
              mode: 'browser',
              sessionId,
              humanLogPath: humanCtx.logPath,
              screenshotDir: humanCtx.screenshotDir,
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
            finishHumanLog(outputJsonPath);
          }
        }
        if (humanCtx && !row.human_log_path) finishHumanLog(outputJsonPath);
      } else if (platform === 'android' || platform === 'ios') {
        if (!mobileReady[platform]) {
          mobileReady[platform] = await prepareMobileAndRun(projectRoot, platform, config);
        }
        const prep = mobileReady[platform];
        const mobCfg = config.ui_e2e?.mobile?.[platform] || {};
        humanCtx = beginHumanLog(projectRoot, scenario, {
          baseUrl: '',
          deviceId: prep.deviceId || '',
          bundleId: mobCfg.bundle_id || '',
          stub: stubMode,
          skipAgent,
          platform,
          client_target: ct,
        });
        if (!prep.ok) {
          row.error = prep.error || 'mobile device/build/install failed';
          row.step_failed = prep.unresolvable ? 'mobile_env_unsatisfied' : 'mobile_device';
          row.unresolvable = !!prep.unresolvable;
          row.blocker = prep.blocker || '';
        } else if (stub || process.env.AI_E2E3_SKIP_AGENT === '1') {
          humanCtx.writer.append('执行方式：mobile stub（设备门闸 + expect 校验，非 Dart MCP）');
          const mobEv = mobileExpectsSatisfied(scenario, config, prep);
          row.passed = mobEv.passed;
          row.error = mobEv.error || '';
          if (mobEv.executor) row.executor = mobEv.executor;
          if (!mobEv.passed) row.step_failed = 'expect';
        } else {
          humanCtx.writer.append('执行方式：外部 Agent + Dart MCP');
          const agentRes = await invokeE2eAgent({
            projectRoot,
            scenario,
            baseUrl: '',
            outputJsonPath,
            timeoutMs: agentTimeoutMs,
            mode: 'dart',
            deviceId: prep.deviceId,
            sessionId,
            humanLogPath: humanCtx.logPath,
            screenshotDir: humanCtx.screenshotDir,
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
          finishHumanLog(outputJsonPath);
        }
        if (prep.ok && prep.deviceId) row.device_id = prep.deviceId;
        if (prep.ok && prep.mode) row.run_mode = prep.mode;
        if (humanCtx && !row.human_log_path) finishHumanLog(outputJsonPath);
      } else {
        row.error = `unsupported platform ${platform}`;
      }
    } catch (e) {
      row.error = String(e.message || e);
    }
    if (humanCtx && !row.human_log_path) finishHumanLog(outputJsonPath);
    if (!row.duration_ms) row.duration_ms = Date.now() - t0;
    results.push(row);
  }
  return results;
}

module.exports = { executeScenarios, isStubMode };

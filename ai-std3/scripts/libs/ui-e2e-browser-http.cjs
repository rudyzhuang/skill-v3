'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { evaluateWebExpects } = require('./ui-e2e-expect.cjs');

function httpGetBody(urlStr, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      resolve({ ok: false, status: null, body: '', error: e.message });
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const code = res.statusCode || 0;
          resolve({
            ok: code >= 200 && code < 400,
            status: code,
            body,
            error: '',
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, body: '', error: 'timeout' });
    });
    req.on('error', (e) => resolve({ ok: false, status: null, body: '', error: e.message }));
    req.end();
  });
}

/**
 * HTTP 驱动：仅 navigate / wait；适合 smoke 级 url/text 断言
 */
async function runWebScenarioHttp({ scenario, vars, substitutePlaceholders, appendLog, onStep }) {
  const t0 = Date.now();
  let lastUrl = '';
  let body = '';

  for (let i = 0; i < (scenario.steps || []).length; i++) {
    const step = scenario.steps[i];
    const act = String(step.action || '').toLowerCase();
    const stepStart = Date.now();

    if (act === 'wait') {
      const ms = step.timeout_ms || 1000;
      await new Promise((r) => setTimeout(r, Math.min(ms, 60000)));
      appendLog(`[step ${i}] wait ${ms}ms ok\n`);
    } else if (act === 'navigate') {
      const url = substitutePlaceholders(step.url || '', vars);
      appendLog(`[step ${i}] navigate ${url}\n`);
      const r = await httpGetBody(url);
      if (!r.ok) {
        return {
          passed: false,
          duration_ms: Date.now() - t0,
          error: `navigate ${url} failed: ${r.error || `status ${r.status}`}`,
          step_failed: act,
          step_index: i,
          executor: 'http',
        };
      }
      lastUrl = url;
      body = r.body;
    } else {
      return {
        passed: false,
        duration_ms: Date.now() - t0,
        error: `HTTP 驱动不支持交互步骤 action=${act}，请安装 playwright 或配置 Browser MCP`,
        step_failed: act,
        step_index: i,
        executor: 'http',
      };
    }

    if (onStep) onStep({ step_index: i, action: act, duration_ms: Date.now() - stepStart });
  }

  const ev = evaluateWebExpects(scenario, { lastUrl, body, pageText: body });
  if (!ev.passed) {
    return {
      passed: false,
      duration_ms: Date.now() - t0,
      error: ev.error,
      failure_summary: ev.error,
      step_failed: 'expect',
      executor: 'http',
      expect_detail: ev,
    };
  }

  return {
    passed: true,
    duration_ms: Date.now() - t0,
    error: '',
    step_failed: null,
    executor: 'http',
    lastUrl,
  };
}

module.exports = {
  httpGetBody,
  runWebScenarioHttp,
};

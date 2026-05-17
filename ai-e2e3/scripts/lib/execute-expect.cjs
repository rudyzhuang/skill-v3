'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function isSoakStrict(config) {
  if (process.env.AI_SOAK3_STRICT === '1' || process.env.AI_SOAK3_STRICT === 'true') return true;
  return !!(config?.ui_e2e && config.ui_e2e.strict_mode === true);
}

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
 * Evaluate scenario.expect[] deterministically (web).
 * @param {object} scenario
 * @param {string} baseUrl
 * @param {string} lastNavigateUrl
 * @param {string} body
 */
function evaluateWebExpects(scenario, baseUrl, lastNavigateUrl, body) {
  const expects = scenario.expect || [];
  const haystack = `${body}\n${lastNavigateUrl || ''}`;
  for (const ex of expects) {
    const type = String(ex.type || '').toLowerCase();
    const value = String(ex.value || '');
    if (type === 'text_present') {
      if (!value || !haystack.includes(value)) {
        return { passed: false, error: `text_present 未找到: ${value}`, step_failed: 'expect' };
      }
    } else if (type === 'url_contains') {
      if (!value || !String(lastNavigateUrl || '').includes(value)) {
        return { passed: false, error: `url_contains 未满足: ${value}`, step_failed: 'expect' };
      }
    } else if (type === 'body_not_contains') {
      if (value && haystack.includes(value)) {
        return { passed: false, error: `body_not_contains 违规: ${value}`, step_failed: 'expect' };
      }
    }
  }
  return { passed: true, error: '', step_failed: null };
}

/**
 * Stub web with navigate + expect evaluation.
 */
async function runWebScenarioWithExpects(scenario, baseUrl, vars, substitutePlaceholders) {
  const t0 = Date.now();
  let lastUrl = '';
  let body = '';
  for (const step of scenario.steps || []) {
    const act = String(step.action || '').toLowerCase();
    if (act === 'navigate') {
      const url = substitutePlaceholders(step.url || '', { ...vars, base_url: baseUrl });
      const r = await httpGetBody(url);
      if (!r.ok) {
        return {
          passed: false,
          duration_ms: Date.now() - t0,
          error: `navigate ${url} failed: ${r.error || `status ${r.status}`}`,
          step_failed: act,
        };
      }
      lastUrl = url;
      body = r.body;
    }
  }
  const ev = evaluateWebExpects(scenario, baseUrl, lastUrl, body);
  if (!ev.passed) {
    return { passed: false, duration_ms: Date.now() - t0, error: ev.error, step_failed: ev.step_failed };
  }
  return { passed: true, duration_ms: Date.now() - t0, error: '', step_failed: null, executor: 'stub_expect' };
}

/**
 * Mobile: if expects non-empty, stub cannot pass under strict.
 */
function mobileExpectsSatisfied(scenario, config, prep) {
  const expects = scenario.expect || [];
  if (!expects.length) {
    return { passed: true, executor: prep.mode || 'smoke_run' };
  }
  if (isSoakStrict(config)) {
    return {
      passed: false,
      error: 'AI_SOAK3_STRICT: mobile 场景含 expect 须 Dart MCP 或 integration_test，禁止 smoke_run 自动通过',
      executor: 'blocked_strict',
    };
  }
  return { passed: false, error: 'mobile expect 需要 agent 或 integration_test', executor: 'blocked' };
}

module.exports = {
  isSoakStrict,
  httpGetBody,
  evaluateWebExpects,
  runWebScenarioWithExpects,
  mobileExpectsSatisfied,
};

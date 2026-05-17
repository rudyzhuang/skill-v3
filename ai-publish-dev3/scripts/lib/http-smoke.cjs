'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_REDIRECTS = 5;

function bodyExpectFailed(c, body, title) {
  const failures = [];
  const haystack = `${body}\n${title || ''}`;
  if (c.body_contains) {
    const needles = Array.isArray(c.body_contains) ? c.body_contains : [c.body_contains];
    for (const n of needles) {
      const s = String(n || '');
      if (s && !haystack.includes(s)) {
        failures.push(`body_contains 未找到「${s}」于 ${c.path || c.name || '?'}`);
      }
    }
  }
  if (c.body_not_contains) {
    const banned = Array.isArray(c.body_not_contains) ? c.body_not_contains : [c.body_not_contains];
    for (const b of banned) {
      const s = String(b || '');
      if (s && haystack.includes(s)) {
        failures.push(`body_not_contains 违规「${s}」于 ${c.path || c.name || '?'}`);
      }
    }
  }
  if (c.title_contains) {
    const t = String(c.title_contains || '');
    if (t && !(title || '').includes(t)) {
      failures.push(`title_contains 未找到「${t}」于 ${c.path || c.name || '?'}`);
    }
  }
  return failures;
}

function needsResponseBody(checks) {
  return (checks || []).some(
    (c) => c.body_contains || c.body_not_contains || c.title_contains
  );
}

/**
 * GET/HEAD；非 GET/HEAD 仅当 `safe===true`（契约 x-smoke `safe` / `safe_post` 已折叠）允许（publish3.md §7.3、input-spec §8.13）。
 * 支持 body_contains / body_not_contains / title_contains（publish3.md §7.4）。
 * @param {{ name?: string, method?: string, path: string, expected_status?: number, safe?: boolean, body_contains?: string|string[], body_not_contains?: string|string[], title_contains?: string }[]} checks
 * @param {string} baseUrl
 * @returns {Promise<{ ok: boolean, failures: string[], results?: object[] }>}
 */
async function runHttpSmokeChecks(checks, baseUrl) {
  const failures = [];
  if (!baseUrl || !String(baseUrl).trim()) {
    return { ok: false, failures: ['base URL 为空，无法执行 HTTP smoke'] };
  }
  let base;
  try {
    base = new URL(baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl);
  } catch (e) {
    return { ok: false, failures: [`base URL 非法: ${e.message}`] };
  }

  const results = [];
  for (const c of checks) {
    const method = (c.method || 'GET').toUpperCase();
    const allowSafePost = method === 'POST' && c.safe === true;
    if (method !== 'GET' && method !== 'HEAD' && !allowSafePost) {
      failures.push(
        `检查项「${c.name || c.path}」方法 ${method} 被拒绝（需 GET/HEAD 或 x-smoke safe/safe_post→safe，见 publish3.md §7.3）`
      );
      continue;
    }
    const p = c.path && c.path.startsWith('/') ? c.path : `/${c.path || ''}`;
    let u;
    try {
      u = new URL(p, base);
    } catch (e) {
      failures.push(`路径非法 ${p}: ${e.message}`);
      continue;
    }
    const expected = c.expected_status != null ? Number(c.expected_status) : 200;
    const wantBody =
      c.body_contains || c.body_not_contains || c.title_contains || needsResponseBody([c]);
    let actual;
    let body = '';
    let title = '';
    if (wantBody && (method === 'GET' || method === 'HEAD')) {
      const full = await requestGetWithBody(u.toString(), method);
      actual = full.status;
      body = full.body || '';
      title = extractHtmlTitle(body);
    } else {
      actual = await requestStatus(u.toString(), method, allowSafePost);
    }
    const row = {
      name: c.name || c.path,
      path: p,
      method,
      expected_status: expected,
      actual_status: actual,
      passed: actual === expected,
    };
    if (actual !== expected) {
      failures.push(`${method} ${u.pathname} 期望 ${expected} 实际 ${actual === null ? 'ERR' : actual}`);
      row.passed = false;
    } else if (wantBody) {
      const bf = bodyExpectFailed(c, body, title);
      if (bf.length) {
        failures.push(...bf);
        row.passed = false;
        row.body_check_failures = bf;
      }
    }
    results.push(row);
  }
  return { ok: failures.length === 0, failures, results };
}

function extractHtmlTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}

function requestGetWithBody(targetUrl, method) {
  return new Promise((resolve) => {
    let redirects = 0;
    function go(url) {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        { method: method === 'HEAD' ? 'HEAD' : 'GET', timeout: 20000, headers: { 'user-agent': 'ai-publish-dev3-smoke/1' } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const code = res.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
              redirects++;
              if (redirects > MAX_REDIRECTS) {
                resolve({ status: null, body: '' });
                return;
              }
              try {
                go(new URL(res.headers.location, u).toString());
              } catch {
                resolve({ status: null, body: '' });
              }
              return;
            }
            const body = method === 'HEAD' ? '' : Buffer.concat(chunks).toString('utf8');
            resolve({ status: code, body });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: null, body: '' });
      });
      req.on('error', () => resolve({ status: null, body: '' }));
      req.end();
    }
    go(targetUrl);
  });
}

/**
 * @returns {Promise<number|null>} status code or null on error
 */
function requestStatus(targetUrl, method, withEmptyBody) {
  return new Promise((resolve) => {
    let redirects = 0;

    function go(url) {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        {
          method,
          timeout: 20000,
          headers: {
            'user-agent': 'ai-publish-dev3-smoke/1',
            ...(withEmptyBody ? { 'content-length': '0' } : {}),
          },
        },
        (res) => {
          res.resume();
          const code = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
            redirects++;
            if (redirects > MAX_REDIRECTS) {
              resolve(null);
              return;
            }
            let next;
            try {
              next = new URL(res.headers.location, u).toString();
            } catch {
              resolve(null);
              return;
            }
            go(next);
            return;
          }
          resolve(code);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
      req.end(withEmptyBody ? '' : undefined);
    }

    go(targetUrl);
  });
}

module.exports = { runHttpSmokeChecks, bodyExpectFailed, needsResponseBody };

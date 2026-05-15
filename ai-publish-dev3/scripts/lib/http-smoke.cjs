'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_REDIRECTS = 5;

/**
 * GET/HEAD；非 GET/HEAD 仅当 `safe===true`（契约 x-smoke `safe` / `safe_post` 已折叠）允许（publish3.md §7.3、input-spec §8.13）。
 * @param {{ name?: string, method?: string, path: string, expected_status?: number, safe?: boolean }[]} checks
 * @param {string} baseUrl
 * @returns {Promise<{ ok: boolean, failures: string[] }>}
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
    const actual = await requestStatus(u.toString(), method, allowSafePost);
    if (actual !== expected) {
      failures.push(`${method} ${u.pathname} 期望 ${expected} 实际 ${actual === null ? 'ERR' : actual}`);
    }
  }
  return { ok: failures.length === 0, failures };
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

module.exports = { runHttpSmokeChecks };

'use strict';

const https = require('https');

/**
 * Cloudflare REST API v4（deploy / provision 共用）
 */
function cfApiCall({ method, path: apiPath, body, token, accountId, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const startMs = Date.now();

    const options = {
      hostname: 'api.cloudflare.com',
      port:     443,
      path:     `/client/v4${apiPath}`,
      method:   method || 'GET',
      headers:  {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, raw: data, durationMs: Date.now() - startMs });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('CF API request timed out')));
    req.on('error', err => reject(err));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = { cfApiCall };

'use strict';

/**
 * prd3 附录 B / §12：secret-scan 单测（无依赖，node 直接运行）。
 */
const assert = require('assert');
const { scanJsonSecrets } = require('./lib/secret-scan.cjs');

const forbidden = ['secret', 'token', 'api_key', 'apikey', 'password', 'credential', 'private_key'];

assert.strictEqual(scanJsonSecrets({ api_key: 'x' }, forbidden).ok, false, '顶层 api_key 须失败');

assert.strictEqual(
  scanJsonSecrets({ security: { env_file_path: 'docs/config.env' } }, forbidden).ok,
  true,
  'env_file_path 不含 forbidden 子串时须通过',
);

assert.strictEqual(
  scanJsonSecrets({ nested: { my_token_here: 1 } }, forbidden).ok,
  false,
  '键名含 token 子串须失败',
);

assert.strictEqual(
  scanJsonSecrets({ k: '-----BEGIN PRIVATE KEY-----\nMII' }, forbidden).ok,
  false,
  'PEM 形态值须失败',
);

console.log('self-test-secret-scan: ok');

'use strict';

/**
 * code3.md 附录 B：config.*.json 扫描启发式须写入单测（与 prd3 self-test 同构思路）。
 * 无依赖：`node ai-code3/scripts/self-test-secret-scan.cjs`
 */
const assert = require('assert');
const { scanConfigObject, extractForbiddenPatterns, VALUE_HEURISTICS } = require('./lib/secret-scan.cjs');

assert.strictEqual(
  scanConfigObject({ nested: { my_api_key_field: 'x' } }, []).ok,
  false,
  '默认 forbidden 键名子串 api_key 须失败',
);

const cfgWithPatterns = {
  security: { forbidden_json_key_patterns: ['custom_bad'] },
  ok_key: 1,
};
assert.deepStrictEqual(extractForbiddenPatterns(cfgWithPatterns), ['custom_bad']);
assert.strictEqual(
  scanConfigObject({ section: { custom_bad_nested: 1 } }, extractForbiddenPatterns(cfgWithPatterns)).ok,
  false,
  'forbidden_json_key_patterns 须参与键名扫描',
);

assert.strictEqual(
  scanConfigObject({ k: '-----BEGIN PRIVATE KEY-----\nMII' }, []).ok,
  false,
  'PEM 形态值须失败',
);

assert.strictEqual(
  scanConfigObject({ k: 'sk_live_0123456789abcdef' }, []).ok,
  false,
  'sk_live_ 形态须失败',
);

assert.strictEqual(
  scanConfigObject({ k: 'AKIA0123456789ABCDEF' }, []).ok,
  false,
  'AKIA AWS key id 形态须失败',
);

assert.ok(Array.isArray(VALUE_HEURISTICS) && VALUE_HEURISTICS.length >= 1, 'VALUE_HEURISTICS 非空');

assert.strictEqual(scanConfigObject({ normal: { count: 42 } }, []).ok, true, '干净对象须通过');

console.log('ai-code3 self-test-secret-scan: ok');

'use strict';

/** 值形态启发式（附录 B）；命中返回原因字符串，否则 null */
const VALUE_SECRET_PATTERNS = [
  { re: /BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/i, msg: 'pem_private_key' },
  { re: /sk_live_[a-zA-Z0-9]+/i, msg: 'stripe_live_secret_prefix' },
  { re: /AIza[0-9A-Za-z_-]{20,}/, msg: 'google_api_key_shape' },
  { re: /xox[baprs]-[0-9A-Za-z-]+/i, msg: 'slack_token_shape' },
];

/**
 * 键名仍含「secret」等子串但为结构性字段，不应命中 forbidden 子串规则。
 * （与 docs/templates/config.*.json.template 中 security 块字段对齐。）
 */
const ALLOWED_KEY_NAMES = new Set(['secret_env_path', 'forbidden_json_key_patterns']);

/**
 * @param {unknown} obj
 * @param {string[]} forbiddenKeyPatterns 小写子串列表
 * @param {string} pathPrefix
 * @returns {{ ok: boolean, errors: string[] }}
 */
function scanJsonSecrets(obj, forbiddenKeyPatterns, pathPrefix = '') {
  const errors = [];
  const patterns = (forbiddenKeyPatterns || []).map((p) => String(p).toLowerCase());

  function walk(node, pfx) {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'string') {
        for (const { re, msg } of VALUE_SECRET_PATTERNS) {
          if (re.test(node)) errors.push(`${pfx || '$'}:value_pattern:${msg}`);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${pfx}[${i}]`));
      return;
    }
    for (const k of Object.keys(node)) {
      if (ALLOWED_KEY_NAMES.has(k)) {
        walk(node[k], pfx ? `${pfx}.${k}` : k);
        continue;
      }
      const keyLower = k.toLowerCase();
      for (const pat of patterns) {
        if (pat && keyLower.includes(pat)) {
          errors.push(`${pfx}.${k}:forbidden_key_pattern:${pat}`);
        }
      }
      walk(node[k], pfx ? `${pfx}.${k}` : k);
    }
  }

  walk(obj, pathPrefix);
  return { ok: errors.length === 0, errors };
}

module.exports = { scanJsonSecrets, VALUE_SECRET_PATTERNS };

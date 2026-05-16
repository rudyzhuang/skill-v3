'use strict';

const DEFAULT_FORBIDDEN_SUBSTRINGS = [
  'password',
  'secret_key',
  'api_key',
  'private_key',
  'access_token',
];

const VALUE_HEURISTICS = [
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /sk_live_[0-9a-zA-Z]+/,
  /AKIA[0-9A-Z]{16}/,
];

/** 与 ai-prd3 / ai-design3 模板 security 块对齐；推荐 `env_file_path`，遗留 `secret_env_path` 仍须豁免 */
const ALLOWED_KEY_NAMES = new Set(['forbidden_json_key_patterns', 'secret_env_path']);

/**
 * @param {unknown} root - parsed config JSON
 * @param {string[]} extraPatterns - from security.forbidden_json_key_patterns
 * @returns {{ ok: boolean, errors: string[] }}
 */
function scanConfigObject(root, extraPatterns = []) {
  const errors = [];
  const keyPatterns = [...DEFAULT_FORBIDDEN_SUBSTRINGS, ...extraPatterns].map((p) =>
    String(p).toLowerCase()
  );

  function walk(obj, prefix) {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${prefix}[${i}]`));
      return;
    }
    if (typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (!ALLOWED_KEY_NAMES.has(k)) {
        const lk = k.toLowerCase();
        for (const pat of keyPatterns) {
          if (pat && lk.includes(pat)) {
            errors.push(`forbidden_key_pattern: ${prefix}.${k} matches ${pat}`);
          }
        }
      }
      const v = obj[k];
      if (typeof v === 'string') {
        for (const re of VALUE_HEURISTICS) {
          if (re.test(v)) errors.push(`suspicious_value: ${prefix}.${k} matches ${re}`);
        }
      }
      walk(v, `${prefix}.${k}`);
    }
  }

  walk(root, '$');
  return { ok: errors.length === 0, errors };
}

/**
 * @param {object} configDoc
 */
function extractForbiddenPatterns(configDoc) {
  const sec = configDoc?.security;
  if (!sec || typeof sec !== 'object') return [];
  const raw = sec.forbidden_json_key_patterns;
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

module.exports = { scanConfigObject, extractForbiddenPatterns, VALUE_HEURISTICS };

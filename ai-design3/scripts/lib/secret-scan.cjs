'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 与 ai-prd3 `secret-scan.cjs` / 模板 `security` 块对齐的结构性键名，不参与 forbidden 子串匹配。
 * 推荐 **`env_file_path`**；遗留 **`secret_env_path`** 仍须豁免（键名含 `secret` 会命中常见 forbidden 子串规则）。
 */
const ALLOWED_KEY_NAMES = new Set(['forbidden_json_key_patterns', 'secret_env_path']);

/**
 * Walk object keys (recursively) and match forbidden substrings (lowercased).
 * @param {object} obj
 * @param {string[]} patterns from config.security.forbidden_json_key_patterns
 * @returns {{ hit: boolean, path: string, pattern: string }[]}
 */
function scanObjectKeys(obj, patterns, keyPath = '') {
  const hits = [];
  if (!obj || typeof obj !== 'object') return hits;
  const pats = (patterns || []).map((p) => String(p).toLowerCase());
  for (const k of Object.keys(obj)) {
    const lower = k.toLowerCase();
    const at = keyPath ? `${keyPath}.${k}` : k;
    if (!ALLOWED_KEY_NAMES.has(k)) {
      for (const pat of pats) {
        if (pat && lower.includes(pat)) {
          hits.push({ hit: true, path: at, pattern: pat });
        }
      }
    }
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      hits.push(...scanObjectKeys(v, patterns, at));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') {
          hits.push(...scanObjectKeys(item, patterns, `${at}[${i}]`));
        }
      });
    }
  }
  return hits;
}

function loadJsonIfExists(absPath) {
  if (!fs.existsSync(absPath)) return null;
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

/**
 * Scan docs/config.dev.json and docs/config.release.json using patterns from dev config.
 */
function scanProjectConfigKeys(projectRoot) {
  const devPath = path.join(projectRoot, 'docs', 'config.dev.json');
  const relPath = path.join(projectRoot, 'docs', 'config.release.json');
  const dev = loadJsonIfExists(devPath);
  if (!dev) {
    return { ok: false, errors: [`missing ${devPath}`] };
  }
  const patterns =
    dev.security &&
    Array.isArray(dev.security.forbidden_json_key_patterns)
      ? dev.security.forbidden_json_key_patterns
      : [];
  const errors = [];
  for (const file of [devPath, relPath]) {
    const j = loadJsonIfExists(file);
    if (!j) continue;
    const hits = scanObjectKeys(j, patterns);
    for (const h of hits) {
      errors.push(`forbidden_key_pattern: file=${file} key=${h.path} matched=${h.pattern}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  scanObjectKeys,
  scanProjectConfigKeys,
};

'use strict';

const fs = require('fs');

/**
 * 解析 docs/config.env（KEY=value，支持 # 注释与空行）。
 * 不记录值到日志上层；仅返回 map 供「键是否存在 / 值是否非空」校验。
 * @param {string} filePath
 * @returns {Map<string, string>}
 */
function parseConfigEnv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const map = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    map.set(key, val);
  }
  return map;
}

/**
 * @param {Map<string, string>} envMap
 * @param {string[]} requiredNames
 * @param {{ requireNonEmpty?: boolean }} [opts]
 * @returns {{ ok: boolean, message?: string }}
 */
function validateEnvKeys(envMap, requiredNames, opts = {}) {
  const missing = [];
  const empty = [];
  for (const name of requiredNames) {
    if (!envMap.has(name)) missing.push(name);
    else if (opts.requireNonEmpty && !String(envMap.get(name) || '').trim()) empty.push(name);
  }
  if (missing.length) {
    return { ok: false, message: `config.env 缺少变量名: ${missing.join(', ')}` };
  }
  if (empty.length) {
    return { ok: false, message: `config.env 中以下变量值为空（deploy.enabled=true 时禁止）: ${empty.join(', ')}` };
  }
  return { ok: true };
}

module.exports = { parseConfigEnv, validateEnvKeys };

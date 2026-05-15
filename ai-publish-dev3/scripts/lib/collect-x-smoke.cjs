'use strict';

const fs = require('fs');
const path = require('path');

let yamlMod = null;
try {
  yamlMod = require('js-yaml');
} catch {
  yamlMod = null;
}

/**
 * @param {object} doc 已 parse 的 OpenAPI 根对象
 * @param {string} sourceLabel 用于生成默认 name
 * @returns {{ name: string, method: string, path: string, expected_status: number, safe?: boolean }[]}
 */
function collectXSmokeFromOpenApiDoc(doc, sourceLabel) {
  const out = [];
  const paths = doc && doc.paths;
  if (!paths || typeof paths !== 'object') return out;
  for (const [pth, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const xs = op['x-smoke'];
      if (!xs || xs.enabled === false) continue;
      const m = method.toUpperCase();
      const exp = xs.expected_status != null ? Number(xs.expected_status) : 200;
      const safe = xs.safe === true || xs.safe_post === true;
      if (m !== 'GET' && m !== 'HEAD' && !safe) continue;
      out.push({
        name: (xs.name && String(xs.name)) || `${sourceLabel}:${pth}:${m}`,
        method: m,
        path: pth,
        expected_status: exp,
        safe: m === 'GET' || m === 'HEAD' ? undefined : true,
      });
    }
  }
  return out;
}

/**
 * @param {string} filePath 绝对路径
 * @param {string} rel 用于日志 / name 前缀
 */
function collectFromApiYamlFile(filePath, rel) {
  if (!yamlMod) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  let doc;
  try {
    doc = yamlMod.load(raw);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  return collectXSmokeFromOpenApiDoc(doc, rel);
}

/**
 * 从 stages.contract.outputs.artifacts[].api 与约定路径 docs/api.yaml 收集 x-smoke。
 * @param {string} projectRoot
 * @param {object} stages 已 parse 的 stages.json 根
 * @returns {{ checks: object[], sources: string[], warn?: string }}
 */
function collectXSmokeChecks(projectRoot, stages) {
  const checks = [];
  const sources = [];
  let warn = '';

  if (!yamlMod) {
    warn = 'js-yaml 不可用：跳过契约 x-smoke 解析（请在 ai-publish-dev3 目录执行 npm ci）';
    return { checks, sources, warn };
  }

  const arts =
    (stages.stages &&
      stages.stages.contract &&
      stages.stages.contract.outputs &&
      stages.stages.contract.outputs.artifacts) ||
    [];

  const seenFiles = new Set();
  for (const row of arts) {
    if (!row || !row.api) continue;
    const rel = String(row.api).trim();
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    if (!fs.existsSync(abs) || seenFiles.has(abs)) continue;
    seenFiles.add(abs);
    const part = collectFromApiYamlFile(abs, rel);
    for (const c of part) {
      checks.push({ ...c, _source_file: rel });
    }
    if (part.length) sources.push(rel);
  }

  const fallback = path.join(projectRoot, 'docs', 'api.yaml');
  if (fs.existsSync(fallback) && !seenFiles.has(fallback)) {
    const part = collectFromApiYamlFile(fallback, 'docs/api.yaml');
    for (const c of part) {
      checks.push({ ...c, _source_file: 'docs/api.yaml' });
    }
    if (part.length) sources.push('docs/api.yaml');
  }

  return { checks, sources, warn };
}

function checkDedupKey(c) {
  const m = (c.method || 'GET').toUpperCase();
  const p = c.path && c.path.startsWith('/') ? c.path : `/${c.path || ''}`;
  return `${m} ${p}`;
}

/**
 * x-smoke 先入，config.checks 后入；同 method+path 时 **配置覆盖契约**（publish3.md §7.2 合并语义）。
 * @param {object[]} xSmoke
 * @param {object[]} configChecks
 */
function mergeSmokeChecks(xSmoke, configChecks) {
  const map = new Map();
  for (const c of xSmoke || []) {
    map.set(checkDedupKey(c), { ...c });
  }
  for (const c of configChecks || []) {
    map.set(checkDedupKey(c), { ...c });
  }
  const merged = [...map.values()];
  merged.sort((a, b) => {
    const ka = checkDedupKey(a);
    const kb = checkDedupKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  return merged;
}

/**
 * 供 summary_hash 的稳定序列（去掉内部 _source_file）。
 * @param {object[]} merged
 */
function normalizeForHash(merged) {
  return (merged || []).map((c) => ({
    name: c.name,
    method: (c.method || 'GET').toUpperCase(),
    path: c.path && c.path.startsWith('/') ? c.path : `/${c.path || ''}`,
    expected_status: c.expected_status != null ? Number(c.expected_status) : 200,
    safe: c.safe === true,
  }));
}

module.exports = {
  collectXSmokeChecks,
  mergeSmokeChecks,
  normalizeForHash,
  collectXSmokeFromOpenApiDoc,
};

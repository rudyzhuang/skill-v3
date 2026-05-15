'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['inputs', 'contracts', 'designs', 'templates']);

/**
 * 发现各端 feature_list.md：docs/<client_target>/feature_list.md
 * @param {string} projectRoot
 * @returns {string[]} 绝对路径列表
 */
function discoverFeatureListFiles(projectRoot) {
  const docs = path.join(projectRoot, 'docs');
  if (!fs.existsSync(docs)) return [];
  const out = [];
  for (const ent of fs.readdirSync(docs, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    const fl = path.join(docs, ent.name, 'feature_list.md');
    if (fs.existsSync(fl)) out.push(fl);
  }
  return out;
}

/**
 * 判定 feature_id 是否出现在任一 feature_list.md（表格行或 ### 标题）。
 * @param {string} projectRoot
 * @param {string} featureId
 */
function featureDeclaredInLists(projectRoot, featureId) {
  const paths = discoverFeatureListFiles(projectRoot);
  if (!paths.length) {
    return { ok: false, reason: 'no docs/*/feature_list.md found under docs/' };
  }
  const esc = featureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRe = new RegExp(`^\\|\\s*${esc}\\s*\\|`, 'm');
  const headingRe = new RegExp(`^###\\s+\`${esc}\`|^###\\s+${esc}\\s*:|^###\\s+<${esc}>`, 'm');
  const hits = [];
  for (const p of paths) {
    const text = fs.readFileSync(p, 'utf8');
    if (rowRe.test(text) || headingRe.test(text)) hits.push(path.relative(projectRoot, p));
  }
  if (!hits.length) {
    return {
      ok: false,
      reason: `feature_id "${featureId}" not found in any feature_list.md (table row or ### heading)`,
      searched: paths.map((p) => path.relative(projectRoot, p)),
    };
  }
  return { ok: true, hits };
}

module.exports = {
  discoverFeatureListFiles,
  featureDeclaredInLists,
};

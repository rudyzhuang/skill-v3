'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, requireProject, stagesPath } = require('./lib/paths.cjs');

/** 与 docs/templates/feature_list.md.template 骨架对齐（prd3.md §7.2） */
const FEATURE_LIST_SECTION_RES = [
  /^##\s+Metadata\s*$/m,
  /^##\s+Status Values\s*$/m,
  /^##\s+Features\s*$/m,
  /^##\s+Feature Details\s*$/m,
];

/**
 * @param {string} md
 * @returns {string[]}
 */
function parseFeatureIds(md) {
  const m = md.match(/^##\s+Features\s*$/m);
  if (!m || m.index === undefined) return [];
  const start = m.index + m[0].length;
  const tail = md.slice(start);
  const nextH2 = tail.search(/^##\s+/m);
  const section = nextH2 >= 0 ? tail.slice(0, nextH2) : tail;
  const ids = [];
  const seen = new Set();
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|\s*:?-+:?\s*\|/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const id = cells[1];
    if (!id || /^feature id$/i.test(id)) continue;
    if (/^[-:]+$/.test(id)) continue;
    if (/^[A-Za-z0-9_.-]+$/.test(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 从 prd-spec 的「核心功能」表提取功能 ID（首列）。
 * 同时兼容中英文标题：`## 6. 核心功能` / `## 6. Core Features`。
 * @param {string} md
 * @returns {string[]}
 */
function parseCoreFeatureIdsFromPrdSpec(md) {
  const h2 =
    md.match(/^##\s*6\.\s*核心功能\s*$/m) ||
    md.match(/^##\s*6\.\s*Core Features\s*$/im) ||
    md.match(/^##\s+核心功能\s*$/m) ||
    md.match(/^##\s+Core Features\s*$/im);
  if (!h2 || h2.index === undefined) return [];
  const start = h2.index + h2[0].length;
  const tail = md.slice(start);
  const nextH2 = tail.search(/^##\s+/m);
  const section = nextH2 >= 0 ? tail.slice(0, nextH2) : tail;
  const ids = [];
  const seen = new Set();
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|\s*:?-+:?\s*\|/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const id = cells[1];
    if (!id || /^功能 id$/i.test(id) || /^feature id$/i.test(id)) continue;
    if (/^[-:]+$/.test(id)) continue;
    if (/^[A-Za-z0-9_.-]+$/.test(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  const stagesFile = stagesPath(root);
  if (!fs.existsSync(stagesFile)) {
    console.error('缺少', stagesFile);
    process.exit(1);
  }
  const stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  const declared = stages.client_targets?.declared || [];
  const errors = [];
  const unionFeatureIds = new Set();
  for (const slug of declared) {
    const prd = path.join(root, 'docs', slug, 'prd.md');
    const fl = path.join(root, 'docs', slug, 'feature_list.md');
    if (!fs.existsSync(prd)) errors.push(`missing:${prd}`);
    if (!fs.existsSync(fl)) errors.push(`missing:${fl}`);
    if (fs.existsSync(prd) && fs.readFileSync(prd, 'utf8').trim().length < 40) {
      errors.push(`prd_too_short:${slug}`);
    }
    if (fs.existsSync(fl)) {
      const md = fs.readFileSync(fl, 'utf8');
      for (let i = 0; i < FEATURE_LIST_SECTION_RES.length; i++) {
        const re = FEATURE_LIST_SECTION_RES[i];
        if (!re.test(md)) {
          errors.push(`feature_list_missing_section:${slug}:idx${i}`);
        }
      }
      const ids = parseFeatureIds(md);
      if (ids.length === 0) errors.push(`feature_table_empty:${slug}`);
      for (const id of ids) unionFeatureIds.add(id);
    }
  }
  const prdSpec = path.join(root, 'docs', 'prd-spec.md');
  if (fs.existsSync(prdSpec)) {
    const coreIds = parseCoreFeatureIdsFromPrdSpec(fs.readFileSync(prdSpec, 'utf8'));
    for (const id of coreIds) {
      if (!unionFeatureIds.has(id)) {
        errors.push(`core_feature_not_in_feature_lists:${id}`);
      }
    }
  }
  if (errors.length) {
    console.error(JSON.stringify({ ok: false, errors }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, declared }, null, 2));
}

main();

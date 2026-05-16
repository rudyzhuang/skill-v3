'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs, requireProject, stagesPath } = require('./lib/paths.cjs');
const { stableStringify } = require('./lib/json-stable.cjs');
const { scanJsonSecrets } = require('./lib/secret-scan.cjs');
const { markPrdReviewFailed } = require('./lib/stage-status.cjs');
const { writeImplementationReport } = require('./prd-implementation-report.cjs');

function safeMarkPrdReviewFailed(root, summary) {
  try {
    markPrdReviewFailed(root, summary);
  } catch (_) {
    /* stages.json 缺失或不可写 */
  }
}

function sha256HexParts(parts) {
  const buf = Buffer.from(parts.join(''), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseFeatureRows(md) {
  const m = md.match(/^##\s+Features\s*$/m);
  if (!m || m.index === undefined) return new Map();
  const start = m.index + m[0].length;
  const tail = md.slice(start);
  const nextH2 = tail.search(/^##\s+/m);
  const section = nextH2 >= 0 ? tail.slice(0, nextH2) : tail;
  const rows = new Map();
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|\s*:?-+:?\s*\|/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length < 8) continue;
    const id = cells[1];
    if (!id || /^feature id$/i.test(id)) continue;
    if (/^[-:]+$/.test(id)) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) continue;
    rows.set(id, {
      id,
      priority: cells[5] || '',
      phase: cells[6] || '',
    });
  }
  return rows;
}

function parseDeferredFeatureIds(deferredFeatures) {
  const out = new Set();
  for (const row of deferredFeatures || []) {
    if (typeof row === 'string') {
      const id = row.trim();
      if (id) out.add(id);
      continue;
    }
    if (row && typeof row === 'object') {
      const id = String(row.feature_id || row.id || '').trim();
      if (id) out.add(id);
    }
  }
  return out;
}

function parseDeferredPriorityMap(deferredFeatures) {
  const out = new Map();
  for (const row of deferredFeatures || []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.feature_id || row.id || '').trim();
    if (!id) continue;
    const p = String(row.priority || '').trim();
    if (p) out.set(id, p);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  const stagesFile = stagesPath(root);
  if (!fs.existsSync(stagesFile)) {
    console.error('缺少', stagesFile);
    process.exit(1);
  }
  let stages;
  try {
    stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  } catch (e) {
    console.error('stages.json 无法解析:', String(e.message || e));
    process.exit(1);
  }

  const prd = stages.stages?.prd;
  if (prd?.status !== 'completed' || !prd?.validation?.passed) {
    safeMarkPrdReviewFailed(root, 'preflight:prd_not_completed');
    console.error('前置门闸失败：stages.prd 须为 completed 且 validation.passed=true');
    process.exit(1);
  }

  const pr = stages.stages?.prd_review;
  if (!pr) {
    safeMarkPrdReviewFailed(root, 'preflight:missing_prd_review_block');
    console.error('缺少 stages.prd_review');
    process.exit(1);
  }

  const errs = [];
  if (pr.outputs?.decision !== 'passed') errs.push('decision_not_passed');
  const bi = pr.blocking_issues || [];
  if (bi.length) errs.push(`blocking_issues_non_empty:${bi.length}`);

  if (
    pr.outputs?.decision === 'passed' &&
    (pr.conditions || []).length > 0 &&
    pr.validation?.conditions_resolved !== true
  ) {
    errs.push('conditions_not_resolved');
  }

  const phasePlan = pr.review?.phase_plan || [];
  const idSet = new Set();
  for (const ph of phasePlan) {
    for (const fid of ph.feature_ids || []) idSet.add(fid);
  }
  if (idSet.size === 0) errs.push('phase_plan_feature_ids_empty');

  const declared = stages.client_targets?.declared || [];
  const unionIds = new Set();
  const featureMeta = new Map();
  for (const slug of declared) {
    const fp = path.join(root, 'docs', slug, 'feature_list.md');
    if (!fs.existsSync(fp)) {
      errs.push(`missing_feature_list:${slug}`);
      continue;
    }
    const rows = parseFeatureRows(fs.readFileSync(fp, 'utf8'));
    for (const [id, row] of rows.entries()) {
      unionIds.add(id);
      if (!featureMeta.has(id)) featureMeta.set(id, row);
    }
  }
  for (const fid of idSet) {
    if (!unionIds.has(fid)) errs.push(`feature_id_not_in_lists:${fid}`);
  }
  const deferredIds = parseDeferredFeatureIds(pr.review?.deferred_features || []);
  for (const fid of deferredIds) {
    if (!unionIds.has(fid)) errs.push(`feature_id_not_in_lists:${fid}`);
  }
  const covered = new Set([...idSet, ...deferredIds]);
  for (const fid of unionIds) {
    if (!covered.has(fid)) errs.push(`feature_not_covered_in_phase_plan:${fid}`);
  }
  const deferredPriority = parseDeferredPriorityMap(pr.review?.deferred_features || []);
  for (const fid of covered) {
    const p = deferredPriority.get(fid) || featureMeta.get(fid)?.priority || '';
    if (!String(p || '').trim()) errs.push(`missing_priority_for_feature:${fid}`);
  }

  const devPath = path.join(root, 'docs', 'config.dev.json');
  const relPath = path.join(root, 'docs', 'config.release.json');
  const dev = JSON.parse(fs.readFileSync(devPath, 'utf8'));
  const rel = JSON.parse(fs.readFileSync(relPath, 'utf8'));
  const forbidden = dev.security?.forbidden_json_key_patterns || [];
  const s1 = scanJsonSecrets(dev, forbidden);
  const s2 = scanJsonSecrets(rel, forbidden);
  if (!s1.ok || !s2.ok) errs.push('config_secret_scan_failed');

  if (errs.length) {
    const now = new Date().toISOString();
    stages.stages.prd_review.status = 'failed';
    stages.stages.prd_review.validation = stages.stages.prd_review.validation || {};
    stages.stages.prd_review.validation.passed = false;
    stages.stages.prd_review.validation.checked_at = now;
    stages.stages.prd_review.validation.summary = errs.join(';');
    stages.stages.prd_review.validation.design_inputs_ready = false;
    stages.stages.prd_review.validation.config_secret_scan_passed = !errs.includes('config_secret_scan_failed');
    stages.stages.prd_review.validation.blocking_issues_count = bi.length;
    stages.stages.prd_review.inputs = stages.stages.prd_review.inputs || {};
    stages.stages.prd_review.inputs.summary_hash = '';
    stages.stages.prd_review.outputs = stages.stages.prd_review.outputs || {};
    stages.stages.prd_review.outputs.can_enter_design = false;
    fs.writeFileSync(stagesFile, `${JSON.stringify(stages, null, 2)}\n`, 'utf8');
    console.error(JSON.stringify({ ok: false, errors: errs }, null, 2));
    process.exit(1);
  }

  const prdHash = prd.inputs?.summary_hash || '';
  const slugs = [...(prd.outputs?.client_targets || declared)].sort();
  const parts = [prdHash + '\n'];
  for (const slug of slugs) {
    const p = path.join(root, 'docs', slug, 'feature_list.md');
    parts.push(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  }
  for (const slug of slugs) {
    const p = path.join(root, 'docs', slug, 'prd.md');
    parts.push(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  }
  parts.push(stableStringify(dev));
  parts.push(stableStringify(rel));
  const reviewHash = sha256HexParts(parts);

  const now = new Date().toISOString();
  stages.stages.prd_review.status = 'completed';
  stages.stages.prd_review.completed_at = now;
  stages.stages.prd_review.inputs = stages.stages.prd_review.inputs || {};
  stages.stages.prd_review.inputs.summary_hash = reviewHash;
  stages.stages.prd_review.outputs = stages.stages.prd_review.outputs || {};
  stages.stages.prd_review.outputs.can_enter_design = true;
  stages.stages.prd_review.validation = stages.stages.prd_review.validation || {};
  stages.stages.prd_review.validation.passed = true;
  stages.stages.prd_review.validation.checked_at = now;
  stages.stages.prd_review.validation.summary = 'prd_review_final_ok';
  stages.stages.prd_review.validation.design_inputs_ready = true;
  stages.stages.prd_review.validation.config_secret_scan_passed = true;
  stages.stages.prd_review.validation.blocking_issues_count = 0;
  stages.stages.prd_review.validation.conditions_resolved = true;

  stages.pipeline = stages.pipeline || {};
  stages.pipeline.updated_at = now;
  stages.pipeline.updated_by = 'ai-prd3';

  fs.writeFileSync(stagesFile, `${JSON.stringify(stages, null, 2)}\n`, 'utf8');

  try {
    const { path: reportPath } = writeImplementationReport(root, stages);
    const rel = path.relative(root, reportPath);
    console.error(`[ai-prd3] 实施节奏摘要（人话版）已写入: ${rel}`);
  } catch (e) {
    console.error('[ai-prd3] 写入实施节奏摘要失败（非致命）:', String(e.message || e));
  }

  console.log(JSON.stringify({ ok: true, summary_hash: reviewHash }, null, 2));
}

main();

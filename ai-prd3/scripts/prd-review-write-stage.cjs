'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, requireProject, stagesPath, skillDirFrom } = require('./lib/paths.cjs');
const { deepMerge } = require('./lib/merge-stages.cjs');
const featureStages = require('../../ai-auto3/scripts/lib/feature-stages.cjs');

function parseFeatureRowsFromFeatureList(md) {
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
      status: cells[4] || '',
      priority: cells[5] || '',
      phase: cells[6] || '',
    });
  }
  return rows;
}

function parseDeferredFeatureIds(deferredFeatures) {
  const ids = new Set();
  for (const row of deferredFeatures || []) {
    if (typeof row === 'string') {
      const id = row.trim();
      if (id) ids.add(id);
      continue;
    }
    if (row && typeof row === 'object') {
      const id = String(row.feature_id || row.id || '').trim();
      if (id) ids.add(id);
    }
  }
  return ids;
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

function collectDeclaredFeatureIds(root, declaredTargets) {
  const all = new Set();
  const featureMeta = new Map();
  for (const slug of declaredTargets || []) {
    const fp = path.join(root, 'docs', slug, 'feature_list.md');
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf8');
    for (const [id, row] of parseFeatureRowsFromFeatureList(content).entries()) {
      all.add(id);
      if (!featureMeta.has(id)) featureMeta.set(id, row);
    }
  }
  return { all, featureMeta };
}

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  if (!args.json) {
    console.error('缺少 --json=<prd-review-output.json>');
    process.exit(1);
  }
  const jsonPath = path.isAbsolute(args.json) ? args.json : path.join(root, args.json);
  if (!fs.existsSync(jsonPath)) {
    console.error('找不到 JSON 文件:', jsonPath);
    process.exit(1);
  }

  const stagesFile = stagesPath(root);
  let stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  const prd = stages.stages?.prd;
  if (prd?.status !== 'completed' || !prd?.validation?.passed) {
    console.error('前置门闸：须先完成 prd（stages.prd.status=completed 且 validation.passed=true）');
    process.exit(1);
  }
  const pr = stages.stages?.prd_review;
  if (pr?.status === 'completed' && pr?.validation?.passed && !args.force) {
    console.error('prd_review 已完成：覆盖须加 --force');
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const skillDir = skillDirFrom(__filename);
  const { validatePrdReviewMergePayload } = require('./lib/prd-review-payload.cjs');
  const pv = validatePrdReviewMergePayload(payload, skillDir);
  if (!pv.ok) {
    console.error(JSON.stringify({ ok: false, errors: pv.errors }, null, 2));
    process.exit(1);
  }
  const phasePlan = payload?.review?.phase_plan || [];
  const requestedIds = new Set();
  for (const ph of phasePlan) {
    for (const fid of ph?.feature_ids || []) requestedIds.add(String(fid || '').trim());
  }
  const deferredFeatures = payload?.review?.deferred_features || [];
  const deferredIds = parseDeferredFeatureIds(deferredFeatures);
  const declaredTargets = stages.client_targets?.declared || [];
  const { all: declaredIds, featureMeta } = collectDeclaredFeatureIds(root, declaredTargets);
  const unknownIds = [...requestedIds].filter((fid) => fid && !declaredIds.has(fid));
  const unknownDeferredIds = [...deferredIds].filter((fid) => fid && !declaredIds.has(fid));
  if (unknownDeferredIds.length) {
    unknownIds.push(...unknownDeferredIds);
  }
  if (unknownIds.length) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          errors: unknownIds.map((fid) => `feature_id_not_in_lists:${fid}`),
          hint: '请改用 docs/<target>/feature_list.md 中存在的 feature_id（可参考项目根的 prd-review-auto.json）',
          declared_targets: declaredTargets,
          sample_feature_ids: [...declaredIds].slice(0, 20),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const covered = new Set([...requestedIds, ...deferredIds].filter(Boolean));
  const uncovered = [...declaredIds].filter((id) => !covered.has(id));
  if (uncovered.length) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          errors: uncovered.map((fid) => `feature_not_covered_in_phase_plan:${fid}`),
          hint: '请确保所有 feature_id 都进入 review.phase_plan 或 review.deferred_features。',
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const deferredPriority = parseDeferredPriorityMap(deferredFeatures);
  const missingPriority = [];
  for (const fid of covered) {
    if (!fid) continue;
    const p = deferredPriority.get(fid) || featureMeta.get(fid)?.priority || '';
    if (!String(p || '').trim()) {
      missingPriority.push(fid);
    }
  }
  if (missingPriority.length) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          errors: missingPriority.map((fid) => `missing_priority_for_feature:${fid}`),
          hint: '请在 feature_list.md 的 Priority 列或 review.deferred_features[].priority 中提供优先级。',
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const now = new Date().toISOString();
  const base = stages.stages.prd_review || {};
  const patch = {};
  if (payload.review) patch.review = deepMerge(base.review || {}, payload.review);
  if (payload.outputs) patch.outputs = deepMerge(base.outputs || {}, payload.outputs);
  if (payload.blocking_issues) patch.blocking_issues = payload.blocking_issues;
  if (payload.conditions) patch.conditions = payload.conditions;

  stages.stages.prd_review = deepMerge(base, patch);
  stages = featureStages.backfillFeatureStages(stages);
  const reviewIds = featureStages.collectPhaseFeatureIds(stages);
  const reviewBegun = featureStages.beginStageForFeatures(stages, {
    stageKey: 'prd_review',
    featureIds: reviewIds.length ? reviewIds : undefined,
    skill: 'ai-prd3',
    message: 'prd-review 合并评审 JSON，进入处理中',
  });
  stages = reviewBegun.doc;
  stages.stages.prd_review.status = 'running';
  stages.stages.prd_review.validation = stages.stages.prd_review.validation || {};
  stages.stages.prd_review.validation.passed = false;
  stages.stages.prd_review.inputs = stages.stages.prd_review.inputs || {};
  stages.stages.prd_review.inputs.summary_hash = '';
  stages.stages.prd_review.inputs.feature_lists = (stages.client_targets?.declared || []).map(
    (s) => `docs/${s}/feature_list.md`,
  );

  stages.pipeline = stages.pipeline || {};
  stages.pipeline.updated_at = now;
  stages.pipeline.updated_by = 'ai-prd3';

  fs.writeFileSync(stagesFile, `${JSON.stringify(stages, null, 2)}\n`, 'utf8');
  featureStages.appendStageLog(projectRoot, {
    skill: 'ai-prd3',
    stageKey: 'prd_review',
    featureIds: reviewIds,
    message: 'prd-review JSON 已合并，阶段进入 running',
    detail: reviewIds.length ? reviewIds.join(',') : 'no phase_plan',
  });
  console.log(JSON.stringify({ ok: true, merged_from: jsonPath }, null, 2));
}

main();

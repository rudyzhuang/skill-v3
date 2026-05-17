#!/usr/bin/env node
/**
 * prd-review.cjs — stage: prd-review
 *
 * 规范: docs/spec/std3.md §1 prd-review.cjs
 *
 * Agent 需产出: <project_root>/prd-review-auto.json
 *   { decision, phase_plan: [{phase, feature_ids[]}], deferred_features, risks, summary }
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { readStages, updateStage, sha256File, sha256Text } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[prd-review] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

// ── 上游门闸 ───────────────────────────────────────────────────────────────
const stages = readStages(projectRoot);
if (!stages || stages.stages.prd.status !== 'completed') {
  console.error('[prd-review] ❌ 上游门闸失败：stages.prd 未完成，请先运行 prd stage');
  process.exit(1);
}

updateStage(projectRoot, 'prd_review', { status: 'running', started_at: new Date().toISOString() });

// ── 查找 Agent 产出 JSON ───────────────────────────────────────────────────
const jsonPath = args['prdReviewJson'] || path.join(projectRoot, 'prd-review-auto.json');

if (!fs.existsSync(jsonPath)) {
  console.error('[prd-review] ❌ 缺少 prd-review-auto.json，需要 Agent 产出：');
  console.error('[prd-review] → 阅读 ai-std3/prompts/prd-review.md，产出评审 JSON：');
  console.error(`[prd-review]   { "decision": "passed|failed", "phase_plan": [{...}], ... }`);
  console.error(`[prd-review]   写入: ${jsonPath}`);
  console.error('[prd-review] → 写入后重跑: --from-stage=prd-review');
  updateStage(projectRoot, 'prd_review', { status: 'failed', validation: { passed: false, summary: '缺少 prd-review-auto.json' } });
  process.exit(4);
}

// ── 验证 JSON ──────────────────────────────────────────────────────────────
let reviewJson;
try {
  reviewJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (e) {
  console.error(`[prd-review] ❌ JSON 解析失败: ${e.message}`);
  process.exit(1);
}

const required = ['decision', 'phase_plan'];
for (const k of required) {
  if (!reviewJson[k]) {
    console.error(`[prd-review] ❌ JSON 缺少必填字段: ${k}`);
    process.exit(1);
  }
}

if (!Array.isArray(reviewJson.phase_plan) || reviewJson.phase_plan.length === 0) {
  console.error('[prd-review] ❌ phase_plan 必须是非空数组');
  process.exit(1);
}

// 检查 feature_ids 均在某端 feature_list.md 中
const docsDir = path.join(projectRoot, 'docs');
const clientTargets = stages.stages.prd.outputs.client_targets || [];
const allFeatureIds = new Set();
for (const t of clientTargets) {
  const featMd = path.join(docsDir, t, 'feature_list.md');
  if (fs.existsSync(featMd)) {
    const content = fs.readFileSync(featMd, 'utf8');
    for (const m of content.matchAll(/\|\s*([a-z][a-z0-9_-]+)\s*\|/g)) {
      allFeatureIds.add(m[1]);
    }
  }
}

const unknownFeatures = [];
for (const phase of reviewJson.phase_plan) {
  for (const fid of (phase.feature_ids || [])) {
    if (allFeatureIds.size > 0 && !allFeatureIds.has(fid)) {
      unknownFeatures.push(fid);
    }
  }
}
if (unknownFeatures.length > 0) {
  console.warn(`[prd-review] ⚠ phase_plan 中有未在 feature_list 声明的 feature_id: ${unknownFeatures.join(', ')}`);
}

// ── decision 检查 ──────────────────────────────────────────────────────────
if (reviewJson.decision === 'failed') {
  console.error('[prd-review] ❌ prd-review decision=failed');
  console.error(`[prd-review]   summary: ${reviewJson.summary || '（无摘要）'}`);
  console.error('[prd-review] → Agent 需根据评审意见修改 docs/prd-spec.md，然后重跑 --from-stage=prd');
  updateStage(projectRoot, 'prd_review', {
    status: 'failed',
    validation: { passed: false, summary: `decision=failed: ${reviewJson.summary || ''}` },
  });
  process.exit(4);
}

// ── 写完成态 ───────────────────────────────────────────────────────────────
const summaryHash = sha256Text(JSON.stringify(reviewJson));
updateStage(projectRoot, 'prd_review', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: summaryHash },
  outputs: {
    decision: reviewJson.decision,
    can_enter_design: true,
    phase_plan: reviewJson.phase_plan,
  },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `decision=${reviewJson.decision}` },
});

console.log(`[prd-review] ✅ prd-review 完成。decision=${reviewJson.decision}`);
process.exit(0);

#!/usr/bin/env node
/**
 * design-review.cjs — stage: design-review
 *
 * 规范: docs/spec/std3.md §1 design-review.cjs
 *
 * Agent 需产出: <project_root>/design-review-auto.json
 *   { decision: "passed|failed", gaps: [{feature_id, blocking, description}], summary }
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { readStages, updateStage, sha256Text } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[design-review] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages || stages.stages.design.status !== 'completed') {
  console.error('[design-review] ❌ 上游门闸失败：design 未完成');
  process.exit(1);
}

updateStage(projectRoot, 'design_review', { status: 'running', started_at: new Date().toISOString() });

// ── 查找 JSON ──────────────────────────────────────────────────────────────
const jsonPath = args['designReviewJson'] || path.join(projectRoot, 'design-review-auto.json');

if (!fs.existsSync(jsonPath)) {
  console.error('[design-review] ❌ 缺少 design-review-auto.json，需要 Agent 产出：');
  console.error('[design-review] → 阅读 ai-std3/prompts/design-review.md，产出评审 JSON：');
  console.error('[design-review]   { "decision": "passed|failed", "gaps": [...], "summary": "" }');
  console.error(`[design-review]   写入: ${jsonPath}`);
  console.error('[design-review] → 写入后重跑: --from-stage=design-review');
  updateStage(projectRoot, 'design_review', { status: 'failed', validation: { passed: false, summary: '缺少 design-review-auto.json' } });
  process.exit(4);
}

let reviewJson;
try {
  reviewJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (e) {
  console.error(`[design-review] ❌ JSON 解析失败: ${e.message}`);
  process.exit(1);
}

if (!reviewJson.decision) {
  console.error('[design-review] ❌ JSON 缺少 decision 字段');
  process.exit(1);
}

const blockingGaps = (reviewJson.gaps || []).filter(g => g.blocking);
if (blockingGaps.length > 0 || reviewJson.decision === 'failed') {
  console.error('[design-review] ❌ design-review 有阻塞 gap：');
  for (const g of blockingGaps) console.error(`  • [${g.feature_id}] ${g.description}`);
  console.error('[design-review] → Agent 需修复对应 design.json 后重跑 --from-stage=design');
  updateStage(projectRoot, 'design_review', {
    status: 'failed',
    outputs: { decision: reviewJson.decision, gaps: reviewJson.gaps || [] },
    validation: { passed: false, summary: `${blockingGaps.length} blocking gap(s)` },
  });
  process.exit(4);
}

updateStage(projectRoot, 'design_review', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(JSON.stringify(reviewJson)) },
  outputs: {
    decision: reviewJson.decision,
    can_enter_codegen: true,
    gaps: reviewJson.gaps || [],
  },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `decision=${reviewJson.decision}` },
});

console.log(`[design-review] ✅ design-review 完成。decision=${reviewJson.decision}`);
process.exit(0);

#!/usr/bin/env node
/**
 * design.cjs — stage: design
 *
 * 规范: docs/spec/std3.md §1 design.cjs
 *
 * Agent 需为每个 phase_plan feature_id 产出:
 *   docs/designs/<feature_id>.design.json
 *   { feature_id, client_target, file_plan[], api_outline[], acceptance[], description }
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

if (!args.project) { console.error('[design] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

// ── 上游门闸 ───────────────────────────────────────────────────────────────
const stages = readStages(projectRoot);
if (!stages) { console.error('[design] ❌ stages.json 不存在'); process.exit(1); }

const prdReview = stages.stages.prd_review;
if (prdReview.status !== 'completed' || prdReview.outputs.decision !== 'passed') {
  console.error('[design] ❌ 上游门闸失败：prd_review 未通过，请先运行 prd-review stage');
  process.exit(1);
}

updateStage(projectRoot, 'design', { status: 'running', started_at: new Date().toISOString() });

// ── 收集待设计的 feature_ids ────────────────────────────────────────────────
const phasePlan  = prdReview.outputs.phase_plan || [];
const featureIds = phasePlan.flatMap(p => p.feature_ids || []);
const filterFeat = args.feature || null;
const targets    = filterFeat ? featureIds.filter(f => f === filterFeat) : featureIds;

if (targets.length === 0) {
  console.warn('[design] ⚠ phase_plan 中没有 feature_id，请检查 prd-review-auto.json');
  process.exit(1);
}

// ── 检查 Agent 产出的 design.json ──────────────────────────────────────────
const designsDir = path.join(projectRoot, 'docs', 'designs');
const missing    = [];
const specs      = [];

for (const fid of targets) {
  const designPath = path.join(designsDir, `${fid}.design.json`);
  if (!fs.existsSync(designPath)) {
    missing.push(`docs/designs/${fid}.design.json`);
    continue;
  }
  try {
    const d = JSON.parse(fs.readFileSync(designPath, 'utf8'));
    const required = ['feature_id', 'client_target', 'file_plan', 'api_outline', 'acceptance'];
    const fieldMissing = required.filter(k => !d[k]);
    if (fieldMissing.length > 0) {
      missing.push(`docs/designs/${fid}.design.json 缺少字段: ${fieldMissing.join(', ')}`);
    } else {
      specs.push({ fid, path: designPath, hash: sha256File(designPath) });
    }
  } catch (e) {
    missing.push(`docs/designs/${fid}.design.json 解析失败: ${e.message}`);
  }
}

if (missing.length > 0) {
  console.error('[design] ❌ 以下 design.json 缺失或不合规：');
  for (const m of missing) console.error(`  • ${m}`);
  console.error('');
  console.error('[design] → 请按 ai-std3/prompts/design-spec.md 为每个 feature 产出 design.json：');
  console.error('[design]   { feature_id, client_target, file_plan[], api_outline[], acceptance[] }');
  console.error('[design] → 产出后重跑: --from-stage=design');
  updateStage(projectRoot, 'design', { status: 'failed', validation: { passed: false, summary: '缺少 design.json' } });
  process.exit(4);
}

// ── 写完成态 ───────────────────────────────────────────────────────────────
updateStage(projectRoot, 'design', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(specs.map(s => s.hash).join('|')) },
  outputs: {
    design_specs: specs.map(s => ({ feature_id: s.fid, path: `docs/designs/${s.fid}.design.json`, hash: s.hash })),
  },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `${specs.length} design.json 校验通过` },
});

console.log(`[design] ✅ design 完成（${specs.length} features）`);
process.exit(0);

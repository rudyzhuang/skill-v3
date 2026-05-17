#!/usr/bin/env node
/**
 * create-ui-scenarios.cjs — stage: create-ui-scenarios
 *
 * 规范: docs/spec/std3.md §1 create-ui-scenarios.cjs
 *
 * Agent 需为每个 feature 产出:
 *   docs/ui-scenarios/<feature_id>.scenarios.yaml
 *   每条 scenario: { id, client_target, platform, steps[], expect[] }
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

if (!args.project) { console.error('[create-ui-scenarios] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages) { console.error('[create-ui-scenarios] ❌ stages.json 不存在'); process.exit(1); }

const dr = stages.stages.design_review;
if (dr.status !== 'completed' || !dr.outputs.can_enter_codegen) {
  console.error('[create-ui-scenarios] ❌ 上游门闸失败：design_review 未通过');
  process.exit(1);
}

updateStage(projectRoot, 'create_ui_scenarios', { status: 'running', started_at: new Date().toISOString() });

// ── 收集 feature_ids ────────────────────────────────────────────────────────
const phasePlan  = stages.stages.prd_review.outputs.phase_plan || [];
const featureIds = phasePlan.flatMap(p => p.feature_ids || []);
const filterFeat = args.feature || null;
const targets    = filterFeat ? featureIds.filter(f => f === filterFeat) : featureIds;

const scenariosDir = path.join(projectRoot, 'docs', 'ui-scenarios');
const missing      = [];
const found        = [];

for (const fid of targets) {
  const yamlPath = path.join(scenariosDir, `${fid}.scenarios.yaml`);
  if (!fs.existsSync(yamlPath)) {
    missing.push(`docs/ui-scenarios/${fid}.scenarios.yaml`);
  } else {
    // 基本结构检查：含 steps 与 expect
    const content = fs.readFileSync(yamlPath, 'utf8');
    if (!/steps:/m.test(content) || !/expect:/m.test(content)) {
      missing.push(`docs/ui-scenarios/${fid}.scenarios.yaml 缺少 steps 或 expect 字段`);
    } else {
      found.push({ fid, hash: sha256File(yamlPath) });
    }
  }
}

if (missing.length > 0) {
  console.error('[create-ui-scenarios] ❌ 以下场景文件缺失或不合规：');
  for (const m of missing) console.error(`  • ${m}`);
  console.error('');
  console.error('[create-ui-scenarios] → 请按 ai-std3/prompts/create-ui-scenarios.md 产出 YAML 文件：');
  console.error('[create-ui-scenarios]   每条 scenario: { id, client_target, platform, steps[], expect[] }');
  console.error('[create-ui-scenarios] → 产出后重跑: --from-stage=create-ui-scenarios');
  updateStage(projectRoot, 'create_ui_scenarios', { status: 'failed', validation: { passed: false, summary: '缺少 scenarios YAML' } });
  process.exit(4);
}

updateStage(projectRoot, 'create_ui_scenarios', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(found.map(f => f.hash).join('|')) },
  outputs: {
    scenario_files: found.map(f => ({ feature_id: f.fid, path: `docs/ui-scenarios/${f.fid}.scenarios.yaml` })),
  },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `${found.length} 场景文件通过` },
});

console.log(`[create-ui-scenarios] ✅ create-ui-scenarios 完成（${found.length} features）`);
process.exit(0);

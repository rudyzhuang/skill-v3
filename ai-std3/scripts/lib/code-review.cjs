#!/usr/bin/env node
/**
 * code-review.cjs — stage: code-review
 *
 * 规范: docs/spec/std3.md §1 code-review.cjs
 *
 * Agent 需产出: <project_root>/code-review-auto.json
 *   { decision: "passed|passed_with_warnings|failed", critical_issues: 0, warnings: 0, checklist[] }
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

if (!args.project) { console.error('[code-review] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages || stages.stages.codegen.status !== 'completed') {
  console.error('[code-review] ❌ 上游门闸失败：codegen 未完成');
  process.exit(1);
}

updateStage(projectRoot, 'code_review', { status: 'running', started_at: new Date().toISOString() });

const jsonPath = args['codeReviewJson'] || process.env.AI_STD3_CODE_REVIEW_JSON || path.join(projectRoot, 'code-review-auto.json');

if (!fs.existsSync(jsonPath)) {
  console.error('[code-review] ❌ 缺少 code-review-auto.json，需要 Agent 产出：');
  console.error('[code-review] → 阅读 ai-std3/prompts/code-review-agent.md，产出评审 JSON：');
  console.error('[code-review]   { "decision": "passed|failed", "critical_issues": 0, "warnings": 0, "checklist": [] }');
  console.error(`[code-review]   写入: ${jsonPath}`);
  console.error('[code-review] → 写入后重跑: --from-stage=code-review');
  updateStage(projectRoot, 'code_review', { status: 'failed', validation: { passed: false, summary: '缺少 code-review-auto.json' } });
  process.exit(4);
}

let reviewJson;
try {
  reviewJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (e) {
  console.error(`[code-review] ❌ JSON 解析失败: ${e.message}`);
  process.exit(1);
}

const decision = reviewJson.decision || 'unknown';
const critical = Number(reviewJson.critical_issues) || 0;

if (decision === 'failed' || critical > 0) {
  console.error(`[code-review] ❌ code-review 失败: decision=${decision}, critical_issues=${critical}`);
  console.error('[code-review] → Agent 需修复 codegen，重跑 --from-stage=codegen --force-rerun=codegen');
  updateStage(projectRoot, 'code_review', {
    status: 'failed',
    outputs: { decision, critical_issues: critical, warnings: reviewJson.warnings || 0 },
    validation: { passed: false, summary: `critical_issues=${critical}` },
  });
  process.exit(4);
}

updateStage(projectRoot, 'code_review', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(JSON.stringify(reviewJson)) },
  outputs: {
    decision,
    critical_issues: critical,
    warnings: reviewJson.warnings || 0,
    checklist: reviewJson.checklist || [],
  },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `decision=${decision}` },
});

console.log(`[code-review] ✅ code-review 完成。decision=${decision}, critical_issues=${critical}`);
process.exit(0);

#!/usr/bin/env node
/**
 * report.cjs — stage: report
 *
 * 规范: docs/spec/std3.md §1 report.cjs
 *
 * 推导 overall 结果，生成 .pipeline/reports/autorun-<session_id>.md。
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { readStages, updateStage } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[report] 必须提供 --project='); process.exit(1); }
const projectRoot  = path.resolve(args.project);
const sessionId    = args.sessionId || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const failureReason = args.failureReason || null;

const stages = readStages(projectRoot);
if (!stages) {
  console.error('[report] ❌ stages.json 不存在');
  process.exit(1);
}

updateStage(projectRoot, 'report', { status: 'running', started_at: new Date().toISOString() });

// ── 推导 overall ───────────────────────────────────────────────────────────
const CORE_STAGES = ['prd','prd_review','design','design_review','create_ui_scenarios',
                     'codegen','code_review','merge_push','build','deploy','smoke','ui_e2e'];

const s = stages.stages;

let overall = 'success';
const stageSummary = [];

for (const key of CORE_STAGES) {
  const st = s[key] || {};
  const status = st.status || 'not_started';
  stageSummary.push({ stage: key, status, validation: (st.validation && st.validation.summary) || '' });
  if (status === 'failed') overall = 'failed';
  if (status === 'not_started' && overall !== 'failed') overall = 'partial';
}

// blocked 检查（merge_push 冲突）
if (s.merge_push && s.merge_push.outputs && (s.merge_push.outputs.conflict_features || []).length > 0) {
  overall = 'blocked';
}

if (failureReason && overall === 'success') overall = 'failed';

// ── 生成 Markdown 报告 ─────────────────────────────────────────────────────
const reportsDir = path.join(projectRoot, '.pipeline', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });

const reportPath = path.join(reportsDir, `autorun-${sessionId}.md`);
const now = new Date().toISOString();

const featureIds = (s.prd_review && s.prd_review.outputs && s.prd_review.outputs.phase_plan || [])
  .flatMap(p => p.feature_ids || []);

const lines = [
  `# Autorun Report — ${sessionId}`,
  '',
  `**overall**: ${overall}  `,
  `**generated_at**: ${now}  `,
  failureReason ? `**failure_reason**: ${failureReason}  ` : '',
  '',
  '## Stages Summary',
  '',
  '| stage | status | detail |',
  '| --- | --- | --- |',
  ...stageSummary.map(({ stage, status, validation }) =>
    `| ${stage} | ${status} | ${validation} |`
  ),
  '',
  '## Features',
  '',
  featureIds.length > 0
    ? featureIds.map(fid => {
        const cg = (s.codegen && s.codegen.outputs && s.codegen.outputs.worktrees || []).find(w => w.feature_id === fid);
        return `- ${fid}: ${cg ? `commit ${(cg.commit||'').slice(0,8)}` : '(pending)'}`;
      }).join('\n')
    : '（无 feature 信息）',
  '',
].filter(l => l !== undefined);

fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

updateStage(projectRoot, 'report', {
  status: 'completed',
  completed_at: now,
  outputs: {
    overall,
    report_path: path.relative(projectRoot, reportPath),
    summary: failureReason || overall,
  },
  validation: { passed: true, checked_at: now, summary: overall },
});

console.log(`[report] ✅ 报告已生成: .pipeline/reports/autorun-${sessionId}.md`);
console.log(`[report]   overall: ${overall}`);
process.exit(0);

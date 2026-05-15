#!/usr/bin/env node
'use strict';

/**
 * gen-report.cjs — ai-auto3 报告生成（auto3.md §10）
 * 用法: node gen-report.cjs --project=<abs> --session-id=<id> [--failure-reason=text]
 */

const fs = require('fs');
const path = require('path');
const { requireAbsoluteProject, agentSessionsDir } = require('./lib/paths.cjs');
const { readStages, writeStages, updateStage, updatePipelineMeta } = require('./lib/stages-io.cjs');

function parseArgs(argv) {
  const out = { project: null, sessionId: null, failureReason: '' };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--session-id=')) out.sessionId = a.slice('--session-id='.length);
    else if (a.startsWith('--failure-reason=')) out.failureReason = a.slice('--failure-reason='.length);
  }
  return out;
}

function deriveOverall(doc, failureReason) {
  if (failureReason) return 'failed';
  const st = doc.stages || {};
  if (st.contract?.status === 'blocked' || st.contract?.outputs?.human_approval?.status === 'pending') {
    return 'blocked';
  }
  const keys = [
    'design',
    'contract',
    'design_review',
    'codegen',
    'typecheck',
    'test',
    'code_review',
    'merge_push',
    'build',
    'deploy',
    'smoke',
  ];
  let anyFail = false;
  let anyIncomplete = false;
  for (const k of keys) {
    const s = st[k];
    if (!s) {
      anyIncomplete = true;
      continue;
    }
    if (s.status === 'failed') anyFail = true;
    if (s.status === 'blocked') return 'blocked';
    if (s.status !== 'completed' && s.status !== 'skipped') anyIncomplete = true;
    if (s.status === 'completed' && s.validation && s.validation.passed === false) anyFail = true;
  }
  if (anyFail) return 'failed';
  if (anyIncomplete) return 'partial';
  const deploy = doc.stages?.deploy;
  if (deploy?.status === 'skipped' || deploy?.outputs?.skip_reason) return 'partial';
  return 'success';
}

function collectFeatureIds(doc) {
  const phases = doc.stages?.prd_review?.review?.phase_plan || [];
  const ids = [];
  const seen = new Set();
  for (const p of phases) {
    for (const id of p.feature_ids || []) {
      const s = String(id).trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        ids.push(s);
      }
    }
  }
  return ids;
}

function buildMarkdown(doc, opts) {
  const lines = [];
  lines.push(`# Pipeline 报告`);
  lines.push('');
  lines.push(`- **生成时间**: ${new Date().toISOString()}`);
  lines.push(`- **session_id**: ${opts.sessionId}`);
  lines.push(`- **overall（推导）**: ${opts.overall}`);
  lines.push('');
  lines.push('## 本次范围');
  lines.push(`- **feature_ids**: ${collectFeatureIds(doc).join(', ') || '(无)'}`);
  const ct = [
    ...(doc.client_targets?.declared || []),
    ...(doc.client_targets?.generated || []),
  ];
  lines.push(`- **client_targets**: ${ct.join(', ') || '(见 stages)'}`);
  lines.push('');
  lines.push('## 各阶段摘要');
  const order = [
    ['design', 'design'],
    ['contract', 'contract'],
    ['design_review', 'design-review'],
    ['codegen', 'codegen'],
    ['typecheck', 'typecheck'],
    ['test', 'test'],
    ['code_review', 'code-review'],
    ['merge_push', 'merge-push'],
    ['build', 'build'],
    ['deploy', 'deploy'],
    ['smoke', 'smoke'],
  ];
  for (const [k, label] of order) {
    const s = doc.stages?.[k];
    if (!s) {
      lines.push(`- **${label}**: (无记录)`);
      continue;
    }
    const vp = s.validation?.passed;
    const dur = s.outputs?.duration_ms;
    lines.push(
      `- **${label}**: status=${s.status} validation.passed=${vp} duration_ms=${dur ?? 'n/a'}`
    );
    if (s.outputs?.timed_out) lines.push(`  - timed_out: ${s.outputs.timed_out} reason=${s.outputs.timeout_reason}`);
  }
  lines.push('');
  const deployUrl = doc.stages?.deploy?.outputs?.deploy_url || doc.stages?.deploy?.outputs?.services?.[0]?.url;
  if (deployUrl) lines.push(`## 部署 URL\n\n${deployUrl}\n`);
  const smoke = doc.stages?.smoke;
  if (smoke?.outputs?.checks?.length) {
    lines.push('## 冒烟');
    for (const c of smoke.outputs.checks) {
      lines.push(`- ${c.name || c.path || '?'}: passed=${c.passed}`);
    }
    lines.push('');
  }
  if (opts.failureReason) {
    lines.push('## 失败原因');
    lines.push(opts.failureReason);
    lines.push('');
  }
  if (doc.stages?.contract?.outputs?.human_approval?.status === 'pending') {
    lines.push('## 下一步（契约待审批）');
    lines.push(
      '请在业务仓执行 **ai-design3**：`node <skill>/scripts/run.cjs approve-contract --project=...` 或 `reject-contract`（见 docs/spec/design3.md §8）。'
    );
    lines.push('');
  }
  if (doc.stages?.test?.rollback_to) {
    lines.push('## 测试回退建议');
    lines.push(`- **rollback_to**: ${doc.stages.test.rollback_to}`);
    lines.push('可带 `--from-stage=codegen|contract` 续跑（见 input-spec §5）。');
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv);
  let projectRoot;
  try {
    projectRoot = requireAbsoluteProject(opts.project);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  const sessionId = opts.sessionId || `sess-${Date.now()}`;
  const started = Date.now();
  let doc;
  try {
    doc = readStages(projectRoot);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  const overall = deriveOverall(doc, opts.failureReason);
  const reportDir = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportName = `autorun-${sessionId}.md`;
  const reportPath = path.join(reportDir, reportName);
  const md = buildMarkdown(doc, { sessionId, overall, failureReason: opts.failureReason });
  fs.writeFileSync(reportPath, md, 'utf8');

  const now = new Date().toISOString();
  const passed = overall === 'success' || overall === 'partial';
  doc = updateStage(doc, 'report', {
    status: 'completed',
    started_at: doc.stages?.report?.started_at || now,
    completed_at: now,
    inputs: {
      ...(doc.stages?.report?.inputs || {}),
      summary_hash: doc.stages?.report?.inputs?.summary_hash || '',
      logs: [{ path: path.relative(projectRoot, reportPath), session_id: sessionId }],
    },
    outputs: {
      ...(doc.stages?.report?.outputs || {}),
      overall_result: overall,
      report_path: path.relative(projectRoot, reportPath),
      summary: opts.failureReason || `overall_result=${overall}`,
      next_steps: [],
      blockers: [],
      duration_ms: Date.now() - started,
      timed_out: false,
      timeout_reason: null,
    },
    validation: {
      ...(doc.stages?.report?.validation || {}),
      passed: passed,
      checked_at: now,
      summary: passed ? 'report generated' : 'report generated with failures noted',
    },
  });
  doc = updatePipelineMeta(doc, { currentStage: 'report', lastCompleted: 'report', by: 'ai-auto3' });
  try {
    writeStages(projectRoot, doc);
  } catch (e) {
    console.error(`gen-report: 写回 stages.json 失败: ${e.message}`);
    process.exit(1);
  }
  console.error(`gen-report: wrote ${reportPath} overall_result=${overall}`);
  process.exit(0);
}

main();

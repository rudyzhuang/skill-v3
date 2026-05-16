#!/usr/bin/env node
'use strict';

/**
 * ai-dash3 — 只读看板。见 docs/spec/dash3.md
 */

const fs = require('fs');
const path = require('path');

const STAGE_KEYS = [
  'prd',
  'prd_review',
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
  'report',
];

function displayStage(k) {
  return k === 'merge_push' ? 'merge-push' : k.replace(/_/g, '-');
}

function requireAbsoluteProject(projectOpt) {
  if (!projectOpt || !String(projectOpt).trim()) {
    throw new Error('missing --project=<absolute path to business project root>');
  }
  const abs = path.resolve(String(projectOpt).trim());
  if (!path.isAbsolute(abs)) throw new Error('--project must be an absolute path');
  if (!fs.existsSync(abs)) throw new Error(`--project path does not exist: ${abs}`);
  return abs;
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  const out = { subcommand: 'status', project: null, out: null };
  const known = new Set(['status', 'json', 'write-md']);
  if (rest.length && known.has(rest[0])) {
    out.subcommand = rest.shift();
  }
  for (const a of rest) {
    if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
  }
  return out;
}

function readStages(projectRoot) {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) {
    return { ok: true, missing: true, path: p, data: null };
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    return { ok: true, missing: false, path: p, data };
  } catch (e) {
    return { ok: false, missing: false, path: p, error: e.message };
  }
}

function stageRow(data, key) {
  if (!data || !data.stages || typeof data.stages !== 'object') {
    return { stage: key, status: '—', validation_passed: null };
  }
  const s = data.stages[key];
  if (!s) return { stage: key, status: '—', validation_passed: null };
  const st = s.status != null ? String(s.status) : 'unknown';
  let vp = null;
  if (s.validation && typeof s.validation.passed === 'boolean') vp = s.validation.passed;
  return { stage: key, status: st, validation_passed: vp };
}

function collectBlockers(data) {
  const blockers = [];
  if (!data || !data.stages) return blockers;

  const pr = data.stages.prd_review;
  if (pr) {
    const dec = pr.outputs && pr.outputs.decision != null ? String(pr.outputs.decision) : '';
    const st = pr.status != null ? String(pr.status) : '';
    if (dec === 'conditional_passed') {
      blockers.push({
        code: 'prd_review_conditional',
        message: 'prd_review 为 conditional_passed：ai-auto3 默认不放行',
        stage: 'prd_review',
      });
    } else if (['failed', 'rejected', 'pending'].includes(dec) && st !== 'completed') {
      blockers.push({
        code: 'prd_review_decision',
        message: `prd_review decision=${dec} status=${st}`,
        stage: 'prd_review',
      });
    }
  }

  const ct = data.stages.contract;
  if (ct && ct.outputs && ct.outputs.human_approval) {
    const hs = String(ct.outputs.human_approval.status || '');
    if (hs === 'pending') {
      blockers.push({
        code: 'contract_pending_approval',
        message: '契约待人工审批：请用 ai-design3 approve-contract / reject-contract',
        stage: 'contract',
      });
    }
  }
  if (ct && String(ct.status || '') === 'blocked') {
    blockers.push({
      code: 'contract_blocked',
      message: 'contract 已标记 blocked',
      stage: 'contract',
    });
  }

  for (const key of STAGE_KEYS) {
    const s = data.stages[key];
    if (!s) continue;
    if (String(s.status || '') === 'failed') {
      blockers.push({ code: 'stage_failed', message: `阶段 ${displayStage(key)} failed`, stage: key });
    }
    if (s.outputs && s.outputs.timed_out === true) {
      const reason = s.outputs.timeout_reason != null ? String(s.outputs.timeout_reason) : '';
      blockers.push({
        code: 'stage_timed_out',
        message: `阶段 ${displayStage(key)} timed_out${reason ? ` (${reason})` : ''}`,
        stage: key,
      });
    }
  }
  return blockers;
}

function isStageDone(data, key) {
  const row = stageRow(data, key);
  return row.status === 'completed' && row.validation_passed === true;
}

function firstIncompleteFrom(keys, data) {
  for (const k of keys) {
    if (!isStageDone(data, k)) {
      const r = stageRow(data, k);
      if (r.status === '—' && r.validation_passed === null) continue;
      return k;
    }
  }
  return null;
}

function suggestNext(projectRoot, read) {
  if (!read.ok) return `无法解析 stages.json：${read.error}（请修复 JSON）`;
  if (read.missing || !read.data) {
    return `未找到 .pipeline/stages.json → 建议：node <skills>/ai-prd3/scripts/run.cjs bootstrap --project=${projectRoot}`;
  }
  const data = read.data;
  if (!isStageDone(data, 'prd')) {
    return `prd 未完成 → 建议：ai-prd3 validate-prd / write-prd（见 docs/spec/prd3.md）`;
  }
  const prdReview = data.stages && data.stages.prd_review;
  const dec = prdReview && prdReview.outputs ? String(prdReview.outputs.decision || '') : '';
  if (!isStageDone(data, 'prd_review') || dec !== 'passed') {
    return `prd-review 未放行 → 建议：ai-prd3 finalize-prd-review --json=...（须 passed；见 prd3.md）`;
  }
  const ct = data.stages && data.stages.contract;
  const hp = ct && ct.outputs && ct.outputs.human_approval ? String(ct.outputs.human_approval.status || '') : '';
  if (hp === 'pending' || String(ct && ct.status) === 'blocked') {
    return `契约审批 → 建议：ai-design3 run.cjs approve-contract 或 reject-contract（见 design3.md §8）`;
  }

  const designKeys = ['design', 'contract', 'design_review'];
  const incD = firstIncompleteFrom(designKeys, data);
  if (incD) {
    return `设计链未完成（${displayStage(incD)}）→ 建议：ai-design3 run.cjs …（见 design3.md）`;
  }

  const codeKeys = ['codegen', 'typecheck', 'test', 'code_review', 'merge_push', 'build'];
  const incC = firstIncompleteFrom(codeKeys, data);
  if (incC) {
    return `实现链未完成（${displayStage(incC)}）→ 建议：ai-code3 run.cjs …（见 code3.md）`;
  }

  const incDeploy = firstIncompleteFrom(['deploy', 'smoke'], data);
  if (incDeploy) {
    return `dev 发布/冒烟未完成（${displayStage(incDeploy)}）→ 可选手动：ai-publish-dev3；或整链自动：ai-auto3 autorun.cjs（见 auto3.md）`;
  }

  if (!isStageDone(data, 'report')) {
    if (isStageDone(data, 'smoke')) {
      return `report 未完成 → 建议：ai-auto3 gen-report.cjs 或由 autorun 末尾生成（见 auto3.md）`;
    }
  }

  if (isStageDone(data, 'report')) {
    return `本轮 report 已完成 → 请查看 .pipeline/reports/ 下汇总文件`;
  }

  return '未匹配到特定阻塞 → 请查看上方阶段表与 blockers；开跑自动编排前仍建议 ai-auto3 preflight-only';
}

function pidLockInfo(projectRoot) {
  const lockPath = path.join(projectRoot, '.agent-sessions', 'locks', 'pipeline.pid');
  const out = { present: false, pid: null, alive: null };
  if (!fs.existsSync(lockPath)) return out;
  out.present = true;
  let pid = null;
  try {
    const t = fs.readFileSync(lockPath, 'utf8').trim();
    const n = parseInt(t, 10);
    if (Number.isFinite(n) && n > 0) pid = n;
  } catch (_) {
    return out;
  }
  out.pid = pid;
  if (pid == null) return out;
  if (process.platform === 'win32') {
    out.alive = null;
    return out;
  }
  try {
    process.kill(pid, 0);
    out.alive = true;
  } catch (e) {
    if (e && e.code === 'ESRCH') out.alive = false;
    else out.alive = null;
  }
  return out;
}

function listReports(projectRoot) {
  const d = path.join(projectRoot, '.pipeline', 'reports');
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return [];
  return fs
    .readdirSync(d)
    .filter((n) => {
      try {
        return fs.statSync(path.join(d, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function buildHints(read, pid) {
  const hints = [];
  if (read.missing) hints.push('missing_stages_json');
  if (pid.present && pid.alive === true) hints.push('pipeline_lock_alive');
  if (pid.present && pid.alive === false) hints.push('pipeline_lock_stale');
  return hints;
}

function buildJsonSummary(projectRoot, read) {
  const pid = pidLockInfo(projectRoot);
  const reports = listReports(projectRoot);
  const rows = STAGE_KEYS.map((k) => {
    const r = stageRow(read.data, k);
    const st = read.missing || r.status === '—' ? null : r.status;
    return { stage: k, status: st, validation_passed: r.validation_passed };
  });
  const blockers = collectBlockers(read.data);
  const data = read.data;
  const pipeline = data && data.pipeline ? data.pipeline : {};
  return {
    schema: 'ai-dash3.summary.v1',
    project_id: (data && data.project && data.project.project_id) || '',
    pipeline: {
      current_stage: pipeline.current_stage != null ? pipeline.current_stage : null,
      last_completed_stage: pipeline.last_completed_stage != null ? pipeline.last_completed_stage : null,
      updated_at: pipeline.updated_at != null ? pipeline.updated_at : null,
    },
    rows,
    blockers,
    reports,
    pid_lock: pid,
    suggested_next: read.ok && !read.missing ? suggestNext(projectRoot, read) : suggestNext(projectRoot, read),
    hints: buildHints(read, pid),
  };
}

function textTable(rows) {
  const lines = [['stage', 'status', 'validation']];
  for (const r of rows) {
    const v =
      r.validation_passed === true ? 'ok' : r.validation_passed === false ? 'no' : r.validation_passed === null ? '—' : '—';
    lines.push([displayStage(r.stage), r.status || '—', v]);
  }
  const w = [0, 0, 0];
  for (const L of lines) {
    for (let i = 0; i < 3; i++) w[i] = Math.max(w[i], L[i].length);
  }
  return lines
    .map((L, idx) => {
      const row =
        idx === 0
          ? `${L[0].padEnd(w[0])}  ${L[1].padEnd(w[1])}  ${L[2]}`
          : `${L[0].padEnd(w[0])}  ${L[1].padEnd(w[1])}  ${L[2]}`;
      return row;
    })
    .join('\n');
}

function formatStatus(projectRoot, read) {
  const pid = pidLockInfo(projectRoot);
  const reports = listReports(projectRoot);
  const rows = STAGE_KEYS.map((k) => stageRow(read.data, k));
  const blockers = collectBlockers(read.data);
  const lines = [];
  lines.push('=== ai-dash3（只读）===');
  lines.push(`project_root: ${projectRoot}`);
  if (!read.ok) {
    lines.push(`[错误] stages.json JSON 无效：${read.error}`);
    return lines.join('\n');
  }
  if (read.missing) {
    lines.push('[提示] 未找到 .pipeline/stages.json');
    lines.push(suggestNext(projectRoot, read));
    return lines.join('\n');
  }
  const pidLine = pid.present
    ? pid.alive === true
      ? `pipeline.pid: 存在，PID=${pid.pid}（进程存活）`
      : pid.alive === false
        ? `pipeline.pid: 残留（PID=${pid.pid} 不存在）`
        : `pipeline.pid: 存在（PID=${pid.pid}，未探测存活）`
    : 'pipeline.pid: 无';
  lines.push(pidLine);
  if (read.data && read.data.pipeline) {
    const p = read.data.pipeline;
    lines.push(
      `pipeline: current_stage=${p.current_stage != null ? p.current_stage : '—'} last_completed=${p.last_completed_stage != null ? p.last_completed_stage : '—'}`,
    );
  }
  lines.push('');
  lines.push(textTable(rows));
  lines.push('');
  lines.push('--- blockers ---');
  if (!blockers.length) lines.push('(无)');
  else blockers.forEach((b) => lines.push(`- [${b.code}] ${b.message}`));
  lines.push('');
  lines.push('--- .pipeline/reports ---');
  if (!reports.length) lines.push('(无文件)');
  else reports.forEach((f) => lines.push(`- .pipeline/reports/${f}`));
  lines.push('');
  lines.push('--- suggested next ---');
  lines.push(suggestNext(projectRoot, read));
  const hints = buildHints(read, pid);
  if (hints.length) {
    lines.push('');
    lines.push(`hints: ${hints.join(', ')}`);
  }
  return lines.join('\n');
}

function toMarkdown(projectRoot, read) {
  const body = formatStatus(projectRoot, read);
  return `# dash-status\n\n_Generated by **ai-dash3** (read-only)._\n\n\`\`\`text\n${body}\n\`\`\`\n`;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  let projectRoot;
  try {
    projectRoot = requireAbsoluteProject(args.project);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  const read = readStages(projectRoot);
  if (!read.ok) {
    console.error(`stages.json 非法 JSON (${read.path}): ${read.error}`);
    process.exit(1);
  }

  if (args.subcommand === 'json') {
    const summary = buildJsonSummary(projectRoot, read);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exit(0);
  }

  const text = formatStatus(projectRoot, read);
  if (args.subcommand === 'write-md') {
    let rel = args.out || '.pipeline/reports/dash-status.md';
    const outAbs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    try {
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, toMarkdown(projectRoot, read), 'utf8');
      process.stdout.write(`wrote ${outAbs}\n`);
    } catch (e) {
      console.error(`write-md failed: ${e.message || e}`);
      process.exit(1);
    }
    process.exit(0);
  }

  process.stdout.write(`${text}\n`);
  process.exit(0);
}

main();

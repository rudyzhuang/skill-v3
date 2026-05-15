#!/usr/bin/env node
/**
 * skill-v3：v2（ai-*2 / 旧流水线）→ v3 数据契约一次性迁移脚本。
 * 依据 docs/input-spec.md §9.3 与 §9.3.4；默认 dry-run，需 --commit 才落盘。
 *
 * 用法：
 *   node scripts/migrate-v2-to-v3.cjs --project=/path/to/business-repo
 *   node scripts/migrate-v2-to-v3.cjs --project=... --commit
 *   node scripts/migrate-v2-to-v3.cjs --project=... --db=/path/pipeline.db
 *   node scripts/migrate-v2-to-v3.cjs --project=... --non-interactive --answers-json='{"inventory":"scripts/cloudflare/inventory.json"}'
 *
 * 模板根目录默认为本仓库（脚本所在 skill-v3 根）下的 docs/templates。
 * 覆盖：--templates-root=/path/to/skill-v3
 *
 * 当前脚本覆盖范围（其余请手工对照 input-spec §9.3.2）：
 * - 文件：inventory.json、deployment_plan.json、feature_list.json→md、scripts/config.env→docs/config.env
 * - SQLite：review_state / design_state / contract_state / codegen_state / test_state（需本机 sqlite3 CLI）
 * - 未自动合并的表：typecheck_state、review_code_state、merge 以外的 deploy/smoke/release 等，需后续手工或扩展脚本
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const readline = require('readline');

const ALLOWED_CLIENT_TARGETS = new Set([
  'website',
  'admin',
  'backend',
  'mobile',
  'desktop',
  'miniapp',
  'agent',
]);

const PROVIDER_V2_TO_V3 = {
  cloudflare: 'cloudflare',
  aws: 'aws',
  tencent: 'tencent_cloud',
  alibaba: 'alibaba_cloud',
  aliyun: 'alibaba_cloud',
  vercel: 'vercel',
  gcp: 'google_cloud',
  google: 'google_cloud',
  azure: 'azure',
  huawei: 'huawei_cloud',
  manual: 'manual',
};

function parseArgs(argv) {
  const out = {
    project: '',
    commit: false,
    templatesRoot: path.join(__dirname, '..'),
    db: '',
    nonInteractive: false,
    answersJson: null,
    featureDetailMode: 'all', // all | none
    listChoicesOnly: false,
    providerOverride: '',
  };
  for (const a of argv) {
    if (a === '--commit') out.commit = true;
    else if (a === '--dry-run') out.commit = false;
    else if (a === '--non-interactive') out.nonInteractive = true;
    else if (a === '--list-choices') out.listChoicesOnly = true;
    else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--templates-root=')) out.templatesRoot = a.slice('--templates-root='.length);
    else if (a.startsWith('--db=')) out.db = a.slice('--db='.length);
    else if (a.startsWith('--answers-json=')) {
      const raw = a.slice('--answers-json='.length);
      if (raw.startsWith('@')) {
        const fp = path.resolve(raw.slice(1));
        out.answersJson = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } else {
        out.answersJson = JSON.parse(raw);
      }
    }
    else if (a.startsWith('--feature-details='))
      out.featureDetailMode = a.slice('--feature-details='.length);
    else if (a.startsWith('--provider-override='))
      out.providerOverride = a.slice('--provider-override='.length);
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`
skill-v3 migrate v2 → v3（input-spec §9.3）

必选：
  --project=<业务仓库根路径>

常用：
  --commit              默认仅 dry-run；加此参数才写入文件
  --templates-root=     含 docs/templates 的 skill-v3 根（默认：本脚本上级目录）
  --db=                 显式指定 v2 SQLite（默认 .ai-pipeline/pipeline.db；多 .db 时会交互或需 answers）
  --non-interactive     不提问；需配合 --answers-json 消歧
  --answers-json=       JSON；路径可用 @/abs/path.json 从文件读取
  --provider-override=  当 v2 为 oracle 等 catalog 未收录时，写入 deploy.provider
  --feature-details=all|none   feature_list.md 是否生成「Feature Details」（默认 all，大仓可 none）
  --list-choices        列出常见消歧项后退出（多 inventory / 多 .db 时退出码 2）

说明：SQLite 迁移依赖本机 sqlite3 可执行文件；未覆盖的表见脚本头部注释。
`);
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function walkDir(root, pred, acc = []) {
  if (!exists(root)) return acc;
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    return acc;
  }
  if (st.isFile()) {
    if (pred(root)) acc.push(root);
    return acc;
  }
  if (!st.isDirectory()) return acc;
  const base = path.basename(root);
  if (base === 'node_modules' || base === '.git') return acc;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    walkDir(path.join(root, e.name), pred, acc);
  }
  return acc;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readTemplate(templatesRoot, name) {
  const p = path.join(templatesRoot, 'docs', 'templates', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(templatesRoot, name) {
  return fs.readFileSync(path.join(templatesRoot, 'docs', 'templates', name), 'utf8');
}

function gitRemoteUrl(projectRoot) {
  try {
    return execFileSync('git', ['-C', projectRoot, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function defaultBranch(projectRoot) {
  try {
    const b = execFileSync('git', ['-C', projectRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf8',
    }).trim();
    const m = b.match(/refs\/remotes\/origin\/(.+)$/);
    return m ? m[1] : 'main';
  } catch {
    return 'main';
  }
}

function makeProjectId(projectRoot) {
  const remote = gitRemoteUrl(projectRoot);
  const resolved = path.resolve(projectRoot);
  if (remote) {
    const h = crypto.createHash('sha1').update(`${remote}|${resolved}`).digest('hex');
    return `p-${h.slice(0, 12)}`;
  }
  return `p-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function mapProviderV2ToV3(raw, providerOverride) {
  const k = String(raw || '')
    .trim()
    .toLowerCase();
  if (!k) return 'manual';
  if (k === 'oracle') return '__ORACLE_UNMAPPED__';
  if (providerOverride) return providerOverride;
  return PROVIDER_V2_TO_V3[k] || k;
}

function slugifyServiceName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'service';
}

function inventoryToDeployServices(inv, providerOverride) {
  const platformRaw = inv.platform || inv.recommended_platform || 'manual';
  const provider = mapProviderV2ToV3(platformRaw, providerOverride);
  if (provider === '__ORACLE_UNMAPPED__') {
    return { error: 'oracle', platformRaw };
  }
  const services = [];
  const targets = inv.targets || [];
  const res = inv.resources || {};
  const projectOrAccount = res.app_name || res.account_id || inv.primary_domain || '';
  const region = res.region || '';
  for (const t of targets) {
    const ct = t.name || t.client_target || 'website';
    const clientTarget = ALLOWED_CLIENT_TARGETS.has(ct) ? ct : 'website';
    const resourceType = slugifyServiceName(t.kind || t.platform_product || 'service');
    const serviceName = t.service_name || t.name || resourceType;
    const row = {
      client_target: clientTarget,
      service_name: serviceName,
      resource_type: resourceType,
      runtime: t.runtime || '',
      region: t.region || region,
      domain: inv.primary_domain || '',
      healthcheck_path: '/',
      create_if_missing: false,
      resource_config: {
        ...(typeof t.create_params === 'object' && t.create_params ? t.create_params : {}),
        src_dir: t.src_dir,
        build_cmd: t.build_cmd,
        deploy_cmd: t.deploy_cmd,
        public_url: t.public_url,
      },
    };
    services.push(row);
  }
  if (services.length === 0) {
    services.push({
      client_target: 'website',
      service_name: 'default',
      resource_type: 'manual',
      runtime: '',
      region,
      domain: inv.primary_domain || '',
      healthcheck_path: '/',
      create_if_missing: false,
      resource_config: {},
    });
  }
  return {
    provider,
    region,
    project_or_account: projectOrAccount,
    services,
  };
}

function deploymentPlanToServices(plan, clientTargetFromPath, providerOverride) {
  const rp = plan.recommended_platform || plan.platform || 'manual';
  const provider = mapProviderV2ToV3(rp, providerOverride);
  if (provider === '__ORACLE_UNMAPPED__') return { error: 'oracle', platformRaw: rp };
  const sm = plan.service_mapping || {};
  const services = [];
  for (const [role, m] of Object.entries(sm)) {
    if (!m || typeof m !== 'object') continue;
    services.push({
      client_target: clientTargetFromPath,
      service_name: m.service_name || role,
      resource_type: slugifyServiceName(m.platform_product || role),
      runtime: m.runtime || '',
      region: m.region || '',
      domain: '',
      healthcheck_path: '/',
      create_if_missing: !!m.create_params,
      resource_config: {
        ...(typeof m.create_params === 'object' && m.create_params ? m.create_params : {}),
        role,
        public_url: m.public_url,
      },
    });
  }
  if (services.length === 0) {
    services.push({
      client_target: clientTargetFromPath,
      service_name: 'default',
      resource_type: 'manual',
      runtime: '',
      region: '',
      domain: '',
      healthcheck_path: '/',
      create_if_missing: false,
      resource_config: { migrated_from: 'deployment_plan.json', rationale_dropped: true },
    });
  }
  return { provider, region: plan.region || '', project_or_account: plan.account_id || '', services };
}

function mapPriority(p) {
  const x = String(p || '').toUpperCase();
  if (x === 'P0') return 'must';
  if (x === 'P1') return 'should';
  if (x === 'P2') return 'could';
  return 'must';
}

function mapPhaseFromScope(scope) {
  const s = String(scope || '').trim();
  if (/mvp/i.test(s) || s === 'MVP' || s === '首期') return 'mvp';
  if (/完备|complete/i.test(s)) return 'complete';
  if (/标准|standard/i.test(s)) return 'standard';
  if (/future|后续/i.test(s)) return 'future';
  return 'standard';
}

function mapFeatureStatusV2ToV3(status) {
  const s = String(status || 'draft').toLowerCase();
  if (['draft', 'reviewed', 'approved', 'blocked', 'deferred'].includes(s)) return s;
  if (s === 'done' || s === 'deployed' || s === 'merged') return 'approved';
  if (s === 'cancelled') return 'deferred';
  return 'draft';
}

function escapeMdCell(s) {
  return String(s == null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function acceptanceSummary(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return '';
  const t = String(criteria[0]);
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

function featureListJsonToMarkdown(data, clientTarget) {
  const title = data.title || `${clientTarget} features`;
  const now = new Date().toISOString();
  const lines = [];
  lines.push(`# ${escapeMdCell(title)}`);
  lines.push('');
  lines.push('## Metadata');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push('| schema_name | skill-v3-feature-list |');
  lines.push('| schema_version | 1 |');
  lines.push(`| client_target | ${clientTarget} |`);
  lines.push(`| source | ${escapeMdCell(data.source_path || `docs/${clientTarget}/prd.md`)} |`);
  lines.push('| generated_by | migrate-v2-to-v3.cjs |');
  lines.push(`| generated_at | ${now} |`);
  lines.push('');
  lines.push('## Status Values');
  lines.push('');
  lines.push('Allowed feature status values:');
  lines.push('');
  lines.push('- `draft`');
  lines.push('- `reviewed`');
  lines.push('- `approved`');
  lines.push('- `blocked`');
  lines.push('- `deferred`');
  lines.push('');
  lines.push('## Features');
  lines.push('');
  lines.push(
    '| Feature ID | Area | Name | Status | Priority | Phase | Related Targets | Acceptance Summary |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const items = data.items || [];
  for (const it of items) {
    const id = escapeMdCell(it.id);
    const area = escapeMdCell(it.area || '');
    const name = escapeMdCell(it.name || '');
    const status = mapFeatureStatusV2ToV3(it.status);
    const pri = mapPriority(it.priority);
    const phase = mapPhaseFromScope(it.scope || it.phase);
    const rel = escapeMdCell(
      []
        .concat(it.depends_on || [])
        .concat(it.blocks || [])
        .slice(0, 8)
        .join(', '),
    );
    const acc = escapeMdCell(acceptanceSummary(it.acceptance_criteria));
    lines.push(`| ${id} | ${area} | ${name} | ${status} | ${pri} | ${phase} | ${rel} | ${acc} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function featureListJsonToMarkdownWithDetails(data, clientTarget, mode) {
  const base = featureListJsonToMarkdown(data, clientTarget);
  if (mode === 'none') return base;
  const lines = [base, '', '## Feature Details', ''];
  for (const it of data.items || []) {
    const id = it.id;
    const name = it.name || id;
    lines.push(`### \`${id}\`: ${escapeMdCell(name)}`);
    lines.push('');
    lines.push(`- Area: ${escapeMdCell(it.area || '')}`);
    lines.push(`- Status: \`${mapFeatureStatusV2ToV3(it.status)}\``);
    lines.push(`- Priority: \`${mapPriority(it.priority)}\``);
    lines.push(`- Phase: \`${mapPhaseFromScope(it.scope || it.phase)}\``);
    lines.push(`- Client target: \`${clientTarget}\``);
    const rr = it.requirement_ref;
    lines.push(
      `- Source requirement: ${rr && rr.doc ? escapeMdCell(`${rr.doc} ${rr.section || ''}`) : ''}`,
    );
    lines.push(`- Description: ${escapeMdCell(it.description || '')}`);
    lines.push(`- User value: ${escapeMdCell(it.user_story || '')}`);
    lines.push(
      `- Dependencies: ${escapeMdCell(JSON.stringify(it.depends_on || [], null, 0))}`,
    );
    lines.push(`- Risks: _(v2 pipeline_stages 进度已迁至 .pipeline/stages.json，不再写入本字段)_`);
    lines.push('');
    lines.push('#### Acceptance Criteria');
    lines.push('');
    for (const c of it.acceptance_criteria || []) lines.push(`- ${escapeMdCell(c)}`);
    lines.push('');
    lines.push('#### Design Input Notes');
    lines.push('');
    lines.push(`- Data / entity hints: ${escapeMdCell(JSON.stringify(it.data_models || []))}`);
    lines.push(`- API / integration hints: ${escapeMdCell(JSON.stringify(it.apis || []))}`);
    lines.push(`- UI / flow hints: ${escapeMdCell(JSON.stringify(it.routes || []))}`);
    lines.push(
      `- Non-functional constraints: ${escapeMdCell(JSON.stringify(it.non_functional || {}))}`,
    );
    lines.push('');
    lines.push('#### Review Notes');
    lines.push('');
    lines.push('- prd-review decision: _(见 .pipeline/stages.json stages.prd_review)_');
    lines.push('- Blocking issues:');
    lines.push('- Follow-up:');
    lines.push('');
  }
  return lines.join('\n');
}

function forbiddenPatternsFromConfigTemplate(cfgTpl) {
  const sec = cfgTpl.security || {};
  return Array.isArray(sec.forbidden_json_key_patterns) ? sec.forbidden_json_key_patterns : [];
}

function collectSecretLikeKeys(obj, patterns, prefix = '') {
  const hits = [];
  if (!obj || typeof obj !== 'object') return hits;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const lk = k.toLowerCase();
    for (const pat of patterns) {
      if (lk.includes(String(pat).toLowerCase())) {
        hits.push({ path: p, sampleType: typeof v });
      }
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) hits.push(...collectSecretLikeKeys(v, patterns, p));
    else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (x && typeof x === 'object') hits.push(...collectSecretLikeKeys(x, patterns, `${p}[${i}]`));
      });
    }
  }
  return hits;
}

function sqlite3Available() {
  const r = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
}

function sqliteQueryJson(dbPath, sql) {
  const r = spawnSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) {
    return { ok: false, error: r.stderr || r.stdout };
  }
  const out = (r.stdout || '').trim();
  if (!out) return { ok: true, rows: [] };
  try {
    return { ok: true, rows: JSON.parse(out) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function tableExists(dbPath, table) {
  const q = `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${table.replace(/'/g, "''")}' LIMIT 1`;
  const r = sqliteQueryJson(dbPath, q);
  return r.ok && Array.isArray(r.rows) && r.rows.length > 0;
}

function mergeReviewIntoStages(stages, rows) {
  if (!rows.length) return;
  const pr = stages.stages.prd_review;
  const byPhase = new Map();
  let decision = 'passed';
  for (const row of rows) {
    if (row.review_status === 'deferred') {
      decision = 'failed';
      break;
    }
  }
  if (decision !== 'failed') {
    for (const row of rows) {
      if (row.review_status === 'modified') decision = 'conditional_passed';
    }
  }
  if (decision !== 'failed' && decision !== 'conditional_passed') {
    for (const row of rows) {
      if (row.review_status === 'pending') decision = 'pending';
    }
  }
  for (const row of rows) {
    const rs = row.review_status;
    const ph = Number(row.phase) || 1;
    const phaseKey = ph === 1 ? 'mvp' : ph === 2 ? 'standard' : 'complete';
    if (!byPhase.has(phaseKey)) {
      byPhase.set(phaseKey, { phase: phaseKey, feature_ids: [], goal: '', exit_criteria: [] });
    }
    if (rs === 'approved' || rs === 'modified') {
      const bucket = byPhase.get(phaseKey);
      if (!bucket.feature_ids.includes(row.feature_id)) bucket.feature_ids.push(row.feature_id);
    }
    let sc = {};
    try {
      sc = JSON.parse(row.suggested_changes || '{}');
    } catch {
      sc = { raw: row.suggested_changes };
    }
    if (sc && Object.keys(sc).length) {
      pr.review.suggested_prd_spec_changes.push({
        feature_id: row.feature_id,
        v2_suggested_changes: sc,
      });
    }
  }
  pr.review.phase_plan = [...byPhase.values()].sort((a, b) => {
    const order = { mvp: 0, standard: 1, complete: 2, future: 3 };
    return (order[a.phase] ?? 9) - (order[b.phase] ?? 9);
  });
  pr.outputs.decision = decision;
  if (decision === 'passed' || decision === 'conditional_passed') {
    pr.outputs.can_enter_design = decision === 'passed';
    pr.status = 'completed';
    pr.validation.passed = decision === 'passed';
    pr.validation.conditions_resolved = decision === 'passed';
    pr.validation.blocking_issues_count = 0;
  }
}

function mergeDesignState(stages, rows) {
  const specs = [];
  for (const row of rows) {
    let art = {};
    try {
      art = JSON.parse(row.artifact || '{}');
    } catch {
      art = { raw: row.artifact };
    }
    const st = String(row.status || 'pending');
    let mapped = 'not_started';
    if (st === 'approved') mapped = 'completed';
    else if (st === 'rejected') mapped = 'failed';
    else if (st === 'draft' || st === 'running') mapped = 'running';
    specs.push({
      feature_id: row.feature_id,
      v2_status: st,
      artifact: art,
      status: mapped,
    });
  }
  stages.stages.design.outputs.design_specs = specs;
  if (rows.length) {
    stages.stages.design.status = rows.every((r) => r.status === 'approved') ? 'completed' : 'not_started';
    stages.stages.design.validation.passed = false;
  }
}

function mergeCodegenState(stages, rows) {
  const wt = [];
  for (const row of rows) {
    const commit = row.commit != null ? row.commit : row.commit_hash;
    let fc = [];
    let fe = [];
    try {
      fc = JSON.parse(row.files_changed || '[]');
    } catch {
      fc = [];
    }
    try {
      fe = JSON.parse(row.files_expected || '[]');
    } catch {
      fe = [];
    }
    wt.push({
      feature_id: row.feature_id,
      branch: row.branch || '',
      worktree_path: row.worktree_path || '',
      commit: commit || '',
      files_expected: fe,
      files_changed: fc,
      test_files_expected: [],
      test_files_changed: [],
    });
  }
  stages.stages.codegen.outputs.worktrees = wt;
  const anyFailed = rows.some((row) => row.status === 'failed' || row.status === 'cancelled');
  const anyRunning = rows.some((row) => row.status === 'running');
  const allSuccess = rows.length && rows.every((row) => row.status === 'success');
  const anySkipped = rows.some((row) => row.status === 'skipped_existing');
  if (anyFailed) stages.stages.codegen.outputs.impl_codegen_status = 'failed';
  else if (anyRunning) stages.stages.codegen.outputs.impl_codegen_status = 'running';
  else if (allSuccess) stages.stages.codegen.outputs.impl_codegen_status = 'success';
  else if (anySkipped) stages.stages.codegen.outputs.impl_codegen_status = 'skipped';
  else stages.stages.codegen.outputs.impl_codegen_status = 'pending';
}

function mergeContractState(stages, rows) {
  const artifacts = [];
  for (const row of rows) {
    const base = row.artifacts_dir || 'contracts';
    const fid = row.feature_id;
    artifacts.push({
      feature_id: fid,
      types: row.has_types_ts ? `${base}/${fid}.types.ts` : '',
      api: row.has_api_yaml ? `${base}/${fid}.api.yaml` : '',
      schema: row.has_schema_sql ? `${base}/${fid}.schema.sql` : '',
      test_spec: row.has_test_spec ? `${base}/${fid}.test-spec.md` : '',
      design_snapshot: `${base}/${fid}.design.snapshot.json`,
    });
  }
  stages.stages.contract.outputs.artifacts = artifacts.length
    ? artifacts
    : stages.stages.contract.outputs.artifacts;
  const st = rows[0] && rows[0].status;
  if (st === 'check_passed' || st === 'approved') {
    stages.stages.contract.outputs.human_approval.status = 'approved';
    stages.stages.contract.status = 'completed';
    stages.stages.contract.validation.passed = st === 'check_passed';
  }
}

function mergeTestAndMerge(stages, rows) {
  if (!rows.length) return;
  const r0 = rows[0];
  stages.stages.test.outputs.result = String(r0.test_status || 'pending').replace('cancelled', 'failed');
  stages.stages.test.outputs.attempts = r0.attempts || 0;
  stages.stages.test.outputs.failure_summary = r0.last_error || '';
  stages.stages.test.outputs.bug_signature = r0.bug_signature || '';
  stages.stages.test.rollback_to = r0.rollback_to || null;
  const ms = r0.merge_status;
  if (ms && ms !== 'pending') {
    stages.stages.merge_push.outputs.merge_status = ms;
    stages.stages.merge_push.outputs.target_branch = r0.merge_target_branch || 'main';
    stages.stages.merge_push.outputs.merge_commit = r0.merge_commit || '';
    stages.stages.merge_push.outputs.error = r0.merge_error || '';
  }
}

async function promptChoice(question, options, nonInteractive, preset) {
  if (preset != null && preset !== '') return preset;
  if (nonInteractive) {
    throw new Error(`缺少消歧答案: ${question}`);
  }
  if (!process.stdin.isTTY) {
    throw new Error(`非交互环境无法选择: ${question}（请使用 --non-interactive --answers-json）`);
  }
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  [${i + 1}] ${o}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('请选择序号 (1-' + options.length + '): ', resolve);
  });
  rl.close();
  const n = parseInt(String(answer).trim(), 10);
  if (!n || n < 1 || n > options.length) throw new Error('无效选择');
  return options[n - 1];
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeIfCommit(commit, dryLabel, targetPath, content, isBuffer) {
  console.log(`${dryLabel} ${targetPath} (${isBuffer ? content.length + ' bytes' : 'text'})`);
  if (!commit) return;
  ensureDir(path.dirname(targetPath));
  if (isBuffer) fs.writeFileSync(targetPath, content);
  else fs.writeFileSync(targetPath, content, 'utf8');
}

function copyTemplateFileIfMissing(commit, dryLabel, templatesRoot, relFromTemplatesDocs, projectPath, destRel) {
  const src = path.join(templatesRoot, 'docs', 'templates', relFromTemplatesDocs);
  const dest = path.join(projectPath, destRel);
  if (exists(dest)) {
    console.log(`[skip] 已存在: ${dest}`);
    return;
  }
  const buf = fs.readFileSync(src);
  writeIfCommit(commit, dryLabel, dest, buf, true);
}

function minimalPrdSpec(clientTargets) {
  const lines = [
    '# PRD 总规（迁移占位）',
    '',
    '由 `migrate-v2-to-v3.cjs` 生成：请人工补全各章节，或改从 skill 模板重新初始化。',
    '',
    '## 端 (Client Targets)',
    '',
  ];
  for (const t of clientTargets) lines.push(`- ${t}`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const projectRoot = path.resolve(args.project);
  if (!exists(projectRoot)) {
    console.error('项目路径不存在:', projectRoot);
    process.exit(1);
  }
  const templatesRoot = path.resolve(args.templatesRoot);
  const tplStagesPath = path.join(templatesRoot, 'docs', 'templates', 'stages.json.template');
  if (!exists(tplStagesPath)) {
    console.error('找不到模板目录，请检查 --templates-root:', tplStagesPath);
    process.exit(1);
  }

  const dryLabel = args.commit ? '[write]' : '[dry-run]';

  const deploymentPlans = []
    .concat(walkDir(path.join(projectRoot, 'src'), (p) => p.endsWith('deployment_plan.json')))
    .concat(walkDir(path.join(projectRoot, 'docs'), (p) => p.endsWith('deployment_plan.json')));
  const featureListJsons = walkDir(projectRoot, (p) => {
    if (!p.endsWith('feature_list.json')) return false;
    return p.includes(`${path.sep}docs${path.sep}`) || p.includes(`${path.sep}src${path.sep}`);
  });
  const inventories = walkDir(projectRoot, (p) => path.basename(p) === 'inventory.json');
  const legacyConfigEnv = path.join(projectRoot, 'scripts', 'config.env');
  const v3ConfigEnv = path.join(projectRoot, 'docs', 'config.env');

  let dbPath = args.db ? path.resolve(args.db) : path.join(projectRoot, '.ai-pipeline', 'pipeline.db');
  /** @type {string[]} */
  const dbCandidates = walkDir(projectRoot, (p) => path.basename(p).endsWith('.db'));
  if (!args.db && !exists(dbPath)) {
    if (dbCandidates.length === 1) dbPath = dbCandidates[0];
  }

  let inventoryPath = '';
  if (inventories.length === 1) inventoryPath = inventories[0];

  console.log('=== v2 盘点 ===');
  console.log('project:', projectRoot);
  console.log('deployment_plan.json:', deploymentPlans.length ? deploymentPlans.join(', ') : '(无)');
  console.log('feature_list.json:', featureListJsons.length ? `${featureListJsons.length} 个` : '(无)');
  console.log('inventory.json:', inventories.length ? inventories.join(', ') : '(无)');
  console.log('scripts/config.env:', exists(legacyConfigEnv) ? legacyConfigEnv : '(无)');
  console.log('sqlite:', exists(dbPath) ? dbPath : '(无或待消歧)');

  const answers = args.answersJson || {};

  if (inventories.length > 1) {
    const preset = answers.inventory;
    const picked = await promptChoice(
      '发现多个 inventory.json，请选择一个作为 deploy 主来源：',
      inventories,
      args.nonInteractive,
      preset,
    );
    inventoryPath = picked;
  }

  if (!args.db && dbCandidates.length > 1) {
    const preset = answers.db;
    const picked = await promptChoice(
      '发现多个 .db，请选择 v2 pipeline 数据库：',
      dbCandidates,
      args.nonInteractive,
      preset,
    );
    dbPath = picked;
  }

  const cfgDevTpl = readTemplate(templatesRoot, 'config.dev.json.template');
  const forbidden = forbiddenPatternsFromConfigTemplate(cfgDevTpl);

  let mergedDeploy = {
    enabled: false,
    provider: 'manual',
    region: '',
    project_or_account: '',
    services: cfgDevTpl.deploy.services,
  };

  if (inventoryPath && exists(inventoryPath)) {
    const inv = readJson(inventoryPath);
    const sec = collectSecretLikeKeys(inv, forbidden);
    if (sec.length) console.warn('[warn] inventory 命中 forbidden 模式（应迁密钥到 docs/config.env）:', sec);
    const r = inventoryToDeployServices(inv, args.providerOverride);
    if (r.error === 'oracle') {
      console.error(
        '\n[阻塞] v2 platform 为 oracle，v3 catalog 未收录。请任选：\n' +
          '  (a) 在业务仓扩展 deploy-services.catalog 后重试\n' +
          '  (b) 使用 --provider-override=<catalog_provider_id> 指定替代 provider\n',
      );
      if (!args.listChoicesOnly) process.exit(1);
      return;
    } else {
      mergedDeploy = {
        enabled: true,
        environment: 'dev',
        provider: r.provider,
        region: r.region,
        project_or_account: r.project_or_account,
        services: r.services,
      };
    }
  }

  for (const dp of deploymentPlans) {
    const parts = dp.split(path.sep);
    const idx = parts.lastIndexOf('src') >= 0 ? parts.lastIndexOf('src') : parts.lastIndexOf('docs');
    const clientGuess = idx >= 0 && parts[idx + 1] ? parts[idx + 1] : 'website';
    const ct = ALLOWED_CLIENT_TARGETS.has(clientGuess) ? clientGuess : 'website';
    const plan = readJson(dp);
    const sec = collectSecretLikeKeys(plan, forbidden);
    if (sec.length) console.warn('[warn] deployment_plan 命中 forbidden 模式:', sec);
    const r = deploymentPlanToServices(plan, ct, args.providerOverride);
    if (r.error === 'oracle') {
      console.error('[阻塞] deployment_plan oracle，处理方式同上。', dp);
      if (!args.listChoicesOnly) process.exit(1);
      return;
    } else {
      mergedDeploy.provider = r.provider;
      mergedDeploy.region = mergedDeploy.region || r.region;
      mergedDeploy.project_or_account = mergedDeploy.project_or_account || r.project_or_account;
      mergedDeploy.services = mergedDeploy.services.concat(r.services);
    }
  }

  const clientTargetsSet = new Set();
  for (const fl of featureListJsons) {
    try {
      const j = readJson(fl);
      const dom = j.domain || j.client_target;
      if (dom && ALLOWED_CLIENT_TARGETS.has(String(dom))) clientTargetsSet.add(String(dom));
      const parent = path.basename(path.dirname(fl));
      if (ALLOWED_CLIENT_TARGETS.has(parent)) clientTargetsSet.add(parent);
    } catch {
      /* skip */
    }
  }
  if (mergedDeploy.services)
    for (const s of mergedDeploy.services) {
      if (s.client_target) clientTargetsSet.add(s.client_target);
    }
  const clientTargets = [...clientTargetsSet].sort();

  const stages = readTemplate(templatesRoot, 'stages.json.template');
  const pid = makeProjectId(projectRoot);
  const remote = gitRemoteUrl(projectRoot);
  const branch = defaultBranch(projectRoot);
  stages.project.project_id = pid;
  stages.project.root_path = projectRoot;
  stages.project.name = path.basename(projectRoot);
  stages.project.git.remote = remote;
  stages.project.git.default_branch = branch;
  stages.client_targets.declared = clientTargets;
  stages.client_targets.generated = clientTargets;

  if (exists(dbPath) && sqlite3Available()) {
    const q = (t) => sqliteQueryJson(dbPath, `SELECT * FROM ${t}`);
    if (tableExists(dbPath, 'review_state')) {
      const r = q('review_state');
      if (r.ok) mergeReviewIntoStages(stages, r.rows);
    }
    if (tableExists(dbPath, 'design_state')) {
      const r = q('design_state');
      if (r.ok) mergeDesignState(stages, r.rows);
    }
    if (tableExists(dbPath, 'contract_state')) {
      const r = q('contract_state');
      if (r.ok) mergeContractState(stages, r.rows);
    }
    if (tableExists(dbPath, 'codegen_state')) {
      const r = q('codegen_state');
      if (r.ok) mergeCodegenState(stages, r.rows);
    }
    if (tableExists(dbPath, 'test_state')) {
      const r = q('test_state');
      if (r.ok) mergeTestAndMerge(stages, r.rows);
    }
  } else if (exists(dbPath) && !sqlite3Available()) {
    console.warn(
      '[warn] 未检测到 sqlite3 CLI，跳过 SQLite → stages.json 迁移。可安装 sqlite3 或导出 JSON 后手工合并。',
    );
  }

  const cfgDev = JSON.parse(JSON.stringify(cfgDevTpl));
  cfgDev.project.project_id = pid;
  cfgDev.project.name = path.basename(projectRoot);
  cfgDev.project.root_path = projectRoot;
  cfgDev.project.default_client_targets = clientTargets;
  cfgDev.deploy = { ...cfgDev.deploy, ...mergedDeploy };

  const cfgRel = readTemplate(templatesRoot, 'config.release.json.template');
  cfgRel.project.project_id = pid;
  cfgRel.project.name = path.basename(projectRoot);
  cfgRel.project.root_path = projectRoot;
  cfgRel.project.default_client_targets = clientTargets;
  cfgRel.deploy = { ...cfgRel.deploy, ...mergedDeploy, environment: 'release' };

  if (args.listChoicesOnly) {
    console.log('\n=== 待人工确认 / 消歧（若无可忽略）===');
    if (inventories.length > 1)
      console.log('- 多个 inventory：--answers-json={"inventory":"<绝对路径>"}');
    if (dbCandidates.length > 1)
      console.log('- 多个 .db：--db=... 或 --answers-json={"db":"<绝对路径>"}');
    if (!sqlite3Available() && exists(dbPath)) console.log('- 安装 sqlite3 CLI 以启用 DB 迁移');
    console.log('- v2 feature 进度型 pipeline_stages 已不写入 feature_list.md，请以 stages.json 为准');
    process.exit(inventories.length > 1 || dbCandidates.length > 1 ? 2 : 0);
  }

  // 骨架：缺失才写模板
  ensureDir(path.join(projectRoot, '.pipeline'));
  ensureDir(path.join(projectRoot, 'docs', 'inputs'));

  const destStages = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!exists(destStages)) {
    writeIfCommit(args.commit, dryLabel, destStages, JSON.stringify(stages, null, 2), false);
  } else {
    console.log(`[skip] 已存在 .pipeline/stages.json（不覆盖）。需合并请手工或使用工具。`);
  }

  const destCfgDev = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!exists(destCfgDev)) {
    writeIfCommit(args.commit, dryLabel, destCfgDev, JSON.stringify(cfgDev, null, 2), false);
  } else console.log(`[skip] 已存在 docs/config.dev.json`);

  const destCfgRel = path.join(projectRoot, 'docs', 'config.release.json');
  if (!exists(destCfgRel)) {
    writeIfCommit(args.commit, dryLabel, destCfgRel, JSON.stringify(cfgRel, null, 2), false);
  } else console.log(`[skip] 已存在 docs/config.release.json`);

  if (!exists(path.join(projectRoot, 'docs', 'config.env'))) {
    copyTemplateFileIfMissing(args.commit, dryLabel, templatesRoot, 'config.env.template', projectRoot, 'docs/config.env');
  }

  const prdSpec = path.join(projectRoot, 'docs', 'inputs', 'prd-spec.md');
  if (!exists(prdSpec)) {
    writeIfCommit(args.commit, dryLabel, prdSpec, minimalPrdSpec(clientTargets.length ? clientTargets : ['website']), false);
  } else console.log(`[skip] 已存在 docs/inputs/prd-spec.md`);

  for (const flPath of featureListJsons) {
    const dir = path.dirname(flPath);
    const base = path.basename(dir);
    const clientTarget = ALLOWED_CLIENT_TARGETS.has(base) ? base : 'website';
    const mdPath = path.join(dir, 'feature_list.md');
    if (exists(mdPath)) {
      console.log(`[skip] 已存在 ${mdPath}`);
      continue;
    }
    const data = readJson(flPath);
    const md = featureListJsonToMarkdownWithDetails(data, clientTarget, args.featureDetailMode);
    writeIfCommit(args.commit, dryLabel, mdPath, md, false);
  }

  if (exists(legacyConfigEnv) && !exists(v3ConfigEnv)) {
    const body = fs.readFileSync(legacyConfigEnv, 'utf8');
    writeIfCommit(args.commit, dryLabel, v3ConfigEnv, body, false);
    console.log(
      '[note] 已从 scripts/config.env 复制到 docs/config.env。校验通过后请删除旧文件（input-spec §9.3.4）。',
    );
  }

  console.log('\n=== 完成 ===');
  if (!args.commit) {
    console.log('当前为 dry-run。确认无误后追加 --commit 落盘。');
    console.log('落盘后请：');
    console.log('  1. 用 ai-prd3 / 契约脚本对 docs/config.*.json 与 .pipeline/stages.json 做 schema 校验');
    console.log('  2. 人工删除 v2 产物：src/*/deployment_plan.json、docs/*/feature_list.json、inventory.json、scripts/config.env、.ai-pipeline/pipeline.db（仅在备份后）');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

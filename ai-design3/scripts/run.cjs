#!/usr/bin/env node
'use strict';

/**
 * ai-design3 — 唯一对外 CLI（冻结子命令见 docs/spec/design3.md §6.1）。
 * 用法: node <skill_dir>/scripts/run.cjs <子命令> --project=<abs> [选项…]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { readStages, writeStages, isoNow } = require('./lib/stages-io.cjs');
const { scanProjectConfigKeys } = require('./lib/secret-scan.cjs');
const { createValidators, validateJson } = require('./lib/schema-validate.cjs');
const { featureDeclaredInLists } = require('./lib/feature-list.cjs');
const { appendSessionLog } = require('./lib/session-log.cjs');
const featureStages = require('../../ai-auto3/scripts/lib/feature-stages.cjs');
const gitSync = require('../../ai-auto3/scripts/lib/git-pipeline-sync.cjs');

function syncGitForFeatureIds(root, stageKey, featureIds) {
  if (!featureIds?.length) return 0;
  const config = gitSync.loadConfigDev(root);
  for (const fid of featureIds) {
    const r = gitSync.syncAfterFeature(root, stageKey, fid, { config });
    if (!r.ok && !r.skipped && r.push_status === 'failed') return 7;
  }
  return 0;
}
const { runStyleScan } = require('./lib/style-scan.cjs');
const { runLibResearch } = require('./lib/lib-research.cjs');
const {
  computeDesignInputHash,
  computeContractInputHash,
  computeDesignReviewInputHash,
} = require('./lib/input-hash.cjs');
const YAML = require('yaml');

const SUBCOMMANDS = new Set([
  'preflight',
  'list-design-candidates',
  'scan-design-style',
  'lib-research',
  'validate-design',
  'write-design',
  'hash-design-inputs',
  'register-contract-artifacts',
  'validate-contract',
  'approve-contract',
  'reject-contract',
  'mark-contract-not-required',
  'hash-contract-inputs',
  'validate-design-review',
  'write-design-review',
  'hash-design-review-inputs',
]);

const EXIT = {
  OK: 0,
  PRECHECK: 1,
  CANCEL: 2,
  TIMEOUT: 3,
  QUALITY: 4,
  CONTRACT_BREAK: 5,
};

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function skillRoot() {
  return path.resolve(__dirname, '..');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    cmd: null,
    project: null,
    feature: null,
    approvedBy: '',
    notes: null,
    force: false,
    forceRerun: null,
    dryRun: false,
  };
  if (!args.length) return out;
  out.cmd = args.shift();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a === '--project') out.project = args[++i];
    else if (a.startsWith('--feature=')) out.feature = a.slice('--feature='.length);
    else if (a === '--feature') out.feature = args[++i];
    else if (a.startsWith('--approved-by=')) out.approvedBy = a.slice('--approved-by='.length);
    else if (a === '--approved-by') out.approvedBy = args[++i];
    else if (a.startsWith('--notes=')) out.notes = a.slice('--notes='.length);
    else if (a === '--notes') out.notes = args[++i];
    else if (a.startsWith('--force-rerun=')) out.forceRerun = a.slice('--force-rerun='.length).trim();
    else if (a === '--force-rerun') {
      const n = args[++i];
      if (!n) {
        console.error('--force-rerun requires a stage: design | contract | design_review');
        process.exit(EXIT.PRECHECK);
      }
      out.forceRerun = String(n).trim();
    } else if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(EXIT.PRECHECK);
    }
  }
  if (out.forceRerun) {
    const ok = new Set(['design', 'contract', 'design_review']);
    if (!ok.has(out.forceRerun)) {
      console.error(`Invalid --force-rerun value: ${out.forceRerun} (expected design|contract|design_review)`);
      process.exit(EXIT.PRECHECK);
    }
  }
  return out;
}

function resolveProjectRoot(parsed) {
  if (parsed.project) {
    const abs = path.resolve(parsed.project);
    if (!fs.existsSync(abs)) {
      console.error(`--project path does not exist: ${abs}`);
      process.exit(EXIT.PRECHECK);
    }
    return abs;
  }
  let dir = process.cwd();
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, '.pipeline', 'stages.json');
    if (fs.existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error(
    'Missing --project=<abs>. Could not find .pipeline/stages.json by walking up from cwd.'
  );
  process.exit(EXIT.PRECHECK);
}

function unionFeatureIds(stages) {
  const plan = stages.stages?.prd_review?.review?.phase_plan;
  if (!Array.isArray(plan)) return [];
  const set = new Set();
  for (const row of plan) {
    for (const fid of row.feature_ids || []) {
      if (fid) set.add(String(fid));
    }
  }
  return [...set].sort();
}

function filterFeatures(ids, single) {
  if (!single) return ids;
  if (!ids.includes(single)) {
    console.error(`Feature ${single} is not in current prd_review.phase_plan union.`);
    return null;
  }
  return [single];
}

function prdReviewPassed(stages) {
  const pr = stages.stages?.prd_review;
  if (!pr) return { ok: false, reason: 'missing stages.prd_review' };
  if (pr.status !== 'completed') return { ok: false, reason: `prd_review.status=${pr.status}` };
  if (pr.outputs?.decision !== 'passed') {
    return { ok: false, reason: `prd_review.outputs.decision=${pr.outputs?.decision}` };
  }
  return { ok: true };
}

function designSpecRel(projectRoot, featureId) {
  return path.join('docs', 'designs', `${featureId}.design.json`);
}

/** 相对 project_root 的 POSIX 风格目录，默认 docs/contracts；见 design3 §4 */
function readContractsDirRel(projectRoot) {
  const def = 'docs/contracts';
  const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(cfgPath)) return def;
  try {
    const j = readJson(cfgPath);
    const p = j?.pipeline?.paths?.contracts_dir;
    if (typeof p !== 'string' || !p.trim()) return def;
    const norm = p.trim().replace(/\\/g, '/').replace(/\/$/, '');
    if (norm.includes('..') || path.isAbsolute(norm)) {
      console.warn('Ignoring pipeline.paths.contracts_dir (must be relative without ..); using docs/contracts');
      return def;
    }
    return norm;
  } catch (_) {
    return def;
  }
}

function resolveContractArtifactPaths(projectRoot, featureId, contractsDirRel) {
  const cdir = contractsDirRel.split('/').join(path.sep);
  const base = path.join(projectRoot, cdir, featureId);
  const pick = (cands) => {
    for (const name of cands) {
      const abs = path.join(base, name);
      if (fs.existsSync(abs)) return `${contractsDirRel}/${featureId}/${name}`.replace(/\\/g, '/');
    }
    return '';
  };
  const types =
    pick([`${featureId}.types.ts`, `${featureId}.types.py`]) ||
    pick([`${featureId}.types.tsx`]);
  const api = pick([`${featureId}.api.yaml`, `${featureId}.api.yml`]);
  const schema = pick([`${featureId}.schema.sql`, `${featureId}.schema.prisma`]);
  const testSpec = pick([
    `${featureId}.test-spec.md`,
    `${featureId}.test-spec.yaml`,
    `${featureId}.test-spec.yml`,
  ]);
  const designSnapshot = pick([`${featureId}.design.snapshot.json`]);
  return { types, api, schema, test_spec: testSpec, design_snapshot: designSnapshot };
}

function ensureContractArtifactsSeed(projectRoot, featureId, contractsDirRel) {
  const cdir = contractsDirRel.split('/').join(path.sep);
  const base = path.join(projectRoot, cdir, featureId);
  fs.mkdirSync(base, { recursive: true });

  const designRel = designSpecRel(projectRoot, featureId);
  const designAbs = path.join(projectRoot, designRel);
  let clientTarget = 'website';
  let designDoc = null;
  if (fs.existsSync(designAbs)) {
    try {
      designDoc = readJson(designAbs);
      if (typeof designDoc.client_target === 'string' && designDoc.client_target.trim()) {
        clientTarget = designDoc.client_target.trim();
      }
    } catch (_) {
      /* keep defaults */
    }
  }

  const typesPy = path.join(base, `${featureId}.types.py`);
  if (!fs.existsSync(typesPy)) {
    fs.writeFileSync(
      typesPy,
      `"""Auto-seeded by ai-design3 register-contract-artifacts."""\n\n` +
        `from dataclasses import dataclass\n\n` +
        `@dataclass\nclass ${featureId.replace(/[^A-Za-z0-9]/g, '_')}Payload:\n` +
        `    status: str = "healthy"\n`,
      'utf8'
    );
  }

  const apiYaml = path.join(base, `${featureId}.api.yaml`);
  if (!fs.existsSync(apiYaml)) {
    const endpoint = featureId.toLowerCase().includes('health') ? '/api/health' : `/api/${featureId.toLowerCase()}`;
    fs.writeFileSync(
      apiYaml,
      `openapi: 3.0.3\n` +
        `info:\n  title: ${featureId} API\n  version: "1.0.0"\n` +
        `paths:\n  ${endpoint}:\n    get:\n      x-smoke: true\n      responses:\n        "200":\n          description: OK\n`,
      'utf8'
    );
  }

  const schemaSql = path.join(base, `${featureId}.schema.sql`);
  if (!fs.existsSync(schemaSql)) {
    const table = `seed_${featureId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    fs.writeFileSync(
      schemaSql,
      `-- Auto-seeded by ai-design3\nCREATE TABLE IF NOT EXISTS ${table} (\n  id INTEGER PRIMARY KEY,\n  status TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\n`,
      'utf8'
    );
  }

  const testSpec = path.join(base, `${featureId}.test-spec.md`);
  if (!fs.existsSync(testSpec)) {
    fs.writeFileSync(
      testSpec,
      `# ${featureId} Test Spec\n\n## Happy Path\n\n- Given service is running\n- When request target endpoint\n- Then response status is 200\n`,
      'utf8'
    );
  }

  const { ensureUiTestSpecYaml } = require('./lib/seed-ui-test-spec.cjs');
  ensureUiTestSpecYaml(base, featureId, clientTarget, designDoc);

  const snapshot = path.join(base, `${featureId}.design.snapshot.json`);
  if (!fs.existsSync(snapshot)) {
    const snap = {
      feature_id: featureId,
      client_target: clientTarget,
      snapshot_version: 1,
      derived_from_spec_path: designRel.split(path.sep).join('/'),
      api_outline: Array.isArray(designDoc?.api_outline) ? designDoc.api_outline : [],
      data_outline: Array.isArray(designDoc?.data_outline) ? designDoc.data_outline : [],
      acceptance: Array.isArray(designDoc?.acceptance) ? designDoc.acceptance : [],
      constraints: Array.isArray(designDoc?.constraints) ? designDoc.constraints : [],
      file_plan: designDoc?.file_plan && typeof designDoc.file_plan === 'object' ? designDoc.file_plan : {},
      shared_changes: Array.isArray(designDoc?.shared_changes) ? designDoc.shared_changes : [],
    };
    fs.writeFileSync(snapshot, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
  }
}

/** design3 §5：从磁盘 design.json 复制进 stages.design.outputs.design_specs[] */
function pickDesignSpecRow(featureId, relFs, doc) {
  const row = {
    feature_id: featureId,
    client_target: doc.client_target,
    spec_path: relFs.split(path.sep).join('/'),
    status: doc.status || 'draft',
    shared_changes: Array.isArray(doc.shared_changes) ? doc.shared_changes : [],
  };
  for (const key of [
    'file_plan',
    'api_outline',
    'data_outline',
    'acceptance',
    'constraints',
    'dependencies',
    'risks',
  ]) {
    if (doc[key] !== undefined && doc[key] !== null) row[key] = doc[key];
  }
  return row;
}

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function readTimeoutSeconds(projectRoot, key) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return 600;
  try {
    const j = readJson(p);
    const v = j?.timeouts?.stages?.[key];
    return typeof v === 'number' && v > 0 ? v : 600;
  } catch (_) {
    return 600;
  }
}

function runWithTimeout(cmd, args, cwd, timeoutMs) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function looksLikeOpenApiDoc(text) {
  const head = text.slice(0, 4000);
  return /\bopenapi\s*:/i.test(head) || /\bswagger\s*:/i.test(head);
}

/** design3 §4 / input-spec §8.13：至少一处路径级 x-smoke（弱校验，避免完全漏配） */
function openApiHasXSmokePathLevel(text) {
  return /^(\s+)x-smoke\s*:/m.test(text);
}

function logDryRunSlice(parsed, slice) {
  if (!parsed.dryRun) return;
  console.log(JSON.stringify({ dry_run: true, subcommand: parsed.cmd, slice }, null, 2));
}

function resetContractStageForForce(stages) {
  stages.stages.contract = stages.stages.contract || {};
  stages.stages.contract.outputs = stages.stages.contract.outputs || {};
  stages.stages.contract.outputs.human_approval = {
    status: 'pending',
    approved_by: '',
    approved_at: null,
    notes: 'reset by --force (contract stage rerun)',
  };
  stages.stages.contract.outputs.timed_out = false;
  stages.stages.contract.outputs.timeout_reason = null;
  stages.stages.contract.validation = stages.stages.contract.validation || {};
  stages.stages.contract.validation.passed = false;
  stages.stages.contract.validation.summary = '';
  stages.stages.contract.validation.checked_at = null;
  const names = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'];
  stages.stages.contract.validation.checks = names.map((name) => ({
    name,
    status: 'pending',
    errors: [],
  }));
  stages.stages.contract.status = 'not_started';
  stages.stages.contract.completed_at = null;
}

function contractBlockedByDesignHumanGate(stages) {
  if (stages.stages.design?.outputs?.needs_human_review === true) {
    return {
      ok: false,
      reason:
        'design.outputs.needs_human_review is true; resolve in design before contract (design3 §3.2)',
    };
  }
  return { ok: true };
}

function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed.cmd || !SUBCOMMANDS.has(parsed.cmd)) {
    console.error(`Usage: node scripts/run.cjs <subcommand> --project=<abs> [...]\nSubcommands: ${[...SUBCOMMANDS].join(', ')}`);
    process.exit(EXIT.PRECHECK);
  }

  const root = resolveProjectRoot(parsed);
  const skRoot = skillRoot();
  let stages;
  try {
    stages = readStages(root);
  } catch (e) {
    console.error(e.message);
    process.exit(EXIT.PRECHECK);
  }

  const finish = (code, extra = {}) => {
    appendSessionLog(root, { subcommand: parsed.cmd, exit_code: code, ...extra });
    process.exit(code);
  };

  const validators = () => createValidators(skRoot);

  if (parsed.cmd === 'preflight') {
    if (!stages._schema || stages._schema.name !== 'skill-v3-stages') {
      console.warn('Warning: stages._schema.name is not skill-v3-stages (continuing).');
    }
    const pr = prdReviewPassed(stages);
    if (!pr.ok) {
      console.error(`preflight failed: ${pr.reason}`);
      finish(EXIT.PRECHECK, { reason: pr.reason });
    }
    const prdSpec = path.join(root, 'docs', 'prd-spec.md');
    if (!fs.existsSync(prdSpec)) {
      console.error(`preflight failed: missing ${prdSpec}`);
      finish(EXIT.PRECHECK, { reason: 'missing prd-spec.md' });
    }
    const scan = scanProjectConfigKeys(root);
    if (!scan.ok) {
      console.error('preflight failed: config key scan');
      for (const line of scan.errors) console.error(`  ${line}`);
      finish(EXIT.PRECHECK, { reason: 'config_secret_scan' });
    }
    console.log('preflight ok');
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'list-design-candidates') {
    const ids = unionFeatureIds(stages);
    console.log(JSON.stringify(ids, null, 2));
    finish(EXIT.OK);
  }

  const v = validators();

  if (parsed.cmd === 'scan-design-style') {
    const pr = prdReviewPassed(stages);
    if (!pr.ok) {
      console.error(`scan-design-style blocked: ${pr.reason}`);
      finish(EXIT.PRECHECK, { reason: pr.reason });
    }
    const ids = filterFeatures(unionFeatureIds(stages), parsed.feature);
    if (!ids) finish(EXIT.PRECHECK, { reason: 'feature_not_in_phase_plan' });
    if (!ids.length) {
      console.error('scan-design-style: no feature_ids in prd_review.review.phase_plan');
      finish(EXIT.PRECHECK, { reason: 'empty_feature_candidates' });
    }
    stages.stages.design = stages.stages.design || {};
    stages.stages.design.validation = stages.stages.design.validation || {};
    let warn = stages.stages.design.validation.warnings || [];
    warn = warn.filter((w) => {
      if (typeof w !== 'string') return true;
      return !ids.some((fid) => w.startsWith(`style-scan ${fid}:`));
    });
    const outPaths = [];
    for (const fid of ids) {
      const relDesign = designSpecRel(root, fid);
      const absDesign = path.join(root, relDesign);
      if (!fs.existsSync(absDesign)) {
        console.error(`scan-design-style: missing ${relDesign}`);
        finish(EXIT.PRECHECK, { reason: 'missing_design_file', feature_id: fid });
      }
      let doc;
      try {
        doc = readJson(absDesign);
      } catch (e) {
        console.error(`scan-design-style: ${e.message}`);
        finish(EXIT.PRECHECK, { reason: 'design_read_failed', feature_id: fid });
      }
      const ct = doc.client_target || 'website';
      const scan = runStyleScan({
        projectRoot: root,
        clientTarget: ct,
        featureId: fid,
        dryRun: parsed.dryRun,
      });
      if (!scan.ok) {
        console.error(`scan-design-style failed: ${scan.reason}`);
        finish(EXIT.PRECHECK, { reason: 'style_scan_failed', feature_id: fid });
      }
      outPaths.push(scan.relOut);
      warn.push(`style-scan ${fid}: ${scan.relOut} (files=${scan.payload.total_files_scanned})`);
      if (!parsed.dryRun) {
        doc.style_scan_ref = scan.relOut;
        fs.writeFileSync(absDesign, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      }
    }
    stages.stages.design.validation.warnings = warn;
    logDryRunSlice(parsed, { scan_design_style: { outputs: outPaths, warnings: warn.slice(-ids.length) } });
    writeStages(root, stages, parsed.dryRun);
    console.log(JSON.stringify({ style_scan_paths: outPaths }, null, 2));
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'lib-research') {
    const pr = prdReviewPassed(stages);
    if (!pr.ok) {
      console.error(`lib-research blocked: ${pr.reason}`);
      finish(EXIT.PRECHECK, { reason: pr.reason });
    }
    const ids = filterFeatures(unionFeatureIds(stages), parsed.feature);
    if (!ids) finish(EXIT.PRECHECK, { reason: 'feature_not_in_phase_plan' });
    if (!ids.length) {
      console.error('lib-research: no feature_ids in prd_review.review.phase_plan');
      finish(EXIT.PRECHECK, { reason: 'empty_feature_candidates' });
    }
    const skRoot = skillRoot();
    const summary = [];
    for (const fid of ids) {
      const relDesign = designSpecRel(root, fid);
      const absDesign = path.join(root, relDesign);
      if (!fs.existsSync(absDesign)) {
        console.error(`lib-research: missing ${relDesign}`);
        finish(EXIT.PRECHECK, { reason: 'missing_design_file', feature_id: fid });
      }
      const outRel = path.join('docs', 'designs', `${fid}.lib-research.json`).split(path.sep).join('/');
      const absOut = path.join(root, 'docs', 'designs', `${fid}.lib-research.json`);
      let featureName = '';
      try {
        const dj = readJson(absDesign);
        featureName = dj.title || dj.name || '';
      } catch (_) {
        /* ignore */
      }
      const lr = runLibResearch({
        projectRoot: root,
        featureId: fid,
        featureName,
        designSpecPath: absDesign,
        outputPath: absOut,
        force: parsed.force || parsed.forceRerun === 'design',
        skillRoot: skRoot,
        dryRun: parsed.dryRun,
        validateJson,
        validateLibResearch: v.validateLibResearch,
      });
      summary.push({ feature_id: fid, status: lr.status, reason: lr.reason || null });
      if (lr.status === 'failed' || !lr.ok) {
        console.error(`lib-research failed for ${fid}: ${lr.reason || 'unknown'}`);
        finish(EXIT.PRECHECK, { reason: lr.reason, feature_id: fid });
      }
    }
    logDryRunSlice(parsed, { lib_research: summary });
    writeStages(root, stages, parsed.dryRun);
    console.log(JSON.stringify({ lib_research: summary }, null, 2));
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'validate-design') {
    const pr = prdReviewPassed(stages);
    if (!pr.ok) {
      console.error(`validate-design blocked: ${pr.reason}`);
      finish(EXIT.PRECHECK, { reason: pr.reason });
    }
    const ids = filterFeatures(unionFeatureIds(stages), parsed.feature);
    if (!ids) finish(EXIT.PRECHECK, { reason: 'feature_not_in_phase_plan' });
    if (!ids.length) {
      console.error('validate-design: no feature_ids in prd_review.review.phase_plan');
      finish(EXIT.PRECHECK, { reason: 'empty_feature_candidates' });
    }
    const designRerun = parsed.force || parsed.forceRerun === 'design';
    if (
      !parsed.dryRun &&
      !designRerun &&
      stages.stages.design?.status === 'completed' &&
      stages.stages.design?.validation?.passed === true &&
      stages.stages.design?.inputs?.summary_hash
    ) {
      const h = computeDesignInputHash(root, ids);
      if (h === stages.stages.design.inputs.summary_hash) {
        console.log('validate-design: skip (design.inputs.summary_hash unchanged)');
        finish(EXIT.OK, { skipped: true });
      }
    }
    if (!parsed.dryRun) {
      stages = featureStages.backfillFeatureStages(stages);
      const begun = featureStages.beginStageForFeatures(stages, {
        stageKey: 'design',
        featureIds: ids,
        skill: 'ai-design3',
        message: `validate-design 开始校验 ${ids.length} 个 feature 的设计规格`,
      });
      stages = begun.doc;
      featureStages.appendStageLog(root, {
        skill: 'ai-design3',
        stageKey: 'design',
        featureIds: ids,
        message: `design 阶段：${begun.marked.length} 个 feature 已进入处理中`,
        detail: ids.join(','),
      });
    }

    const errors = [];
    const now = isoNow();
    let anyRisks = false;
    for (const fid of ids) {
      if (!parsed.dryRun) {
        stages = featureStages.markFeatureStage(stages, 'design', fid, 'running', {
          message: `正在校验 ${fid} 的 design.json`,
        });
      }
      const decl = featureDeclaredInLists(root, fid);
      if (!decl.ok) {
        errors.push(
          `feature_list: ${fid}: ${decl.reason}${decl.searched ? ` (searched: ${decl.searched.join(', ')})` : ''}`
        );
      }
      const rel = designSpecRel(root, fid);
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) {
        errors.push(`missing design spec: ${rel}`);
        continue;
      }
      let doc;
      try {
        doc = readJson(abs);
      } catch (e) {
        errors.push(`${rel}: invalid JSON (${e.message})`);
        continue;
      }
      const r = validateJson(v.validateDesignSpec, doc, rel);
      if (!r.ok) errors.push(...r.errors);
      if (doc.feature_id && doc.feature_id !== fid) {
        errors.push(`${rel}: feature_id mismatch file name (expected ${fid})`);
      }
      if (Array.isArray(doc.risks) && doc.risks.length) anyRisks = true;
    }
    stages.stages.design = stages.stages.design || {};
    stages.stages.design.outputs = stages.stages.design.outputs || {};
    stages.stages.design.outputs.needs_human_review = errors.length === 0 && anyRisks;
    stages.stages.design.validation = stages.stages.design.validation || {};
    stages.stages.design.validation.checked_at = now;
    stages.stages.design.validation.summary = errors.length ? errors.join('; ') : 'design specs OK';
    stages.stages.design.validation.passed = errors.length === 0;
    if (errors.length) {
      stages.stages.design.status = 'failed';
      stages.stages.design.blocking_issues = errors;
      if (!parsed.dryRun) {
        stages = featureStages.markFeaturesFailed(stages, 'design', ids, {
          message: `校验失败：${errors.slice(0, 3).join('; ')}`,
        });
        featureStages.appendStageLog(root, {
          skill: 'ai-design3',
          stageKey: 'design',
          featureIds: ids,
          level: 'error',
          message: `design 校验未通过（${errors.length} 项问题）`,
        });
      }
    } else {
      stages.stages.design.blocking_issues = [];
      if (!parsed.dryRun) {
        stages = featureStages.markFeaturesCompleted(stages, 'design', ids, {
          message: 'design 规格校验通过',
        });
        const gitCode = syncGitForFeatureIds(root, 'design', ids);
        if (gitCode !== 0) finish(gitCode, { reason: 'git_sync_failed' });
        featureStages.appendStageLog(root, {
          skill: 'ai-design3',
          stageKey: 'design',
          featureIds: ids,
          message: 'design 校验全部通过',
        });
      }
    }
    logDryRunSlice(parsed, {
      design: {
        validation: stages.stages.design.validation,
        status: stages.stages.design.status,
        blocking_issues: stages.stages.design.blocking_issues,
        outputs: { needs_human_review: stages.stages.design.outputs.needs_human_review },
      },
    });
    writeStages(root, stages, parsed.dryRun);
    if (errors.length) {
      const missing = errors.some(
        (e) => e.startsWith('missing') || e.startsWith('feature_list:') || e.includes('no docs/*/feature_list')
      );
      finish(missing ? EXIT.PRECHECK : EXIT.QUALITY, { blocking_issues: errors.length });
    }
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'write-design') {
    const pr = prdReviewPassed(stages);
    if (!pr.ok) {
      console.error(`write-design blocked: ${pr.reason}`);
      finish(EXIT.PRECHECK, { reason: pr.reason });
    }
    const designRerun = parsed.force || parsed.forceRerun === 'design';
    if (!stages.stages.design?.validation?.passed && !designRerun) {
      console.error('write-design blocked: run validate-design successfully first (or --force).');
      finish(EXIT.PRECHECK, { reason: 'validate_design_required' });
    }
    if (
      !designRerun &&
      stages.stages.design?.status === 'completed' &&
      stages.stages.design?.validation?.passed
    ) {
      console.log('write-design: design already completed; use --force or --force-rerun=design to rewrite.');
      finish(EXIT.OK, { skipped: true });
    }
    const ids = filterFeatures(unionFeatureIds(stages), parsed.feature);
    if (!ids) finish(EXIT.PRECHECK, { reason: 'feature_not_in_phase_plan' });
    if (!ids.length) finish(EXIT.PRECHECK, { reason: 'empty_feature_candidates' });
    const design_specs = [];
    for (const fid of ids) {
      const rel = designSpecRel(root, fid);
      const abs = path.join(root, rel);
      let doc;
      try {
        doc = readJson(abs);
      } catch (e) {
        console.error(`write-design: cannot read ${rel}: ${e.message}`);
        finish(EXIT.PRECHECK, { reason: 'design_read_failed', path: rel });
      }
      design_specs.push(pickDesignSpecRow(fid, rel, doc));
    }
    const t0 = Date.now();
    stages.stages.design.outputs = stages.stages.design.outputs || {};
    stages.stages.design.outputs.design_specs = design_specs;
    stages.stages.design.outputs.duration_ms = Date.now() - t0;
    stages.stages.design.outputs.timed_out = false;
    stages.stages.design.outputs.timeout_reason = null;
    stages.stages.design.status = 'completed';
    stages.stages.design.completed_at = isoNow();
    stages.stages.design.validation = stages.stages.design.validation || {};
    stages.stages.design.validation.passed = true;
    stages.stages.design.validation.summary = 'completed via write-design';
    logDryRunSlice(parsed, {
      design: {
        status: stages.stages.design.status,
        outputs: { design_specs, duration_ms: stages.stages.design.outputs.duration_ms },
      },
    });
    writeStages(root, stages, parsed.dryRun);
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'hash-design-inputs') {
    const pr = prdReviewPassed(stages);
    if (!pr.ok) finish(EXIT.PRECHECK, { reason: pr.reason });
    const ids = filterFeatures(unionFeatureIds(stages), parsed.feature);
    if (!ids) finish(EXIT.PRECHECK, { reason: 'feature_not_in_phase_plan' });
    if (!ids.length) finish(EXIT.PRECHECK, { reason: 'empty_feature_candidates' });
    const hash = computeDesignInputHash(root, ids);
    stages.stages.design = stages.stages.design || {};
    stages.stages.design.inputs = stages.stages.design.inputs || {};
    stages.stages.design.inputs.summary_hash = hash;
    logDryRunSlice(parsed, { design: { inputs: { summary_hash: hash } } });
    writeStages(root, stages, parsed.dryRun);
    console.log(hash);
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'register-contract-artifacts') {
    if (parsed.force || parsed.forceRerun === 'contract') resetContractStageForForce(stages);
    const pr = prdReviewPassed(stages);
    if (!pr.ok) finish(EXIT.PRECHECK, { reason: pr.reason });
    if (stages.stages.design?.status !== 'completed' && !parsed.force) {
      console.error('register-contract-artifacts: design not completed');
      finish(EXIT.PRECHECK, { reason: 'design_not_completed' });
    }
    const gate = contractBlockedByDesignHumanGate(stages);
    if (!gate.ok && !parsed.force) {
      console.error(`register-contract-artifacts blocked: ${gate.reason}`);
      finish(EXIT.PRECHECK, { reason: 'design_human_gate' });
    }
    const ids = filterFeatures(unionFeatureIds(stages), parsed.feature);
    if (!ids) finish(EXIT.PRECHECK, { reason: 'feature_not_in_phase_plan' });
    if (!ids.length) finish(EXIT.PRECHECK, { reason: 'empty_feature_candidates' });
    const contractsDirRel = readContractsDirRel(root);
    const artifacts = [];
    for (const fid of ids) {
      ensureContractArtifactsSeed(root, fid, contractsDirRel);
      const paths = resolveContractArtifactPaths(root, fid, contractsDirRel);
      const row = { feature_id: fid, ...paths };
      const r = validateJson(v.validateArtifactItem, row, `artifacts[${fid}]`);
      if (!r.ok) {
        console.error(r.errors.join('\n'));
        finish(EXIT.PRECHECK, { reason: 'artifact_row_invalid', feature_id: fid });
      }
      artifacts.push(row);
    }
    stages.stages.contract = stages.stages.contract || {};
    stages.stages.contract.outputs = stages.stages.contract.outputs || {};
    stages.stages.contract.outputs.artifacts = artifacts;
    if (!parsed.dryRun) {
      featureStages.appendStageLog(root, {
        skill: 'ai-design3',
        stageKey: 'contract',
        featureIds: ids,
        message: `register-contract-artifacts 完成（${artifacts.length} 项）`,
      });
    }
    logDryRunSlice(parsed, { contract: { outputs: { artifacts } } });
    writeStages(root, stages, parsed.dryRun);
    console.log(JSON.stringify(artifacts, null, 2));
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'validate-contract') {
    const contractRerun = parsed.force || parsed.forceRerun === 'contract';
    if (contractRerun) resetContractStageForForce(stages);
    const ids = filterFeatures(unionFeatureIds(stages), parsed.feature);
    if (!ids) finish(EXIT.PRECHECK, { reason: 'feature_not_in_phase_plan' });
    if (!parsed.dryRun) {
      stages = featureStages.backfillFeatureStages(stages);
      const contractBegun = featureStages.beginStageForFeatures(stages, {
        stageKey: 'contract',
        featureIds: ids,
        skill: 'ai-design3',
        message: `validate-contract 开始（${ids.length} 个 feature）`,
      });
      stages = contractBegun.doc;
      writeStages(root, stages, false);
      featureStages.appendStageLog(root, {
        skill: 'ai-design3',
        stageKey: 'contract',
        featureIds: ids,
        message: 'contract 机器校验开始',
      });
    }
    if (stages.stages.design?.status !== 'completed' || !stages.stages.design?.validation?.passed) {
      if (!parsed.force) {
        console.error('validate-contract blocked: design not completed');
        finish(EXIT.PRECHECK, { reason: 'design_not_completed' });
      }
    }
    const gate = contractBlockedByDesignHumanGate(stages);
    if (!gate.ok && !parsed.force) {
      console.error(`validate-contract blocked: ${gate.reason}`);
      finish(EXIT.PRECHECK, { reason: 'design_human_gate' });
    }
    const artifacts = stages.stages.contract?.outputs?.artifacts || [];
    if (!artifacts.length) {
      console.error('validate-contract: no artifacts; run register-contract-artifacts');
      finish(EXIT.PRECHECK, { reason: 'no_artifacts' });
    }
    if (
      !parsed.dryRun &&
      !contractRerun &&
      stages.stages.contract?.status === 'completed' &&
      stages.stages.contract?.validation?.passed === true &&
      ['approved', 'not_required'].includes(stages.stages.contract?.outputs?.human_approval?.status)
    ) {
      const prev = stages.stages.contract?.inputs?.summary_hash;
      if (prev) {
        const h = computeContractInputHash(root, artifacts);
        if (h === prev) {
          console.log('validate-contract: skip (contract.inputs.summary_hash unchanged)');
          finish(EXIT.OK, { skipped: true });
        }
      }
    }
    const timeoutMs = readTimeoutSeconds(root, 'contract_s') * 1000;
    const t0 = Date.now();
    stages.stages.contract.outputs = stages.stages.contract.outputs || {};
    stages.stages.contract.outputs.timed_out = false;
    stages.stages.contract.outputs.timeout_reason = null;

    const checkNames = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'];
    let anyMissing = false;
    let anyFailed = false;
    const agg = Object.fromEntries(
      checkNames.map((name) => [name, { name, status: 'passed', errors: [] }])
    );
    const bump = (name, status, err) => {
      const c = agg[name];
      if (status === 'failed') {
        c.status = 'failed';
        if (err) c.errors.push(err);
        anyFailed = true;
      } else if (status === 'skipped' && c.status !== 'failed') {
        c.status = 'skipped';
        if (err) c.errors.push(err);
      } else if (status === 'pending' && c.status === 'passed') {
        c.status = 'pending';
      }
    };

    const anyTsArtifact = artifacts.some((a) => {
      if (ids.length && !ids.includes(a.feature_id)) return false;
      const t = a.types || '';
      return t.endsWith('.ts') || t.endsWith('.tsx');
    });
    const tsconfigPath = path.join(root, 'tsconfig.json');
    if (anyTsArtifact && fs.existsSync(tsconfigPath)) {
      const tr = runWithTimeout('npx', ['tsc', '--noEmit'], root, timeoutMs);
      if (tr.error && tr.error.code === 'ETIMEDOUT') {
        stages.stages.contract.outputs.timed_out = true;
        stages.stages.contract.outputs.timeout_reason = 'tsc --noEmit timed out';
        stages.stages.contract.outputs.duration_ms = timeoutMs;
        const flatChecks = checkNames.map((n) => agg[n]);
        stages.stages.contract.validation = stages.stages.contract.validation || {};
        stages.stages.contract.validation.checks = flatChecks;
        stages.stages.contract.validation.passed = false;
        logDryRunSlice(parsed, { contract: { outputs: stages.stages.contract.outputs, validation: stages.stages.contract.validation } });
        writeStages(root, stages, parsed.dryRun);
        finish(EXIT.TIMEOUT, { timed_out: true, tool: 'tsc' });
      }
      if (tr.status !== 0) {
        const msg = (tr.stderr || tr.stdout || tr.error?.message || 'tsc failed').trim().slice(0, 2000);
        bump('types', 'failed', `project tsc --noEmit: ${msg}`);
      }
    } else if (anyTsArtifact) {
      bump('types', 'skipped', 'no tsconfig.json at project root; types file existence only');
    }

    for (const art of artifacts) {
      if (ids.length && !ids.includes(art.feature_id)) continue;
      const prefix = `[${art.feature_id}]`;
      const req = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'];
      for (const k of req) {
        const rel = art[k];
        if (!rel) {
          bump(k, 'failed', `${prefix} path empty`);
          anyMissing = true;
          continue;
        }
        const abs = path.join(root, ...rel.split('/'));
        if (!fs.existsSync(abs)) {
          bump(k, 'failed', `${prefix} missing file: ${rel}`);
          anyMissing = true;
          continue;
        }
        if (k === 'design_snapshot') {
          let snap;
          try {
            snap = readJson(abs);
          } catch (e) {
            bump(k, 'failed', `${prefix} ${e.message}`);
            continue;
          }
          const vr = validateJson(v.validateDesignSnapshot, snap, rel);
          if (!vr.ok) vr.errors.forEach((e) => bump(k, 'failed', `${prefix} ${e}`));
        } else if (k === 'api') {
          const text = fs.readFileSync(abs, 'utf8');
          if (!looksLikeOpenApiDoc(text)) {
            bump(k, 'failed', `${prefix} api file does not look like OpenAPI`);
          } else {
            const swagger = runWithTimeout('swagger-cli', ['validate', abs], root, timeoutMs);
            if (swagger.status === 0) {
              if (!openApiHasXSmokePathLevel(text)) {
                agg.api.errors.push(
                  `${prefix} recommend path-level x-smoke for ai-publish-dev3 (design3 §4)`
                );
              }
            } else if (swagger.error && swagger.error.code === 'ETIMEDOUT') {
              stages.stages.contract.outputs.timed_out = true;
              stages.stages.contract.outputs.timeout_reason = 'swagger-cli validate timed out';
              stages.stages.contract.outputs.duration_ms = timeoutMs;
              const flatChecks = checkNames.map((n) => agg[n]);
              stages.stages.contract.validation = stages.stages.contract.validation || {};
              stages.stages.contract.validation.checks = flatChecks;
              stages.stages.contract.validation.passed = false;
              logDryRunSlice(parsed, { contract: { outputs: stages.stages.contract.outputs } });
              writeStages(root, stages, parsed.dryRun);
              finish(EXIT.TIMEOUT, { timed_out: true, tool: 'swagger-cli' });
            } else if (swagger.error && swagger.error.code === 'ENOENT') {
              bump(k, 'skipped', `${prefix} swagger-cli not in PATH; OpenAPI header heuristic only`);
              if (!openApiHasXSmokePathLevel(text)) {
                agg.api.errors.push(`${prefix} recommend path-level x-smoke (design3 §4)`);
              }
            } else if (swagger.status !== 0) {
              const msg = (swagger.stderr || swagger.stdout || '').trim() || swagger.error?.message;
              bump(k, 'failed', `${prefix} swagger-cli: ${msg}`);
            }
          }
        } else if (k === 'types') {
          if (agg.types.status === 'failed' || agg.types.status === 'skipped') continue;
          const tpath = art.types || '';
          if (tpath.endsWith('.py')) continue;
          bump(k, 'passed', null);
        } else if (k === 'schema') {
          const body = fs.readFileSync(abs, 'utf8').trim();
          if (!body) bump(k, 'failed', `${prefix} empty schema file`);
          else if (rel.endsWith('.sql')) {
            const sl = runWithTimeout('sql-lint', ['-f', abs], root, timeoutMs);
            if (sl.error && sl.error.code === 'ENOENT') {
              /* optional tool (design3 §6.2) */
            } else if (sl.error && sl.error.code === 'ETIMEDOUT') {
              stages.stages.contract.outputs.timed_out = true;
              stages.stages.contract.outputs.timeout_reason = 'sql-lint timed out';
              stages.stages.contract.outputs.duration_ms = timeoutMs;
              const flatChecks = checkNames.map((n) => agg[n]);
              stages.stages.contract.validation = stages.stages.contract.validation || {};
              stages.stages.contract.validation.checks = flatChecks;
              stages.stages.contract.validation.passed = false;
              logDryRunSlice(parsed, { contract: { outputs: stages.stages.contract.outputs } });
              writeStages(root, stages, parsed.dryRun);
              finish(EXIT.TIMEOUT, { timed_out: true, tool: 'sql-lint' });
            } else if (sl.status !== 0) {
              const msg = (sl.stderr || sl.stdout || sl.error?.message || 'sql-lint failed').trim().slice(0, 1500);
              bump(k, 'failed', `${prefix} sql-lint: ${msg}`);
            }
          }
        } else if (k === 'test_spec') {
          const body = fs.readFileSync(abs, 'utf8').trim();
          if (!body) {
            bump(k, 'failed', `${prefix} empty test_spec`);
          } else if (rel.endsWith('.md')) {
            if (!/^#+\s/m.test(body)) {
              bump(k, 'failed', `${prefix} test_spec markdown should contain at least one heading`);
            }
          } else if (rel.endsWith('.yaml') || rel.endsWith('.yml')) {
            try {
              YAML.parse(body);
            } catch (e) {
              bump(k, 'failed', `${prefix} invalid YAML: ${e.message}`);
            }
            const { validateTestSpecUiScenariosFile } = require('./lib/validate-test-spec-ui.cjs');
            const uiVal = validateTestSpecUiScenariosFile(abs, prefix);
            if (!uiVal.ok) {
              for (const err of uiVal.errors.slice(0, 20)) {
                bump(k, 'failed', err);
              }
            }
          } else if (rel.endsWith('.json')) {
            const { validateTestSpecUiScenariosFile } = require('./lib/validate-test-spec-ui.cjs');
            const uiVal = validateTestSpecUiScenariosFile(abs, prefix);
            if (!uiVal.ok) {
              for (const err of uiVal.errors.slice(0, 20)) {
                bump(k, 'failed', err);
              }
            }
          }
        }
      }
    }
    const relevant = artifacts.filter((a) => !ids.length || ids.includes(a.feature_id));
    const hasPyOnly =
      relevant.length > 0 &&
      relevant.every((a) => {
        const t = a.types || '';
        return t && t.endsWith('.py');
      });
    if (!anyTsArtifact && hasPyOnly) {
      bump('types', 'skipped', 'Python-only types: no tsc check in ai-design3');
    }
    const flatChecks = checkNames.map((n) => agg[n]);
    stages.stages.contract = stages.stages.contract || {};
    stages.stages.contract.validation = stages.stages.contract.validation || {};
    stages.stages.contract.validation.checked_at = isoNow();
    stages.stages.contract.validation.checks = flatChecks;
    const anySkipped = flatChecks.some((c) => c.status === 'skipped');
    stages.stages.contract.validation.passed =
      !anyMissing && !anyFailed && !stages.stages.contract.outputs.timed_out;
    stages.stages.contract.validation.summary =
      anyFailed || anyMissing
        ? 'contract validation failed'
        : anySkipped
          ? 'contract validation passed with skipped checks (see errors arrays for warnings)'
          : 'contract validation passed';
    if (stages.stages.contract.validation.passed) {
      const ha0 = stages.stages.contract.outputs?.human_approval?.status;
      if (ha0 === 'approved' || ha0 === 'not_required') {
        stages.stages.contract.status = 'completed';
        stages.stages.contract.completed_at = isoNow();
      } else {
        stages.stages.contract.status = 'blocked';
      }
    } else {
      stages.stages.contract.status = 'failed';
    }
    if (!stages.stages.contract.outputs.timed_out) {
      stages.stages.contract.outputs.duration_ms = Date.now() - t0;
    }
    logDryRunSlice(parsed, {
      contract: { validation: stages.stages.contract.validation, status: stages.stages.contract.status },
    });
    writeStages(root, stages, parsed.dryRun);
    if (
      !parsed.dryRun &&
      stages.stages.contract.status === 'completed' &&
      stages.stages.contract.validation?.passed
    ) {
      const syncIds = [
        ...new Set(
          (artifacts || [])
            .map((a) => a.feature_id)
            .filter((fid) => !ids.length || ids.includes(fid))
        ),
      ];
      const gitCode = syncGitForFeatureIds(root, 'contract', syncIds);
      if (gitCode !== 0) finish(gitCode, { reason: 'git_sync_failed' });
    }
    if (stages.stages.contract.outputs.timed_out) finish(EXIT.TIMEOUT, { timed_out: true });
    if (anyMissing) finish(EXIT.PRECHECK, { reason: 'missing_artifact_files' });
    if (anyFailed) finish(EXIT.QUALITY, { reason: 'contract_checks_failed' });
    finish(EXIT.OK);
  }

  function touchHumanApproval(status, extra) {
    stages.stages.contract = stages.stages.contract || {};
    stages.stages.contract.outputs = stages.stages.contract.outputs || {};
    stages.stages.contract.outputs.human_approval = {
      status,
      approved_by: extra.approved_by ?? '',
      approved_at: extra.approved_at ?? null,
      notes: extra.notes ?? '',
    };
    logDryRunSlice(parsed, {
      contract: { outputs: { human_approval: stages.stages.contract.outputs.human_approval } },
    });
    writeStages(root, stages, parsed.dryRun);
  }

  if (parsed.cmd === 'approve-contract') {
    const by = parsed.approvedBy || process.env.USER || process.env.USERNAME || '';
    touchHumanApproval('approved', {
      approved_by: by,
      approved_at: isoNow(),
      notes: parsed.notes != null ? parsed.notes : '',
    });
    if (stages.stages.contract.validation?.passed) {
      stages.stages.contract.status = 'completed';
      stages.stages.contract.completed_at = isoNow();
    } else {
      stages.stages.contract.status = 'blocked';
    }
    logDryRunSlice(parsed, {
      contract: { status: stages.stages.contract.status, outputs: { human_approval: stages.stages.contract.outputs.human_approval } },
    });
    writeStages(root, stages, parsed.dryRun);
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'reject-contract') {
    if (parsed.notes == null || String(parsed.notes).trim() === '') {
      console.error('reject-contract requires --notes=<text>');
      finish(EXIT.PRECHECK, { reason: 'missing_notes' });
    }
    touchHumanApproval('rejected', { notes: parsed.notes });
    stages.stages.contract.status = 'failed';
    logDryRunSlice(parsed, { contract: { status: 'failed' } });
    writeStages(root, stages, parsed.dryRun);
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'mark-contract-not-required') {
    touchHumanApproval('not_required', { notes: parsed.notes != null ? parsed.notes : '' });
    if (stages.stages.contract.validation?.passed) {
      stages.stages.contract.status = 'completed';
      stages.stages.contract.completed_at = isoNow();
    } else {
      stages.stages.contract.status = 'blocked';
    }
    logDryRunSlice(parsed, { contract: { status: stages.stages.contract.status } });
    writeStages(root, stages, parsed.dryRun);
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'hash-contract-inputs') {
    const arts = stages.stages.contract?.outputs?.artifacts || [];
    const hash = computeContractInputHash(root, arts);
    stages.stages.contract = stages.stages.contract || {};
    stages.stages.contract.inputs = stages.stages.contract.inputs || {};
    stages.stages.contract.inputs.summary_hash = hash;
    logDryRunSlice(parsed, { contract: { inputs: { summary_hash: hash } } });
    writeStages(root, stages, parsed.dryRun);
    console.log(hash);
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'validate-design-review') {
    const drIds = filterFeatures(unionFeatureIds(stages), parsed.feature) || [];
    if (!parsed.dryRun && drIds.length) {
      stages = featureStages.backfillFeatureStages(stages);
      const drBegun = featureStages.beginStageForFeatures(stages, {
        stageKey: 'design_review',
        featureIds: drIds,
        skill: 'ai-design3',
        message: 'validate-design-review 开始',
      });
      stages = drBegun.doc;
      writeStages(root, stages, false);
      featureStages.appendStageLog(root, {
        skill: 'ai-design3',
        stageKey: 'design_review',
        featureIds: drIds,
        message: 'design-review 对齐校验开始',
      });
    }
    const ha = stages.stages.contract?.outputs?.human_approval?.status;
    if (ha !== 'approved' && ha !== 'not_required') {
      console.error(`validate-design-review blocked: human_approval.status=${ha}`);
      finish(EXIT.PRECHECK, { reason: 'human_approval_not_ready', human_approval: ha });
    }
    if (!stages.stages.contract?.validation?.passed) {
      console.error('validate-design-review blocked: contract.validation.passed is false');
      finish(EXIT.PRECHECK, { reason: 'contract_validation_failed' });
    }
    if (stages.stages.contract?.status !== 'completed' && !(parsed.force || parsed.forceRerun === 'contract')) {
      console.error('validate-design-review blocked: contract.status is not completed');
      finish(EXIT.PRECHECK, { reason: 'contract_not_completed' });
    }
    const gaps = stages.stages.design_review?.outputs?.gaps;
    let blocking = 0;
    if (Array.isArray(gaps)) {
      for (const g of gaps) {
        if (g && (g.blocking === true || g.severity === 'blocking')) blocking += 1;
      }
    }
    const arts = stages.stages.contract?.outputs?.artifacts || [];
    const errors = [];
    for (const art of arts) {
      const snapRel = art.design_snapshot;
      if (!snapRel) {
        errors.push(`[${art.feature_id}] missing design_snapshot path`);
        continue;
      }
      const snapAbs = path.join(root, ...snapRel.split('/'));
      let snap;
      try {
        snap = readJson(snapAbs);
      } catch (e) {
        errors.push(`${snapRel}: ${e.message}`);
        continue;
      }
      const vr = validateJson(v.validateDesignSnapshot, snap, snapRel);
      if (!vr.ok) errors.push(...vr.errors);
      const spec = stages.stages.design?.outputs?.design_specs?.find((d) => d.feature_id === art.feature_id);
      if (spec && snap.feature_id && spec.feature_id && snap.feature_id !== spec.feature_id) {
        errors.push(`snapshot/design_specs feature_id mismatch for ${art.feature_id}`);
      }
      if (spec && snap.client_target && spec.client_target && snap.client_target !== spec.client_target) {
        errors.push(`snapshot/design_specs client_target mismatch for ${art.feature_id}`);
      }
    }
    if (blocking > 0) errors.push(`blocking_gaps_count=${blocking}`);
    stages.stages.design_review = stages.stages.design_review || {};
    stages.stages.design_review.validation = stages.stages.design_review.validation || {};
    stages.stages.design_review.validation.checked_at = isoNow();
    stages.stages.design_review.validation.blocking_gaps_count = blocking;
    stages.stages.design_review.validation.passed = errors.length === 0 && blocking === 0;
    stages.stages.design_review.validation.summary = errors.length ? errors.join('; ') : 'design-review checks OK';
    if (stages.stages.design_review.validation.passed) {
      stages.stages.design_review.outputs = stages.stages.design_review.outputs || {};
      if (!String(stages.stages.design_review.outputs.alignment_summary || '').trim()) {
        stages.stages.design_review.outputs.alignment_summary = stages.stages.design_review.validation.summary;
      }
    }
    if (!stages.stages.design_review.validation.passed) {
      stages.stages.design_review.status = 'failed';
    }
    if (!parsed.dryRun) {
      featureStages.appendStageLog(root, {
        skill: 'ai-design3',
        stageKey: 'design_review',
        featureIds: drIds,
        level: errors.length || blocking > 0 ? 'error' : 'info',
        message:
          errors.length || blocking > 0
            ? `design-review 校验未通过（${errors.length} 项）`
            : 'design-review 校验通过',
      });
    }
    logDryRunSlice(parsed, {
      design_review: { validation: stages.stages.design_review.validation, status: stages.stages.design_review.status },
    });
    writeStages(root, stages, parsed.dryRun);
    if (errors.length || blocking > 0) finish(EXIT.QUALITY, { blocking_gaps_count: blocking });
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'write-design-review') {
    const drRerun = parsed.force || parsed.forceRerun === 'design_review';
    if (!stages.stages.design_review?.validation?.passed && !drRerun) {
      console.error('write-design-review blocked: validate-design-review first');
      finish(EXIT.PRECHECK, { reason: 'validate_design_review_required' });
    }
    const t0 = Date.now();
    stages.stages.design_review.outputs = stages.stages.design_review.outputs || {};
    stages.stages.design_review.outputs.decision = 'passed';
    stages.stages.design_review.outputs.can_enter_codegen = true;
    stages.stages.design_review.outputs.duration_ms = Date.now() - t0;
    stages.stages.design_review.outputs.timed_out = false;
    stages.stages.design_review.outputs.timeout_reason = null;
    if (!String(stages.stages.design_review.outputs.alignment_summary || '').trim()) {
      stages.stages.design_review.outputs.alignment_summary =
        stages.stages.design_review.validation?.summary || 'Deterministic design-review checks passed.';
    }
    stages.stages.design_review.status = 'completed';
    stages.stages.design_review.completed_at = isoNow();
    if (!parsed.dryRun) {
      const wdrIds = filterFeatures(unionFeatureIds(stages), parsed.feature) || [];
      const gitCode = syncGitForFeatureIds(root, 'design_review', wdrIds);
      if (gitCode !== 0) finish(gitCode, { reason: 'git_sync_failed' });
      featureStages.appendStageLog(root, {
        skill: 'ai-design3',
        stageKey: 'design_review',
        featureIds: wdrIds,
        message: 'write-design-review 完成，可进入 codegen',
      });
    }
    logDryRunSlice(parsed, {
      design_review: {
        status: stages.stages.design_review.status,
        outputs: {
          decision: stages.stages.design_review.outputs.decision,
          can_enter_codegen: stages.stages.design_review.outputs.can_enter_codegen,
        },
      },
    });
    writeStages(root, stages, parsed.dryRun);
    finish(EXIT.OK);
  }

  if (parsed.cmd === 'hash-design-review-inputs') {
    const arts = stages.stages.contract?.outputs?.artifacts || [];
    const specs = stages.stages.design?.outputs?.design_specs || [];
    const hash = computeDesignReviewInputHash(root, arts, specs);
    stages.stages.design_review = stages.stages.design_review || {};
    stages.stages.design_review.inputs = stages.stages.design_review.inputs || {};
    stages.stages.design_review.inputs.summary_hash = hash;
    logDryRunSlice(parsed, { design_review: { inputs: { summary_hash: hash } } });
    writeStages(root, stages, parsed.dryRun);
    console.log(hash);
    finish(EXIT.OK);
  }

  console.error('Internal error: unhandled subcommand');
  finish(EXIT.PRECHECK, { reason: 'internal' });
}

process.on('SIGINT', () => {
  process.exit(EXIT.CANCEL);
});

main();

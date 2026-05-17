#!/usr/bin/env node
'use strict';

/**
 * ai-auto3 autorun.cjs — 见 docs/spec/auto3.md
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { requireAbsoluteProject, scriptPath, agentSessionsDir } = require('./lib/paths.cjs');
const { runAutorunChecklist } = require('./lib/checklist.cjs');
const { acquirePipelineLock } = require('./lib/pid-lock.cjs');
const { runNodeScript } = require('./lib/child-invoke.cjs');
const { readStages, writeStages, updatePipelineMeta, appendPipelineLog, setContractBlocked } = require('./lib/stages-io.cjs');
const {
  upsertProjectFromStages,
  startRun,
  finishRun,
  recordStageEvent,
  startPhaseRun,
  finishPhaseRun,
  updateProjectRuntimeState,
  clearProjectRuntimeState,
} = require('./lib/registry-db.cjs');
const { shouldSkipCodeStage } = require('./lib/code-skip.cjs');
const {
  runDeployArtifactPreflight,
  mappingFailureLooksLikeStaleBuild,
} = require('./lib/deploy-preflight-gate.cjs');
const {
  getFeatureGroupMaxParallel,
  planFeatureGroupWaves,
  groupSortKey,
} = require('./lib/feature-groups.cjs');
const { filterRemainingCodegenQueue } = require('../../ai-dash3/scripts/lib/features.cjs');
const {
  buildSoakAutorunPlan,
  isSoakStrict,
  shouldForceRerunStage,
} = require('../../ai-soak3/scripts/lib/soak-strict.cjs');

const DESIGN_CHAIN = [
  'scan-design-style',
  'lib-research',
  'validate-design',
  'write-design',
  'hash-design-inputs',
];
const CONTRACT_CHAIN = ['register-contract-artifacts', 'validate-contract', 'hash-contract-inputs'];
const DESIGN_REVIEW_CHAIN = ['validate-design-review', 'write-design-review', 'hash-design-review-inputs'];

const CODE_ORDER = [
  ['codegen', 'codegen'],
  ['typecheck', 'typecheck'],
  ['test', 'test'],
  ['code_review', 'code-review'],
  ['merge_push', 'merge-push'],
  ['build', 'build'],
];

const STAGE_ORDER = [
  'design',
  'contract',
  'design_review',
  'codegen',
  'typecheck',
  'test',
  'code_review',
  'merge_push',
  'build',
  'deploy_smoke',
  'ui_e2e',
];

function normalizeStage(s) {
  return String(s || '')
    .trim()
    .replace(/-/g, '_');
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  const out = {
    subcommand: 'run',
    project: null,
    fromStage: 'design',
    toStage: 'report',
    forceRerun: null,
    sessionId: null,
    dryRun: false,
    features: null,
  };
  const known = new Set(['run', 'preflight-only', 'sync-registry', 'sync-runtime']);
  if (rest.length && known.has(rest[0])) {
    out.subcommand = rest.shift();
  }
  for (const a of rest) {
    if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--from-stage=')) out.fromStage = a.slice('--from-stage='.length);
    else if (a.startsWith('--to-stage=')) out.toStage = a.slice('--to-stage='.length);
    else if (a.startsWith('--force-rerun=')) out.forceRerun = normalizeStage(a.slice('--force-rerun='.length));
    else if (a.startsWith('--session-id=')) out.sessionId = a.slice('--session-id='.length);
    else if (a.startsWith('--features=')) out.features = a.slice('--features='.length);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

const agentLog = require('../../scripts/lib/agent-sessions-log.cjs');

function appendLog(projectRoot, sessionId, line, opts = {}) {
  agentLog.appendSessionLine(projectRoot, sessionId, line, {
    skill: 'ai-auto3',
    stageKey: opts.stageKey,
    featureIds: opts.featureIds,
  });
}

function stageTimeoutMs(cfg, stageKey) {
  const map = {
    design: 'design_s',
    contract: 'contract_s',
    design_review: 'design_review_s',
    codegen: 'codegen_s',
    typecheck: 'typecheck_s',
    test: 'test_s',
    code_review: 'code_review_s',
    merge_push: 'merge_push_s',
    build: 'build_s',
    deploy: 'deploy_s',
    smoke: 'smoke_s',
    deploy_smoke: 'deploy_s',
    ui_e2e: 'ui_e2e_s',
  };
  const k = map[stageKey] || `${stageKey}_s`;
  const sec = cfg?.timeouts?.stages?.[k];
  return typeof sec === 'number' && sec > 0 ? sec * 1000 : 600000;
}

function autorunTotalMs(cfg) {
  const sec = cfg?.timeouts?.autorun_total_s;
  return typeof sec === 'number' && sec > 0 ? sec * 1000 : 7200000;
}

function assertFromStageLegal(from) {
  const n = normalizeStage(from);
  const early = new Set(['prd', 'prd_review', 'not_started']);
  if (early.has(n)) {
    console.error('autorun: --from-stage 不得早于 design（prd/prd-review 须由 ai-prd3 完成）');
    return false;
  }
  return true;
}

function sliceStages(fromStage, toStage) {
  const from = normalizeStage(fromStage);
  let to = normalizeStage(toStage);
  if (to === 'report') to = 'ui_e2e';
  if (to === 'smoke' || to === 'deploy') to = 'deploy_smoke';
  if (to === 'ui_e2e' || to === 'ui-e2e') to = 'ui_e2e';
  const fi = STAGE_ORDER.indexOf(from);
  const ti = STAGE_ORDER.indexOf(to);
  if (fi < 0) {
    console.error(`autorun: unknown --from-stage=${fromStage}`);
    return null;
  }
  if (ti < 0) {
    console.error(`autorun: unknown --to-stage=${toStage}`);
    return null;
  }
  if (fi > ti) return [];
  return STAGE_ORDER.slice(fi, ti + 1);
}

function collectPhasePlans(doc) {
  const phases = doc.stages?.prd_review?.review?.phase_plan || [];
  const out = [];
  for (const row of phases) {
    const phase = String(row?.phase || '').trim() || 'phase';
    const ids = [];
    const seen = new Set();
    for (const fid of row?.feature_ids || []) {
      const id = String(fid || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length) out.push({ phase, featureIds: ids });
  }
  return out;
}

/** Union of all feature_ids in prd_review.phase_plan (matches ai-design3 unionFeatureIds). */
function unionPhasePlanFeatureIds(doc) {
  const set = new Set();
  for (const row of collectPhasePlans(doc)) {
    for (const fid of row.featureIds) set.add(fid);
  }
  return [...set].sort();
}

function featureCsv(ids) {
  return ids.join(',');
}

function soakSkipOpts(soakPlan) {
  if (!soakPlan) return null;
  return {
    soakStrict: soakPlan.strict,
    forceRerunStages: soakPlan.forceRerunStages || [],
    scopedFeatureIds: soakPlan.scopedFeatureIds || [],
  };
}

function mergeForceRerunCli(cliForce, stageKey, soakPlan) {
  const sk = normalizeStage(stageKey);
  if (cliForce && (normalizeStage(cliForce) === sk || cliForce === 'all')) return cliForce;
  if (soakPlan && shouldForceRerunStage(sk, null, soakPlan.forceRerunStages)) return sk;
  return cliForce;
}

function filterPhasePlansBySoak(phasePlans, soakPlan) {
  if (!soakPlan?.scopedFeatureIds?.length) return phasePlans;
  const scope = new Set(soakPlan.scopedFeatureIds);
  return phasePlans
    .map((p) => ({
      phase: p.phase,
      featureIds: p.featureIds.filter((id) => scope.has(id)),
    }))
    .filter((p) => p.featureIds.length > 0);
}

function codegenWorktreesFromDisk(projectRoot) {
  const wtDir = path.join(projectRoot, '.pipeline', 'worktrees');
  if (!fs.existsSync(wtDir)) return [];
  return fs
    .readdirSync(wtDir)
    .filter((d) => d.startsWith('v3-fc-'))
    .map((d) => ({
      feature_id: d.replace(/^v3-fc-/, ''),
      branch: d,
      worktree_path: path.join(wtDir, d),
      commit: '',
      files_expected: [],
      files_changed: [],
      test_files_expected: [],
      test_files_changed: [],
    }))
    .sort((a, b) => String(a.feature_id).localeCompare(String(b.feature_id)));
}

function mergeCodegenWorktreeRows(existing, extra) {
  const byId = new Map();
  for (const r of existing || []) {
    const id = String(r?.feature_id || '').trim();
    if (id) byId.set(id, r);
  }
  for (const r of extra || []) {
    const id = String(r?.feature_id || '').trim();
    if (id) byId.set(id, { ...(byId.get(id) || {}), ...r });
  }
  return [...byId.values()].sort((a, b) =>
    String(a.feature_id || '').localeCompare(String(b.feature_id || ''))
  );
}

/** Reconcile stages with on-disk worktrees (parallel codegen can race on stages.json). */
function persistCodegenWorktrees(projectRoot) {
  const doc = readStages(projectRoot);
  const disk = codegenWorktreesFromDisk(projectRoot);
  const merged = mergeCodegenWorktreeRows(doc.stages?.codegen?.outputs?.worktrees, disk);
  if (!doc.stages) doc.stages = {};
  if (!doc.stages.codegen) doc.stages.codegen = {};
  if (!doc.stages.codegen.outputs) doc.stages.codegen.outputs = {};
  doc.stages.codegen.outputs.worktrees = merged;
  writeStages(projectRoot, doc);
  return merged;
}

function validateCodegenCoverage(projectRoot, requiredFeatureIds) {
  const rows = persistCodegenWorktrees(projectRoot);
  const produced = new Set(
    rows
      .map((r) => String(r?.feature_id || '').trim())
      .filter(Boolean)
  );
  const missing = requiredFeatureIds.filter((id) => !produced.has(id));
  return { missing, producedCount: produced.size };
}

function toSingleFeatureArg(featureCsvStr) {
  if (!featureCsvStr) return '';
  const ids = String(featureCsvStr)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length === 1 ? ids[0] : '';
}

function getSkillRootFromScript(scriptAbsPath) {
  return path.dirname(path.dirname(scriptAbsPath));
}

function hasPublishDevYamlDependency() {
  const publishRun = scriptPath('ai-publish-dev3', 'scripts/run.cjs');
  const publishRoot = getSkillRootFromScript(publishRun);
  try {
    require.resolve('js-yaml', { paths: [publishRoot] });
    return { ok: true, publishRoot };
  } catch {
    return { ok: false, publishRoot };
  }
}

function ensurePublishDevDepsForDeploy(slice) {
  if (!slice.includes('deploy_smoke')) return { ok: true };
  const dep = hasPublishDevYamlDependency();
  if (dep.ok) return { ok: true };
  console.error('[ai-auto3] 检测到 ai-publish-dev3 缺少 js-yaml，自动执行 npm install');
  const ins = spawnSync('npm', ['install'], {
    cwd: dep.publishRoot,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (ins.status !== 0) {
    return {
      ok: false,
      message: `ai-auto3: 自动安装 ai-publish-dev3 依赖失败（cwd=${dep.publishRoot}）`,
    };
  }
  const verify = hasPublishDevYamlDependency();
  if (!verify.ok) {
    return {
      ok: false,
      message: `ai-auto3: npm install 后仍未检测到 js-yaml（cwd=${dep.publishRoot}）`,
    };
  }
  return { ok: true };
}

function shouldAutoApproveContract(cfg) {
  const v = cfg?.pipeline?.autorun?.auto_contract_approval;
  return v !== false;
}

function allowNoAgentPass(cfg) {
  const v = cfg?.pipeline?.autorun?.allow_no_agent_pass;
  return v !== false;
}

function shouldForceStubRemaining(cfg) {
  return cfg?.pipeline?.autorun?.force_stub_remaining === true;
}

function resolveCode3AgentBin(cfg) {
  const configured = String(cfg?.pipeline?.autorun?.code3_agent_bin || '').trim();
  if (configured) return configured;
  const envPrimary = String(process.env.AI_CODE3_AGENT_BIN || '').trim();
  if (envPrimary) return envPrimary;
  const envLegacy = String(process.env.AI_CODEGEN_AGENT_BIN || '').trim();
  if (envLegacy) return envLegacy;
  const home = String(process.env.HOME || '').trim();
  if (home) {
    const localBin = path.join(home, '.local', 'bin', 'cursor-agent');
    try {
      if (fs.existsSync(localBin)) return localBin;
    } catch {
      /* ignore */
    }
  }
  for (const sh of ['zsh', 'bash']) {
    const probe = spawnSync(sh, ['-lc', 'command -v cursor-agent'], {
      encoding: 'utf8',
    });
    if (probe.status !== 0) continue;
    const resolved = String(probe.stdout || '').trim();
    if (resolved) return resolved;
  }
  return '';
}

function parseFeatureTargets(projectRoot) {
  const docsDir = path.join(projectRoot, 'docs');
  const map = new Map();
  if (!fs.existsSync(docsDir)) return map;
  const skip = new Set(['designs', 'contracts', 'inputs', 'templates']);
  for (const ent of fs.readdirSync(docsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (skip.has(ent.name)) continue;
    const target = ent.name;
    const flPath = path.join(docsDir, target, 'feature_list.md');
    if (!fs.existsSync(flPath)) continue;
    const text = fs.readFileSync(flPath, 'utf8');
    let inFeaturesSection = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (/^##\s+Features\s*$/i.test(line)) {
        inFeaturesSection = true;
        continue;
      }
      if (inFeaturesSection && /^##\s+/.test(line)) {
        inFeaturesSection = false;
      }
      if (!inFeaturesSection) continue;
      if (!line.startsWith('|')) continue;
      if (/^\|\s*Feature ID\s*\|/i.test(line)) continue;
      if (/^\|\s*[-: ]+\|/.test(line)) continue;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((v) => v.trim());
      if (!cells.length) continue;
      const fid = cells[0];
      if (!/^[A-Za-z0-9_.-]+$/.test(fid)) continue;
      if (!map.has(fid)) map.set(fid, new Set());
      map.get(fid).add(target);
    }
  }
  return map;
}

function pickClientTargetForFeature(featureId, featureTargets) {
  const targets = featureTargets.get(featureId);
  if (!targets || !targets.size) return 'website';
  if (targets.has('backend')) return 'backend';
  if (targets.has('website')) return 'website';
  return [...targets][0];
}

function ensureSeedDesignSpecs(projectRoot, featureIds, sessionId) {
  const designsDir = path.join(projectRoot, 'docs', 'designs');
  fs.mkdirSync(designsDir, { recursive: true });
  const featureTargets = parseFeatureTargets(projectRoot);
  const created = [];
  const patched = [];
  for (const fid of featureIds) {
    const abs = path.join(designsDir, `${fid}.design.json`);
    const targets = [...(featureTargets.get(fid) || new Set())];
    const clientTarget = pickClientTargetForFeature(fid, featureTargets);
    const clientTargets = targets.length ? [...new Set(targets)] : [clientTarget];
    const crossClient = clientTargets.length >= 2;
    if (fs.existsSync(abs)) {
      try {
        const existing = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (existing && typeof existing === 'object') {
          let dirty = false;
          if (!Array.isArray(existing.client_targets) || existing.client_targets.length === 0) {
            existing.client_targets = clientTargets;
            dirty = true;
          }
          if (typeof existing.cross_client !== 'boolean') {
            existing.cross_client = crossClient;
            dirty = true;
          }
          if (!existing.client_target || typeof existing.client_target !== 'string') {
            existing.client_target = clientTarget;
            dirty = true;
          }
          if (dirty) {
            fs.writeFileSync(abs, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
            patched.push(path.relative(projectRoot, abs).replace(/\\/g, '/'));
          }
        }
      } catch {
        // 非法 JSON 交由 ai-design3 validate-design 报错处理
      }
      continue;
    }
    const seed = {
      feature_id: fid,
      client_target: clientTarget,
      client_targets: clientTargets,
      cross_client: crossClient,
      status: 'draft',
      file_plan: {
        new_files: [],
        modify_files: [],
        reuse_existing: [],
      },
      acceptance: ['bootstrap design seed for autorun; refine in design stage'],
      constraints: ['keep implementation minimal and local-runnable'],
      dependencies: [],
      risks: [],
      shared_changes: [],
    };
    fs.writeFileSync(abs, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
    created.push(path.relative(projectRoot, abs).replace(/\\/g, '/'));
  }
  if (created.length) {
    appendLog(projectRoot, sessionId, `seeded design specs: ${created.join(', ')}`);
    console.error(`[ai-auto3] seeded ${created.length} missing design specs`);
  }
  if (patched.length) {
    appendLog(projectRoot, sessionId, `patched design specs metadata: ${patched.join(', ')}`);
    console.error(`[ai-auto3] patched ${patched.length} design specs metadata`);
  }
}

async function spawnDesign3(projectRoot, cmd, cfg, sessionId, forceRerunStage, featureCsvStr) {
  const script = scriptPath('ai-design3', 'scripts/run.cjs');
  const args = [cmd, `--project=${projectRoot}`];
  const singleFeature = toSingleFeatureArg(featureCsvStr);
  if (singleFeature) args.push(`--feature=${singleFeature}`);
  if (forceRerunStage === 'design') args.push('--force-rerun=design');
  const t = stageTimeoutMs(cfg, 'design');
  return runNodeScript({
    node: process.execPath,
    script,
    args,
    cwd: projectRoot,
    timeoutMs: t,
    env: { ...process.env, AI_AUTO3_SESSION_ID: sessionId },
  });
}

async function runDesignChain(projectRoot, cfg, sessionId, forceRerun, featureCsvStr) {
  const fr = forceRerun === 'design' ? 'design' : null;
  for (const cmd of DESIGN_CHAIN) {
    const code = await spawnDesign3(projectRoot, cmd, cfg, sessionId, fr, featureCsvStr);
    if (code !== 0) return { code, stage: 'design', detail: cmd };
  }
  return { code: 0 };
}

async function runContractChain(projectRoot, cfg, sessionId, forceRerun, featureCsvStr) {
  for (const cmd of CONTRACT_CHAIN) {
    const script = scriptPath('ai-design3', 'scripts/run.cjs');
    const args = [cmd, `--project=${projectRoot}`];
    const singleFeature = toSingleFeatureArg(featureCsvStr);
    if (singleFeature) args.push(`--feature=${singleFeature}`);
    if (forceRerun === 'contract') args.push('--force-rerun=contract');
    const code = await runNodeScript({
      node: process.execPath,
      script,
      args,
      cwd: projectRoot,
      timeoutMs: stageTimeoutMs(cfg, 'contract'),
    });
    if (code !== 0) return { code, stage: 'contract', detail: cmd };
  }
  return { code: 0 };
}

async function autoApproveContractIfPending(projectRoot, cfg) {
  if (!shouldAutoApproveContract(cfg)) return { code: 0, changed: false };
  const doc = readStages(projectRoot);
  const ha = doc.stages?.contract?.outputs?.human_approval?.status;
  if (ha !== 'pending') return { code: 0, changed: false };
  const script = scriptPath('ai-design3', 'scripts/run.cjs');
  const args = [
    'mark-contract-not-required',
    `--project=${projectRoot}`,
    '--notes=auto-approved by ai-auto3 autorun for local pipeline continuity',
  ];
  const code = await runNodeScript({
    node: process.execPath,
    script,
    args,
    cwd: projectRoot,
    timeoutMs: stageTimeoutMs(cfg, 'contract'),
  });
  return { code, changed: true };
}

async function runDesignReviewChain(projectRoot, cfg, sessionId, forceRerun, featureCsvStr) {
  for (const cmd of DESIGN_REVIEW_CHAIN) {
    const script = scriptPath('ai-design3', 'scripts/run.cjs');
    const args = [cmd, `--project=${projectRoot}`];
    const singleFeature = toSingleFeatureArg(featureCsvStr);
    if (singleFeature) args.push(`--feature=${singleFeature}`);
    if (forceRerun === 'design_review') args.push('--force-rerun=design_review');
    const code = await runNodeScript({
      node: process.execPath,
      script,
      args,
      cwd: projectRoot,
      timeoutMs: stageTimeoutMs(cfg, 'design_review'),
    });
    if (code !== 0) return { code, stage: 'design_review', detail: cmd };
  }
  return { code: 0 };
}

/**
 * 同一阶段层内：最多 maxParallel 路 ai-code3 并行（auto3.md §5.7）。
 * @param {string[][]} layerGroups 本层每个元素为一组 feature_id[]
 */
function refreshCodegenPendingFeatures(projectRoot, phaseFeatureIds) {
  const doc = readStages(projectRoot);
  const projectId = doc?.project?.project_id;
  if (!projectId) return;
  const remaining = filterRemainingCodegenQueue(projectRoot, phaseFeatureIds);
  updateProjectRuntimeState(
    projectId,
    { pending_features_json: JSON.stringify(remaining) },
    projectRoot,
    doc
  );
}

async function runLayerGroupsParallel(
  projectRoot,
  cmd,
  stageKey,
  layerGroups,
  cfg,
  logSessionId,
  sessionPrefixForCode3,
  forceRerun,
  maxParallel,
  forceStub,
  phaseFeatureIdsForPending,
  soakPlan
) {
  const items = layerGroups.map((members) => ({
    members,
    key: groupSortKey(members),
    csv: featureCsv(members),
  }));
  let cursor = 0;
  let failCode = 0;
  let failKey = '';

  async function worker() {
    for (;;) {
      if (failCode !== 0) return;
      const i = cursor++;
      if (i >= items.length) return;
      const { members, key, csv } = items[i];
      const short = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
      const sid = `${sessionPrefixForCode3}-${short}`;
      const groupNo = `${i + 1}/${items.length}`;
      console.error(
        `[ai-auto3] code3 ${cmd} group ${groupNo} begin feature=${csv} session=${sid}`
      );
      appendLog(
        projectRoot,
        logSessionId,
        `spawn ai-code3 ${cmd} stage=${stageKey} group=${groupNo} ${key} --feature=${csv} session=${sid}`
      );
      const t0 = Date.now();
      const code = await spawnCode3(projectRoot, cmd, csv, cfg, sid, forceRerun, forceStub, soakPlan);
      const elapsed = Date.now() - t0;
      console.error(
        `[ai-auto3] code3 ${cmd} group ${groupNo} end feature=${csv} exit=${code} elapsed_ms=${elapsed}`
      );
      appendLog(
        projectRoot,
        logSessionId,
        `ai-code3 ${cmd} group ${groupNo} done feature=${csv} exit=${code} elapsed_ms=${elapsed}`
      );
      if (code !== 0) {
        if (failCode === 0) {
          failCode = code;
          failKey = key;
        }
        return;
      }
      if (
        stageKey === 'codegen' &&
        Array.isArray(phaseFeatureIdsForPending) &&
        phaseFeatureIdsForPending.length
      ) {
        refreshCodegenPendingFeatures(projectRoot, phaseFeatureIdsForPending);
      }
    }
  }

  const n = Math.min(Math.max(1, maxParallel), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  if (failCode !== 0) {
    appendLog(projectRoot, logSessionId, `ai-code3 ${cmd} failed code=${failCode} group=${failKey}`);
  }
  return failCode;
}

async function runCodeStageWithFeatureGroups(
  projectRoot,
  cmd,
  stageKey,
  featureIds,
  cfg,
  sessionId,
  forceRerun,
  warningCache,
  realAgentDetected,
  forceStub,
  soakPlan
) {
  const doc = readStages(projectRoot);
  const plan = planFeatureGroupWaves(featureIds, doc, projectRoot);
  for (const w of plan.warnings) {
    const key = String(w);
    if (warningCache && warningCache.has(key)) continue;
    if (warningCache) warningCache.add(key);
    appendLog(projectRoot, sessionId, `[feature-plan] ${w}`);
    console.error(`[ai-auto3][feature-plan] ${w}`);
  }
  let maxP = getFeatureGroupMaxParallel(cfg);
  if (realAgentDetected && maxP > 1) {
    console.error(
      `[ai-auto3] codegen 组间并行 maxParallel=${maxP}（pipeline.autorun.feature_group_max_parallel；串行请设为 1）`
    );
  }
  appendLog(
    projectRoot,
    sessionId,
    `feature groups: layers=${plan.layers.length} maxParallel=${maxP} (pipeline.autorun.feature_group_max_parallel)`
  );
  for (let li = 0; li < plan.layers.length; li++) {
    const layer = plan.layers[li];
    appendLog(
      projectRoot,
      sessionId,
      `layer ${li + 1}/${plan.layers.length}: ${layer.length} group(s) — ${layer.map((g) => groupSortKey(g)).join(' | ')}`
    );
    const code = await runLayerGroupsParallel(
      projectRoot,
      cmd,
      stageKey,
      layer,
      cfg,
      sessionId,
      `${sessionId}-${stageKey}`,
      forceRerun,
      maxP,
      forceStub,
      stageKey === 'codegen' ? featureIds : null,
      soakPlan
    );
    if (code !== 0) return code;
  }
  return 0;
}

async function spawnCode3(
  projectRoot,
  sub,
  featureCsvStr,
  cfg,
  sessionId,
  forceRerun,
  forceStubOverride,
  soakPlan
) {
  const script = scriptPath('ai-code3', 'scripts/run.cjs');
  const args = [sub, `--project=${projectRoot}`, `--feature=${featureCsvStr}`, `--session-id=${sessionId}`];
  const sk = normalizeStage(sub.replace(/-/g, '_'));
  if (forceRerun && normalizeStage(forceRerun) === sk) {
    args.push(`--force-rerun=${sk}`);
  }
  const agentBin = resolveCode3AgentBin(cfg);
  const strict = soakPlan?.strict || isSoakStrict();
  const forceStub = strict ? false : !!forceStubOverride || shouldForceStubRemaining(cfg);
  const useStub = strict ? false : forceStub || !agentBin;
  if (useStub) {
    args.push('--stub-remaining');
  }
  if (strict && !agentBin) {
    console.error(
      '[ai-auto3] AI_SOAK3_STRICT=1 但未配置 AI_CODE3_AGENT_BIN — codegen 将失败（禁止 SKIP_AGENT 伪完成）'
    );
  }
  let t = stageTimeoutMs(cfg, sk === 'merge_push' ? 'merge_push' : sk);
  if (!useStub && sk === 'codegen') {
    const capSRaw = process.env.AI_AUTO3_CODEGEN_AGENT_MAX_S;
    if (Number.isFinite(Number(capSRaw)) && Number(capSRaw) > 0) {
      t = Math.min(t, Number(capSRaw) * 1000);
    }
    // 未设置 AI_AUTO3_CODEGEN_AGENT_MAX_S 时沿用 config.dev.json → timeouts.stages.codegen_s
  }
  const env = {
    AI_CODE3_ALLOW_NO_AGENT_PASS: strict ? '' : allowNoAgentPass(cfg) ? 'yes' : '',
    AI_CODE3_SKIP_AGENT: useStub ? '1' : '',
    AI_CODE3_AGENT_BIN: agentBin,
    AI_CODE3_CODEGEN_CONFIRM: 'yes',
  };
  if (strict) env.AI_SOAK3_STRICT = '1';
  const inc = soakPlan?.incrementalFeatureIds || [];
  if (inc.length && featureCsvStr.split(',').some((id) => inc.includes(id.trim()))) {
    env.AI_CODE3_CODEGEN_MODE = 'incremental';
  }
  return runNodeScript({
    node: process.execPath,
    script,
    args,
    cwd: projectRoot,
    env,
    timeoutMs: t,
  });
}

async function runPublishDev(projectRoot, cfg, sessionId, soakPlan) {
  const script = scriptPath('ai-publish-dev3', 'scripts/run.cjs');
  const args = [`--project=${projectRoot}`, '--invoked-by-autorun', `--session-id=${sessionId}`];
  if (soakPlan && shouldForceRerunStage('deploy', null, soakPlan.forceRerunStages)) {
    args.push('--force-rerun');
  }
  const deployMs = stageTimeoutMs(cfg, 'deploy') + stageTimeoutMs(cfg, 'smoke');
  return runNodeScript({
    node: process.execPath,
    script,
    args,
    cwd: projectRoot,
    timeoutMs: deployMs,
  });
}

function uiE2eEnabled(cfg) {
  return !!(cfg && cfg.ui_e2e && cfg.ui_e2e.enabled === true);
}

async function ensureE2e3Deps(slice) {
  if (!slice.includes('ui_e2e')) return { ok: true };
  const e2eRoot = scriptPath('ai-e2e3', 'package.json');
  const e2eDir = path.dirname(e2eRoot);
  const nm = path.join(e2eDir, 'node_modules', 'js-yaml');
  if (fs.existsSync(nm)) return { ok: true };
  console.error('[ai-auto3] 检测到 ai-e2e3 缺少依赖，自动执行 npm ci');
  const r = spawnSync('npm', ['ci'], { cwd: e2eDir, encoding: 'utf8', stdio: 'pipe' });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `ai-auto3: 自动安装 ai-e2e3 依赖失败（cwd=${e2eDir}）`,
    };
  }
  return { ok: true };
}

async function runE2e3(projectRoot, cfg, sessionId, soakPlan) {
  if (!uiE2eEnabled(cfg)) {
    console.error('[ai-auto3] ui_e2e.enabled=false — 跳过 ai-e2e3');
    return 0;
  }
  const script = scriptPath('ai-e2e3', 'scripts/run.cjs');
  const args = [`--project=${projectRoot}`, '--invoked-by-autorun', `--session-id=${sessionId}`];
  if (soakPlan?.strict || isSoakStrict()) {
    process.env.AI_SOAK3_STRICT = '1';
  }
  if (soakPlan && shouldForceRerunStage('ui_e2e', null, soakPlan.forceRerunStages)) {
    args.push('--force-rerun');
  }
  return runNodeScript({
    node: process.execPath,
    script,
    args,
    cwd: projectRoot,
    timeoutMs: stageTimeoutMs(cfg, 'ui_e2e'),
  });
}

async function runGenReport(projectRoot, sessionId, failureReason) {
  const script = path.join(__dirname, 'gen-report.cjs');
  const args = [`--project=${projectRoot}`, `--session-id=${sessionId}`];
  if (failureReason) args.push(`--failure-reason=${failureReason}`);
  return runNodeScript({
    node: process.execPath,
    script,
    args,
    cwd: projectRoot,
    timeoutMs: 120000,
  });
}

function maybeHintRollback(doc) {
  const rb = doc.stages?.test?.rollback_to;
  if (rb && rb !== 'null') {
    console.error(`[ai-auto3] stages.test.rollback_to=${rb} — 可考虑 --from-stage=${rb === 'contract' ? 'contract' : 'codegen'} 续跑`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  let projectRoot;
  try {
    projectRoot = requireAbsoluteProject(opts.project);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  if (!assertFromStageLegal(opts.fromStage)) process.exit(1);

  const sessionId = opts.sessionId || crypto.randomUUID();
  const slice = sliceStages(opts.fromStage, opts.toStage);
  if (!slice) process.exit(1);
  const deps = ensurePublishDevDepsForDeploy(slice);
  const depsE2e = await ensureE2e3Deps(slice);
  if (!deps.ok) {
    console.error(deps.message);
    process.exit(1);
  }
  if (!depsE2e.ok) {
    console.error(depsE2e.message);
    process.exit(1);
  }

  if (opts.subcommand === 'preflight-only') {
    const ck = runAutorunChecklist(projectRoot, { featuresFilter: opts.features });
    if (!ck.ok) {
      console.error(ck.message);
      process.exit(1);
    }
    for (const w of ck.checklistWarnings || []) {
      console.error(w);
    }
    try {
      upsertProjectFromStages(projectRoot, readStages(projectRoot));
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
    console.error('preflight-only: OK');
    process.exit(0);
  }

  if (opts.subcommand === 'sync-registry' || opts.subcommand === 'sync-runtime') {
    let doc;
    try {
      doc = readStages(projectRoot);
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
    try {
      upsertProjectFromStages(projectRoot, doc);
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
    console.error(`${opts.subcommand}: OK`);
    process.exit(0);
  }

  const ck = runAutorunChecklist(projectRoot, { featuresFilter: opts.features });
  if (!ck.ok) {
    console.error(ck.message);
    await runGenReport(projectRoot, sessionId, ck.message);
    process.exit(1);
  }
  for (const w of ck.checklistWarnings || []) {
    console.error(w);
  }

  let doc = ck.stages;
  const cfg = ck.configDev;
  const featureIds = ck.featureIds;
  const soakPlan = buildSoakAutorunPlan(projectRoot, { featureIds });
  if (soakPlan.blockReason) {
    console.error(`[ai-auto3] ${soakPlan.blockReason}`);
    await runGenReport(projectRoot, sessionId, soakPlan.blockReason);
    process.exit(4);
  }
  if (soakPlan.strict) {
    process.env.AI_SOAK3_STRICT = '1';
    appendLog(projectRoot, sessionId, 'AI_SOAK3_STRICT=1 — 强制重跑 codegen/build/deploy/smoke/ui_e2e');
    console.error('[ai-auto3] AI_SOAK3_STRICT=1');
  }
  const featStr = featureCsv(featureIds);
  const selectedFeatureSet = new Set(featureIds);
  const realAgentDetected =
    (!!resolveCode3AgentBin(cfg) && !shouldForceStubRemaining(cfg)) || soakPlan.strict;
  let phasePlans = collectPhasePlans(doc)
    .map((p) => ({
      phase: p.phase,
      featureIds: p.featureIds.filter((id) => selectedFeatureSet.has(id)),
    }))
    .filter((p) => p.featureIds.length > 0);
  phasePlans = filterPhasePlansBySoak(phasePlans, soakPlan);
  if (!phasePlans.length) {
    if (soakPlan.scopedFeatureIds?.length) {
      phasePlans = [{ phase: 'scoped', featureIds: soakPlan.scopedFeatureIds.slice() }];
    } else {
      phasePlans = [{ phase: 'mvp', featureIds: featureIds.slice() }];
    }
  }

  try {
    upsertProjectFromStages(projectRoot, doc);
  } catch (e) {
    console.error(String(e.message || e));
    await runGenReport(projectRoot, sessionId, String(e.message || e));
    process.exit(1);
  }

  const t0 = Date.now();
  const totalCap = autorunTotalMs(cfg);

  const checkBudget = () => {
    if (Date.now() - t0 > totalCap) {
      return 'autorun_total_timeout';
    }
    return null;
  };

  if (opts.dryRun) {
    console.error(`[dry-run] would run stages: ${slice.join(' -> ')} features=${featStr}`);
    console.error(
      `[dry-run] phase order: ${phasePlans.map((p) => `${p.phase}(${p.featureIds.length})`).join(' -> ')}`
    );
    if (slice.some((s) => ['codegen', 'typecheck', 'test', 'code_review', 'merge_push', 'build'].includes(s))) {
      try {
        console.error(`[dry-run] feature_group_max_parallel=${getFeatureGroupMaxParallel(cfg)}`);
        for (const p of phasePlans) {
          const plan = planFeatureGroupWaves(p.featureIds, readStages(projectRoot), projectRoot);
          plan.warnings.forEach((w) => console.error(`[dry-run][feature-plan][${p.phase}] ${w}`));
          plan.layers.forEach((layer, i) => {
            console.error(
              `[dry-run][${p.phase}] layer ${i + 1}: ${layer.length} group(s) -> ${layer
                .map((g) => groupSortKey(g))
                .join(' | ')}`
            );
          });
        }
      } catch (e) {
        console.error(`[dry-run] feature plan preview failed: ${e.message || e}`);
      }
    }
    process.exit(0);
  }

  const lock = acquirePipelineLock(projectRoot, sessionId);
  if (!lock.ok) {
    console.error(`pipeline lock held: ${lock.path}`);
    await runGenReport(projectRoot, sessionId, 'pipeline lock held');
    process.exit(1);
  }

  appendLog(projectRoot, sessionId, `autorun begin slice=${slice.join(',')}`);

  let exitCode = 0;
  let failureReason = '';
  let stoppedAt = '';
  let runId = '';
  const featurePlanWarningCache = new Set();

  try {
    runId = startRun(doc.project?.project_id || 'unknown', sessionId, projectRoot, doc);

    const design3Preflight = scriptPath('ai-design3', 'scripts/run.cjs');
    const pf = spawnSync(process.execPath, [design3Preflight, 'preflight', `--project=${projectRoot}`], {
      cwd: projectRoot,
      stdio: 'inherit',
      encoding: 'utf8',
    });
    if (pf.status !== 0) {
      exitCode = pf.status || 1;
      failureReason = 'ai-design3 preflight failed';
      stoppedAt = 'preflight';
    } else {
      // scan-design-style uses union of full phase_plan when --feature is omitted (multi-feature phase).
      ensureSeedDesignSpecs(projectRoot, unionPhasePlanFeatureIds(doc), sessionId);
      for (const phaseRow of phasePlans) {
        const phase = phaseRow.phase;
        const phaseFeatureIds = phaseRow.featureIds;
        const phaseFeatStr = featureCsv(phaseFeatureIds);
        const phaseRunId = startPhaseRun(runId, phase, '');
        appendLog(projectRoot, sessionId, `phase begin: ${phase} features=${phaseFeatStr}`);
        console.error(`[ai-auto3] phase begin phase=${phase} feature_count=${phaseFeatureIds.length}`);
        const pendingAtPhaseStart = filterRemainingCodegenQueue(projectRoot, phaseFeatureIds);
        updateProjectRuntimeState(
          doc.project?.project_id || 'unknown',
          {
            active_run_id: runId,
            current_phase: phase,
            current_stage: '',
            pending_features_json: JSON.stringify(pendingAtPhaseStart),
          },
          projectRoot,
          doc
        );

        for (const stage of slice) {
          const budget = checkBudget();
          if (budget) {
            exitCode = 3;
            failureReason = budget;
            stoppedAt = stage;
            break;
          }

          doc = readStages(projectRoot);
          doc = updatePipelineMeta(doc, {
            currentStage: stage,
            lastCompleted: doc.pipeline?.last_completed_stage,
            by: 'ai-auto3',
          });
          writeStages(projectRoot, doc);
          const pendingForStage =
            stage === 'codegen'
              ? filterRemainingCodegenQueue(projectRoot, phaseFeatureIds)
              : phaseFeatureIds;
          updateProjectRuntimeState(
            doc.project?.project_id || 'unknown',
            {
              active_run_id: runId,
              current_phase: phase,
              current_stage: stage,
              pending_features_json: JSON.stringify(pendingForStage),
            },
            projectRoot,
            doc
          );
          console.error(`[ai-auto3] stage begin phase=${phase} stage=${stage}`);

          if (stage === 'design') {
            ensureSeedDesignSpecs(projectRoot, phaseFeatureIds, sessionId);
            const r = await runDesignChain(projectRoot, cfg, sessionId, opts.forceRerun, phaseFeatStr);
            if (r.code !== 0) {
              exitCode = r.code;
              failureReason = `design failed at ${r.detail}`;
              stoppedAt = 'design';
              break;
            }
            recordStageEvent(runId, 'design', 0, 0, false, `phase=${phase}`);
          } else if (stage === 'contract') {
            const r = await runContractChain(projectRoot, cfg, sessionId, opts.forceRerun, phaseFeatStr);
            if (r.code !== 0) {
              exitCode = r.code;
              failureReason = `contract failed at ${r.detail}`;
              stoppedAt = 'contract';
              break;
            }
            const autoApprove = await autoApproveContractIfPending(projectRoot, cfg);
            if (autoApprove.code !== 0) {
              exitCode = autoApprove.code;
              failureReason = 'contract auto-approval failed';
              stoppedAt = 'contract';
              break;
            }
            if (autoApprove.changed) {
              appendLog(
                projectRoot,
                sessionId,
                'contract human_approval pending -> auto mark-contract-not-required by ai-auto3'
              );
            }
            doc = readStages(projectRoot);
            const ha = doc.stages?.contract?.outputs?.human_approval?.status;
            if (ha === 'pending') {
              doc = setContractBlocked(doc);
              doc = updatePipelineMeta(doc, {
                currentStage: 'contract',
                lastCompleted: doc.pipeline?.last_completed_stage,
                by: 'ai-auto3',
              });
              writeStages(projectRoot, doc);
              exitCode = 1;
              failureReason =
                'contract human_approval pending — 请使用 ai-design3 approve-contract / reject-contract';
              stoppedAt = 'contract';
              break;
            }
            recordStageEvent(runId, 'contract', 0, 0, false, `phase=${phase}`);
          } else if (stage === 'design_review') {
            const r = await runDesignReviewChain(projectRoot, cfg, sessionId, opts.forceRerun, phaseFeatStr);
            if (r.code !== 0) {
              exitCode = r.code;
              failureReason = `design_review failed at ${r.detail}`;
              stoppedAt = 'design_review';
              break;
            }
            recordStageEvent(runId, 'design_review', 0, 0, false, `phase=${phase}`);
          } else if (['codegen', 'typecheck', 'test', 'code_review', 'merge_push', 'build'].includes(stage)) {
            const sk = stage;
            if (
              shouldSkipCodeStage(
                doc,
                sk,
                projectRoot,
                phaseFeatureIds,
                mergeForceRerunCli(opts.forceRerun, sk, soakPlan),
                soakSkipOpts(soakPlan)
              )
            ) {
              appendLog(projectRoot, sessionId, `skip ${sk} (summary_hash) phase=${phase}`);
              recordStageEvent(runId, sk, 0, 0, true, `hash skip phase=${phase}`);
              continue;
            }
            const row = CODE_ORDER.find(([k]) => k === sk);
            if (!row) {
              exitCode = 1;
              failureReason = `internal: unknown code stage ${sk}`;
              stoppedAt = sk;
              break;
            }
            const cmd = row[1];
            let code = 0;
            if (sk === 'merge_push' || sk === 'build') {
              code = await spawnCode3(
                projectRoot,
                cmd,
                phaseFeatStr,
                cfg,
                `${sessionId}-${phase}-${sk}`,
                mergeForceRerunCli(opts.forceRerun, sk, soakPlan),
                false,
                soakPlan
              );
            } else {
              code = await runCodeStageWithFeatureGroups(
                projectRoot,
                cmd,
                sk,
                phaseFeatureIds,
                cfg,
                sessionId,
                mergeForceRerunCli(opts.forceRerun, sk, soakPlan),
                featurePlanWarningCache,
                realAgentDetected,
                false,
                soakPlan
              );
            }
            if (sk === 'codegen' && soakPlan.strict) {
              doc = readStages(projectRoot);
              const ag = doc.stages?.codegen?.outputs?.agent;
              if (ag?.skipped === true) {
                exitCode = 4;
                failureReason = 'AI_SOAK3_STRICT: codegen agent 被跳过';
                stoppedAt = sk;
                break;
              }
            }
            if (code !== 0) {
              if (sk === 'codegen') {
                if (realAgentDetected || soakPlan.strict) {
                  appendLog(
                    projectRoot,
                    sessionId,
                    `codegen failed code=${code}; real-agent mode disables implicit stub fallback`
                  );
                } else {
                  appendLog(
                    projectRoot,
                    sessionId,
                    `codegen failed code=${code}; retry full phase once with force-rerun=codegen + --stub-remaining`
                  );
                  code = await spawnCode3(
                    projectRoot,
                    cmd,
                    phaseFeatStr,
                    cfg,
                    `${sessionId}-retry-stub-all`,
                    'codegen',
                    true,
                    soakPlan
                  );
                }
              }
            }
            if (code !== 0) {
              exitCode = code;
              failureReason = `ai-code3 ${cmd} exit=${code}`;
              stoppedAt = sk;
              break;
            }
            if (sk === 'codegen') {
              const cov = validateCodegenCoverage(projectRoot, phaseFeatureIds);
              if (cov.missing.length) {
                if (realAgentDetected) {
                  exitCode = 1;
                  failureReason = `ai-code3 codegen 覆盖不足，缺少 feature: ${cov.missing.join(', ')}`;
                  stoppedAt = sk;
                  break;
                }
                appendLog(
                  projectRoot,
                  sessionId,
                  `codegen coverage missing=${cov.missing.join(', ')}; run stub backfill with force-rerun=codegen`
                );
                const backfill = await spawnCode3(
                  projectRoot,
                  cmd,
                  featureCsv(cov.missing),
                  cfg,
                  `${sessionId}-coverage-backfill-stub`,
                  'codegen',
                  true,
                  soakPlan
                );
                const cov2 = validateCodegenCoverage(projectRoot, phaseFeatureIds);
                if (backfill !== 0 || cov2.missing.length) {
                  exitCode = 1;
                  failureReason = `ai-code3 codegen 覆盖不足，缺少 feature: ${cov2.missing.join(', ')}`;
                  stoppedAt = sk;
                  break;
                }
              }
            }
            recordStageEvent(runId, sk, code, 0, false, `phase=${phase}`);
          } else if (stage === 'deploy_smoke') {
            const deployEnabled = !!(cfg.deploy && cfg.deploy.enabled);
            if (deployEnabled) {
              const allow =
                cfg.pipeline && cfg.pipeline.autorun && cfg.pipeline.autorun.allow_destructive_deploy === true;
              if (!allow) {
                exitCode = 1;
                failureReason =
                  'deploy.enabled=true 但 pipeline.autorun.allow_destructive_deploy !== true — 未 spawn ai-publish-dev3（publish3.md §5.1.1）';
                stoppedAt = 'deploy';
                break;
              }
              let pf = runDeployArtifactPreflight(projectRoot);
              if (
                !pf.ok &&
                mappingFailureLooksLikeStaleBuild(pf.message) &&
                shouldSkipCodeStage(
                  doc,
                  'build',
                  projectRoot,
                  phaseFeatureIds,
                  mergeForceRerunCli(opts.forceRerun, 'build', soakPlan),
                  soakSkipOpts(soakPlan)
                )
              ) {
                appendLog(
                  projectRoot,
                  sessionId,
                  `deploy preflight failed after skip build — forcing build: ${pf.message}`
                );
                const buildCode = await spawnCode3(
                  projectRoot,
                  'build',
                  phaseFeatStr,
                  cfg,
                  `${sessionId}-${phase}-build-retry`,
                  'build',
                  false,
                  soakPlan
                );
                if (buildCode !== 0) {
                  exitCode = buildCode;
                  failureReason = `ai-code3 build (deploy preflight retry) exit=${buildCode}`;
                  stoppedAt = 'build';
                  break;
                }
                doc = readStages(projectRoot);
                pf = runDeployArtifactPreflight(projectRoot);
              }
              if (!pf.ok) {
                exitCode = 1;
                failureReason = pf.message || 'deploy preflight failed';
                stoppedAt = 'deploy';
                break;
              }
            }
            const pub = await runPublishDev(projectRoot, cfg, `${sessionId}-${phase}`, soakPlan);
            if (pub !== 0) {
              exitCode = pub;
              failureReason = `ai-publish-dev3 exit=${pub}`;
              stoppedAt = 'deploy';
              break;
            }
            recordStageEvent(runId, 'deploy_smoke', pub, 0, false, `phase=${phase}`);
          } else if (stage === 'ui_e2e') {
            const e2e = await runE2e3(projectRoot, cfg, `${sessionId}-${phase}`, soakPlan);
            if (e2e !== 0) {
              exitCode = e2e;
              failureReason = `ai-e2e3 exit=${e2e}`;
              stoppedAt = 'ui_e2e';
              break;
            }
            recordStageEvent(runId, 'ui_e2e', e2e, 0, false, `phase=${phase}`);
          }
        }

        if (exitCode !== 0) {
          finishPhaseRun(phaseRunId, 'failed');
          break;
        }
        const phaseReportCode = await runGenReport(projectRoot, `${sessionId}-${phase}`, '');
        if (phaseReportCode !== 0) {
          appendLog(projectRoot, sessionId, `phase report warn: phase=${phase} exit=${phaseReportCode}`);
        }
        finishPhaseRun(phaseRunId, 'success');
        appendLog(projectRoot, sessionId, `phase done: ${phase}`);
      }
    }

    const ended = new Date().toISOString();
    doc = readStages(projectRoot);
    doc = appendPipelineLog(doc, {
      session_id: sessionId,
      path: path.join('.agent-sessions', 'logs', 'sessions', `${sessionId}.log`),
      started_at: new Date(t0).toISOString(),
      ended_at: ended,
      notes: exitCode === 0 ? 'completed' : failureReason || `exit ${exitCode}`,
    });
    writeStages(projectRoot, doc);

    if (runId) finishRun(runId, exitCode, stoppedAt || 'done');
    if (doc?.project?.project_id) clearProjectRuntimeState(doc.project.project_id, projectRoot, doc);
  } catch (e) {
    console.error(e);
    exitCode = 1;
    failureReason = String(e.message || e);
    if (runId) finishRun(runId, 1, 'exception');
    try {
      const d = readStages(projectRoot);
      if (d?.project?.project_id) clearProjectRuntimeState(d.project.project_id, projectRoot, d);
    } catch (_) {
      /* noop */
    }
  } finally {
    lock.release();
  }

  const gr = await runGenReport(
    projectRoot,
    sessionId,
    failureReason || (exitCode ? `exit=${exitCode}` : '')
  );
  if (gr !== 0) console.error(`warning: gen-report exited ${gr}`);

  appendLog(
    projectRoot,
    sessionId,
    `autorun end exit=${exitCode} report see stages.report.outputs.report_path`
  );
  maybeHintRollback(readStages(projectRoot));
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

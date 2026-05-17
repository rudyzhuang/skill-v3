'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isStageDone, STAGE_KEYS, stageRow } = require('./summary.cjs');

const FEATURE_GROUPS_LIB = path.resolve(
  __dirname,
  '../../../ai-auto3/scripts/lib/feature-groups.cjs'
);
const FEATURE_STAGES_LIB = path.resolve(
  __dirname,
  '../../../ai-auto3/scripts/lib/feature-stages.cjs'
);
let collectFeatureMeta;
let featureStages;
try {
  collectFeatureMeta = require(FEATURE_GROUPS_LIB).collectFeatureMeta;
} catch {
  collectFeatureMeta = null;
}
try {
  featureStages = require(FEATURE_STAGES_LIB);
} catch {
  featureStages = null;
}

function collectPhasePlans(doc) {
  const phases = doc?.stages?.prd_review?.review?.phase_plan || [];
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
    if (ids.length) out.push({ phase, feature_ids: ids });
  }
  return out;
}

function collectDeferredIds(doc) {
  const raw = doc?.stages?.prd_review?.review?.deferred_features || [];
  const out = new Set();
  for (const row of raw) {
    const id = String(row?.feature_id || row?.id || '').trim();
    if (id) out.add(id);
  }
  return out;
}

function worktreeFeatureIds(doc) {
  const rows = doc?.stages?.codegen?.outputs?.worktrees || [];
  const out = new Set();
  for (const r of rows) {
    const id = String(r?.feature_id || '').trim();
    if (id) out.add(id);
  }
  return out;
}

/** `.pipeline/worktrees/v3-fc-<feature_id>/` 目录（stages 可能未合并全量 worktrees） */
function worktreesOnDisk(projectRoot) {
  const dir = path.join(projectRoot, '.pipeline', 'worktrees');
  const out = new Set();
  if (!fs.existsSync(dir)) return out;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = /^v3-fc-(.+)$/.exec(name);
    if (m && m[1]) out.add(m[1]);
  }
  return out;
}

function collectFeatureWorktreeIds(doc, projectRoot) {
  const out = new Set(worktreeFeatureIds(doc || {}));
  for (const fid of worktreesOnDisk(projectRoot)) out.add(fid);
  return out;
}

function loadStagesDoc(projectRoot, doc) {
  if (doc && typeof doc === 'object') {
    return featureStages ? featureStages.backfillFeatureStages(doc) : doc;
  }
  const fp = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return featureStages ? featureStages.backfillFeatureStages(parsed) : parsed;
  } catch {
    return null;
  }
}

function featureStageStatus(doc, stageKey, featureId) {
  if (!featureStages) return null;
  const row = featureStages.getFeatureStageRow(doc, stageKey, featureId);
  return row?.status ? String(row.status) : null;
}

/** 任一 stage 的 features[].status 为 running 时，返回最先匹配的阶段键（已完成阶段跳过） */
function findFeatureRunningStage(doc, featureId) {
  const fid = String(featureId || '').trim();
  if (!fid || !featureStages) return null;
  for (const key of STAGE_KEYS) {
    if (featureStages.isFeatureStageCompleted(doc, key, fid)) continue;
    if (featureStageStatus(doc, key, fid) === 'running') return key;
  }
  return null;
}

/** Agent 正在处理该 feature（仅 features[].status=running，不含排队/worktree 启发式） */
function isFeatureAgentRunning(doc, featureId) {
  return !!findFeatureRunningStage(doc, featureId);
}

/**
 * 仅统计 Agent running 时段：started_at / elapsed 来自 running 行的 features[]。
 * 暂停或非 running 时不展示计时。
 * last_heartbeat_at：stage 脚本心跳写入，可用于检测 agent 是否卡死（>5 min 无心跳）。
 */
function deriveAgentRunningTiming(doc, featureId) {
  const runningKey = findFeatureRunningStage(doc, featureId);
  if (!runningKey || !featureStages) {
    return { stage_started_at: null, stage_elapsed_ms: null, agent_running_stage: null, last_heartbeat_at: null };
  }
  const row = featureStages.getFeatureStageRow(doc, runningKey, featureId);
  const started = row?.started_at ? String(row.started_at).trim() : '';
  const lastHb = row?.last_heartbeat_at ? String(row.last_heartbeat_at).trim() : null;
  if (!started) {
    return { stage_started_at: null, stage_elapsed_ms: null, agent_running_stage: runningKey, last_heartbeat_at: lastHb };
  }
  const ms = Date.parse(started);
  return {
    stage_started_at: started,
    stage_elapsed_ms: Number.isFinite(ms) ? Math.max(0, Date.now() - ms) : null,
    agent_running_stage: runningKey,
    last_heartbeat_at: lastHb,
  };
}

/** @returns {object|undefined} */
function codegenWorktreeRecord(doc, featureId) {
  const fid = String(featureId || '').trim();
  if (!doc || !fid) return undefined;
  const rows = doc?.stages?.codegen?.outputs?.worktrees || [];
  return rows.find((r) => String(r?.feature_id || '').trim() === fid);
}

/**
 * health-full 脚手架：仅初始化提交 + 未提交工件（非 Agent 完成态）
 */
function worktreeHasFeatureSrc(projectRoot, featureId) {
  const wt = worktreePath(projectRoot, featureId);
  if (!fs.existsSync(wt)) return false;
  const src = path.join(wt, 'src');
  if (!fs.existsSync(src)) return false;
  try {
    return fs.readdirSync(src).some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

function isScaffoldOnlyWorktree(projectRoot, featureId) {
  const wt = worktreePath(projectRoot, featureId);
  if (!fs.existsSync(wt) || !worktreeHasFeatureSrc(projectRoot, featureId)) return false;
  try {
    const count = Number(
      execFileSync('git', ['-C', wt, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
    );
    const porcelain = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' });
    return Number.isFinite(count) && count <= 1 && porcelain.trim().length > 0;
  } catch {
    return false;
  }
}

function testFeatureRow(doc, featureId) {
  const fid = String(featureId || '').trim();
  const rows = doc?.stages?.test?.features || doc?.stages?.test?.outputs?.per_feature || [];
  return rows.find((r) => String(r?.feature_id || '').trim() === fid);
}

/** @deprecated */
const testPerFeatureRow = testFeatureRow;

function testPerFeaturePassed(doc, featureId) {
  if (featureStages?.isFeatureStageCompleted(doc, 'test', featureId)) return true;
  const row = testFeatureRow(doc, featureId);
  if (!row) return false;
  const st = featureStages ? featureStages.normalizeFeatureStatus(row.status) : String(row.status || '');
  if (st === 'completed') return true;
  const result = String(row.test_result || row.result || '').toLowerCase();
  if (row.passed === true || result === 'passed' || result === 'success') return true;
  return false;
}

function testPerFeatureFailed(doc, featureId) {
  if (featureStages) {
    const row = featureStages.getFeatureStageRow(doc, 'test', featureId);
    if (featureStages.normalizeFeatureStatus(row?.status) === 'failed') return true;
  }
  const row = testFeatureRow(doc, featureId);
  if (!row) return false;
  const st = featureStages ? featureStages.normalizeFeatureStatus(row.status) : String(row.status || '');
  if (st === 'failed') return true;
  const result = String(row.test_result || row.result || '').toLowerCase();
  if (row.passed === false || result === 'failed' || result === 'failure') return true;
  return false;
}

/** 看板「已完成」：该 feature 在 test 阶段已通过（与 codegen 落盘分离） */
function isFeaturePipelineCompleted(doc, featureId) {
  return testPerFeaturePassed(doc, featureId);
}

function isTestStageRunning(doc) {
  return String(doc?.stages?.test?.status || '') === 'running';
}

/**
 * feature 级 codegen 是否完成。
 * 真源：`stages.codegen.features[].status`（经 feature-stages）；worktree/git 仅作旧项目回退。
 * @param {string} projectRoot
 * @param {string} featureId
 * @param {object|null} [doc] stages.json
 */
function isFeatureCodegenDone(projectRoot, featureId, doc) {
  const fid = String(featureId || '').trim();
  if (!fid) return false;
  const stages = loadStagesDoc(projectRoot, doc);

  if (featureStages && featureStages.isFeatureStageCompleted(stages, 'codegen', fid)) {
    return true;
  }

  const wtRow = codegenWorktreeRecord(stages, fid);
  if (wtRow) {
    const commit = String(wtRow.commit || '').trim();
    const changed = Array.isArray(wtRow.files_changed) ? wtRow.files_changed.length : 0;
    const testChanged = Array.isArray(wtRow.test_files_changed) ? wtRow.test_files_changed.length : 0;
    if (commit || changed > 0 || testChanged > 0) return true;
  }

  if (stages && testPerFeaturePassed(stages, fid)) return true;

  const wt = worktreePath(projectRoot, fid);
  if (!fs.existsSync(wt)) return false;
  if (isScaffoldOnlyWorktree(projectRoot, fid)) return false;

  if (worktreeHasFeatureSrc(projectRoot, fid)) {
    try {
      const count = Number(
        execFileSync('git', ['-C', wt, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
      );
      if (Number.isFinite(count) && count > 1) return true;
    } catch {
      /* 非 git worktree */
    }
  }

  return false;
}

/**
 * 本期尚未完成 codegen 的 feature_id 列表（供 autorun pending_features_json）
 * @param {string} projectRoot
 * @param {string[]} featureIds
 * @param {object|null} [doc]
 */
function filterRemainingCodegenQueue(projectRoot, featureIds, doc) {
  const stages = loadStagesDoc(projectRoot, doc);
  return featureIds.filter((fid) => !isFeatureCodegenDone(projectRoot, fid, stages));
}

function buildPhaseOrderIndex(phases) {
  const idx = new Map();
  let n = 0;
  for (const { feature_ids: featureIds } of phases) {
    for (const fid of featureIds) {
      if (!idx.has(fid)) idx.set(fid, n++);
    }
  }
  return idx;
}

function sortFeaturesByPriority(features, doc, projectRoot, orderIndex) {
  if (!features.length) return features;
  const ids = features.map((f) => f.feature_id);
  const tierById = new Map();
  if (collectFeatureMeta && doc) {
    const { meta } = collectFeatureMeta(ids, doc, projectRoot);
    for (const id of ids) tierById.set(id, meta.get(id)?.tier ?? 3);
  } else {
    for (const id of ids) tierById.set(id, 3);
  }
  return features.slice().sort((a, b) => {
    const ta = tierById.get(a.feature_id) ?? 3;
    const tb = tierById.get(b.feature_id) ?? 3;
    if (ta !== tb) return ta - tb;
    const oa = orderIndex.get(a.feature_id) ?? 9999;
    const ob = orderIndex.get(b.feature_id) ?? 9999;
    if (oa !== ob) return oa - ob;
    return String(a.feature_id).localeCompare(String(b.feature_id));
  });
}

function parsePendingFeatures(runtime) {
  if (!runtime) return new Set();
  if (Array.isArray(runtime.pending_features)) {
    return new Set(runtime.pending_features.map((x) => String(x).trim()).filter(Boolean));
  }
  if (!runtime.pending_features_json) return new Set();
  try {
    const arr = JSON.parse(runtime.pending_features_json);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((x) => String(x).trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** 从 runtime 排队列表中剔除已在 stages 标记 codegen 完成的 id（避免看板全员「处理中」） */
function effectivePendingCodegenQueue(projectRoot, doc, runtime) {
  const raw = parsePendingFeatures(runtime);
  if (!raw.size) return raw;
  const stages = loadStagesDoc(projectRoot, doc);
  const out = new Set();
  for (const fid of raw) {
    if (!isFeatureCodegenDone(projectRoot, fid, stages)) out.add(fid);
  }
  return out;
}

/**
 * 解析各端 feature_list.md Features 表（首列 Feature ID）
 */
function parseFeatureLists(projectRoot, doc) {
  const meta = {};
  const targets = [
    ...(doc?.client_targets?.declared || []),
    ...(doc?.client_targets?.generated || []),
  ];
  const seen = new Set();
  for (const slug of targets) {
    const s = String(slug || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    const fp = path.join(projectRoot, 'docs', s, 'feature_list.md');
    if (!fs.existsSync(fp)) continue;
    let text;
    try {
      text = fs.readFileSync(fp, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    let inTable = false;
    for (const line of lines) {
      if (line.startsWith('## Features')) {
        inTable = true;
        continue;
      }
      if (inTable && line.startsWith('## ')) break;
      if (!inTable) continue;
      if (!line.trim().startsWith('|')) continue;
      if (/^\|\s*Feature ID/i.test(line)) continue;
      if (/^\|\s*---/.test(line)) continue;
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter((c, i, a) => !(i === 0 && c === '') && !(i === a.length - 1 && c === ''));
      if (cells.length < 4) continue;
      const fid = cells[0].replace(/^`|`$/g, '').trim();
      if (!fid || fid.startsWith('<')) continue;
      const status = (cells[3] || 'draft').replace(/`/g, '').trim() || 'draft';
      if (!meta[fid]) {
        meta[fid] = { status, client_target: s, name: cells[2] || '' };
      }
    }
  }
  return meta;
}

function projectHasFailedStage(doc) {
  const st = doc?.stages || {};
  for (const k of Object.keys(st)) {
    if (String(st[k]?.status || '') === 'failed') return true;
  }
  return false;
}

function worktreePath(projectRoot, featureId) {
  return path.join(projectRoot, '.pipeline', 'worktrees', `v3-fc-${featureId}`);
}

/**
 * @returns {{ exists: boolean, mtimeMs: number|null, birthtimeMs: number|null }}
 */
function worktreeTimestamps(projectRoot, featureId) {
  const wt = worktreePath(projectRoot, featureId);
  if (!fs.existsSync(wt)) return { exists: false, mtimeMs: null, birthtimeMs: null };
  try {
    const st = fs.statSync(wt);
    const pkg = path.join(wt, 'package.json');
    const ref = fs.existsSync(pkg) ? fs.statSync(pkg) : st;
    return {
      exists: true,
      mtimeMs: ref.mtimeMs,
      birthtimeMs: st.birthtimeMs,
    };
  } catch {
    return { exists: true, mtimeMs: null, birthtimeMs: null };
  }
}

function globalStageStartedAt(doc, stageKey) {
  if (!doc || !stageKey) return null;
  const sk = String(stageKey).replace(/-/g, '_');
  const row = doc.stages?.[sk];
  const t = row?.started_at;
  return t && String(t).trim() ? String(t) : null;
}

function displayStageKey(stageKey) {
  return String(stageKey || '')
    .trim()
    .replace(/_/g, '-');
}

/**
 * 串行 codegen 时推断「当前正在做的」feature（至多一个）
 * @param {string[]} orderedIds phase_plan 顺序
 */
function pickActiveCodegenFeature(orderedIds, projectRoot, pendingQueue, doc) {
  const stages = loadStagesDoc(projectRoot, doc);
  for (const fid of orderedIds) {
    if (isFeatureCodegenDone(projectRoot, fid, stages)) continue;
    if (pendingQueue.has(fid) || worktreeTimestamps(projectRoot, fid).exists) {
      return fid;
    }
  }
  return null;
}

/**
 * @param {object} p
 */
function deriveFeatureStageFields(p) {
  const {
    fid,
    pipeline_status,
    codegenDone,
    testPassed,
    testFailed,
    testRunning,
    hasWorktree,
    currentStage,
    codegenRunning,
    isActiveCodegen,
    doc,
    wtTimes,
  } = p;

  let pipeline_stage = currentStage || 'not_started';
  let pipeline_stage_label = '未开始';
  let stage_started_at = null;

  if (pipeline_status === 'deferred') {
    pipeline_stage = 'deferred';
    pipeline_stage_label = '延期';
  } else if (pipeline_status === 'failed') {
    pipeline_stage = testFailed ? 'test' : currentStage || 'failed';
    pipeline_stage_label = testFailed ? 'test（未通过）' : '失败';
    const tRow = testPerFeatureRow(doc, fid);
    if (tRow?.finished_at) stage_started_at = String(tRow.finished_at);
    else stage_started_at = globalStageStartedAt(doc, 'test');
  } else if (pipeline_status === 'completed' && testPassed) {
    pipeline_stage = 'test';
    pipeline_stage_label = 'test（本 feature 已通过）';
    const tRow = testPerFeatureRow(doc, fid);
    stage_started_at =
      (tRow?.finished_at && String(tRow.finished_at)) ||
      globalStageStartedAt(doc, 'test') ||
      null;
    if (!stage_started_at && wtTimes.mtimeMs) {
      stage_started_at = new Date(wtTimes.mtimeMs).toISOString();
    }
  } else if (codegenDone && !testPassed) {
    const nextKey = testRunning
      ? 'test'
      : firstIncompleteStageFrom(doc, { ...p, fid, codegenDone, testPassed, testFailed, testRunning }, STAGE_KEYS.indexOf('codegen') + 1);
    pipeline_stage = nextKey;
    if (testRunning) {
      pipeline_stage_label = 'test（进行中）';
      stage_started_at = globalStageStartedAt(doc, 'test');
    } else if (nextKey === 'typecheck') {
      pipeline_stage_label = 'typecheck（待处理）';
      stage_started_at = globalStageStartedAt(doc, 'typecheck');
    } else if (nextKey === 'test') {
      pipeline_stage_label = 'test（待处理）';
      stage_started_at = globalStageStartedAt(doc, 'test');
    } else {
      pipeline_stage_label = `${displayStageKey(nextKey)}（待处理）`;
      stage_started_at = globalStageStartedAt(doc, nextKey);
    }
  } else if (pipeline_status === 'in_progress' && isActiveCodegen) {
    pipeline_stage = 'codegen';
    pipeline_stage_label = 'codegen（进行中）';
    stage_started_at = wtTimes.birthtimeMs
      ? new Date(wtTimes.birthtimeMs).toISOString()
      : wtTimes.mtimeMs
        ? new Date(wtTimes.mtimeMs).toISOString()
        : globalStageStartedAt(doc, 'codegen');
  } else if (hasWorktree && !codegenDone) {
    pipeline_stage = 'codegen';
    pipeline_stage_label = 'codegen（脚手架/未完成）';
    stage_started_at = wtTimes.birthtimeMs
      ? new Date(wtTimes.birthtimeMs).toISOString()
      : null;
  } else if (codegenRunning && currentStage === 'codegen') {
    pipeline_stage = 'codegen';
    pipeline_stage_label = 'codegen（排队）';
    stage_started_at = null;
  } else if (pipeline_status === 'pending') {
    pipeline_stage = currentStage || 'not_started';
    if (currentStage === 'codegen') {
      pipeline_stage_label = 'codegen（未开始）';
    } else if (currentStage) {
      pipeline_stage_label = `${displayStageKey(currentStage)}（未开始）`;
      stage_started_at = globalStageStartedAt(doc, currentStage);
    } else {
      pipeline_stage_label = '未开始';
    }
  } else if (currentStage) {
    pipeline_stage = currentStage;
    pipeline_stage_label = `${displayStageKey(currentStage)}（未开始本 feature）`;
    stage_started_at = globalStageStartedAt(doc, currentStage);
  }

  let stage_elapsed_ms = null;
  if (stage_started_at) {
    const ms = Date.parse(stage_started_at);
    if (Number.isFinite(ms)) stage_elapsed_ms = Math.max(0, Date.now() - ms);
  }

  return {
    pipeline_stage,
    pipeline_stage_label,
    stage_started_at,
    stage_elapsed_ms,
  };
}

function firstIncompleteStageFrom(doc, ctx, startIdx) {
  const from = Math.max(0, startIdx);
  for (let i = from; i < STAGE_KEYS.length; i++) {
    const key = STAGE_KEYS[i];
    if (!isStageCompletedForFeature(doc, key, ctx)) return key;
  }
  return STAGE_KEYS[STAGE_KEYS.length - 1] || 'report';
}

function normalizeFeatureCurrentStageKey(pipelineStage, ctx, doc) {
  const k = String(pipelineStage || '').trim();
  if (ctx.testPassed && doc) {
    return firstIncompleteStageFrom(doc, ctx, STAGE_KEYS.indexOf('test') + 1);
  }
  if (k && !['not_started', 'deferred', 'failed'].includes(k)) return k;
  if (ctx.pipeline_status === 'deferred') return 'deferred';
  if (ctx.testFailed) return 'test';
  if (ctx.codegenDone && !ctx.testPassed) {
    if (ctx.testRunning) return 'test';
    return firstIncompleteStageFrom(doc, ctx, STAGE_KEYS.indexOf('codegen') + 1);
  }
  if (ctx.isActiveCodegen) return 'codegen';
  const proj = String(ctx.pipelineCurrentStage || '').trim();
  return proj || 'codegen';
}

function isStageCompletedForFeature(doc, key, ctx) {
  const fid = String(ctx.fid || '').trim();
  if (fid && featureStages) {
    if (featureStages.isFeatureStageCompleted(doc, key, fid)) return true;
    const st = featureStages.normalizeFeatureStatus(
      featureStages.getFeatureStageRow(doc, key, fid)?.status
    );
    if (st === 'failed' || st === 'skipped') return false;
  }
  const row = stageRow(doc, key);
  const keyIdx = STAGE_KEYS.indexOf(key);
  const codegenIdx = STAGE_KEYS.indexOf('codegen');
  const testIdx = STAGE_KEYS.indexOf('test');
  if (key === 'codegen') return ctx.codegenDone;
  if (key === 'test') return ctx.testPassed;
  if (keyIdx >= 0 && keyIdx < codegenIdx) {
    if (fid && featureStages) {
      return featureStages.isFeatureStageCompleted(doc, key, fid);
    }
    return row.status === 'completed' && row.validation_passed !== false;
  }
  if (key === 'typecheck' || key === 'code_review') {
    if (!ctx.codegenDone) return false;
    if (fid && featureStages) return featureStages.isFeatureStageCompleted(doc, key, fid);
    return row.status === 'completed';
  }
  if (keyIdx > testIdx) {
    if (!ctx.testPassed) return false;
    if (fid && featureStages) return featureStages.isFeatureStageCompleted(doc, key, fid);
    return row.status === 'completed';
  }
  return false;
}

/** 当前阶段状态：仅 pending | running | failed | deferred（不含 completed） */
function deriveCurrentStageStatus(doc, currentKey, ctx) {
  if (ctx.blockedInList) return 'failed';
  if (currentKey === 'deferred' || ctx.pipeline_status === 'deferred') return 'deferred';
  const fid = String(ctx.fid || '').trim();
  if (currentKey === 'codegen' && ctx.codegenDone) return 'pending';
  if (fid && featureStages) {
    const explicit = featureStageStatus(doc, currentKey, fid);
    const norm = explicit ? featureStages.normalizeFeatureStatus(explicit) : '';
    if (norm === 'running' && !(currentKey === 'codegen' && ctx.codegenDone)) return 'running';
    if (norm === 'failed') return 'failed';
    if (norm === 'skipped') return 'deferred';
    if (norm === 'completed') return 'pending';
    if (norm === 'not_started') return 'pending';
  }
  if (currentKey === 'codegen') {
    if (ctx.codegenDone) return 'pending';
    if (ctx.pipeline_status === 'failed' && !ctx.testFailed) return 'failed';
    const st = String(doc?.stages?.codegen?.status || '');
    if (st === 'failed') return 'failed';
    return 'pending';
  }
  if (currentKey === 'test') {
    if (ctx.testFailed) return 'failed';
    if (ctx.pipeline_status === 'failed' && ctx.testFailed !== false) return 'failed';
    const st = String(doc?.stages?.test?.status || '');
    if (st === 'failed') return 'failed';
    return 'pending';
  }
  const row = stageRow(doc, currentKey);
  if (row.status === 'failed') return 'failed';
  if (ctx.pipeline_status === 'failed') return 'failed';
  return 'pending';
}

function isProjectUiE2eDone(doc) {
  const s = doc?.stages?.ui_e2e;
  if (!s) return false;
  return String(s.status || '') === 'completed';
}

function isFeaturePrdNotStarted(doc, ctx) {
  const prd = stageRow(doc, 'prd');
  if (prd.status === 'running' || prd.status === 'completed') return false;
  if (ctx.codegenDone || ctx.hasWorktree || ctx.isActiveCodegen || ctx.testPassed || ctx.testRunning) {
    return false;
  }
  return true;
}

/**
 * 整条 feature 状态：completed | pending | running | paused
 * - 已完成：per-feature test 通过且项目 ui_e2e 已完成
 * - 待处理：prd 尚未开始且本 feature 未动工
 * - running：stages.*.features[] 该 feature 的 status=running（Agent 处理中）
 * - 暂停中：其余（含排队、待测、项目阶段 running 但未标 feature running）
 */
function deriveFeatureOverallStatus(doc, ctx) {
  if (ctx.pipeline_status === 'deferred') {
    return { feature_status: 'paused', feature_status_reason: 'deferred' };
  }
  if (ctx.testPassed && isProjectUiE2eDone(doc)) {
    return { feature_status: 'completed', feature_status_reason: 'test_and_ui_e2e_done' };
  }
  const fid = String(ctx.fid || '').trim();
  if (fid && isFeatureAgentRunning(doc, fid)) {
    return { feature_status: 'running', feature_status_reason: 'agent_running' };
  }
  if (isFeaturePrdNotStarted(doc, ctx)) {
    return { feature_status: 'pending', feature_status_reason: 'prd_not_started' };
  }
  if (!isProjectUiE2eDone(doc)) {
    return { feature_status: 'paused', feature_status_reason: 'awaiting_ui_e2e' };
  }
  return { feature_status: 'paused', feature_status_reason: 'mid_pipeline' };
}

/** 各 pipeline stage 的 feature.status 快照（供看板矩阵展示） */
function buildFeatureStageStatusMap(doc, featureId) {
  const out = {};
  if (!featureStages) return out;
  const fid = String(featureId || '').trim();
  if (!fid) return out;
  for (const key of STAGE_KEYS) {
    if (key === 'prd') continue;
    const row = featureStages.getFeatureStageRow(doc, key, fid);
    out[key] = row?.status ? featureStages.normalizeFeatureStatus(row.status) : 'not_started';
  }
  return out;
}

function computeStageProgress(completedStages) {
  const total = STAGE_KEYS.length;
  const done = Array.isArray(completedStages) ? completedStages.length : 0;
  const stage_progress_pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return {
    stage_progress_pct,
    stage_total_count: total,
    stage_completed_count: done,
  };
}

/**
 * @param {object} doc
 * @param {string} fid
 * @param {object} stageFields from deriveFeatureStageFields
 * @param {object} ctx
 */
function deriveFeatureStageProgress(doc, fid, stageFields, ctx) {
  let currentKey = normalizeFeatureCurrentStageKey(stageFields.pipeline_stage, ctx, doc);
  const runningKey = findFeatureRunningStage(doc, fid);
  if (runningKey) currentKey = runningKey;
  const currentIdx = STAGE_KEYS.indexOf(currentKey);
  const completed = [];
  if (currentKey === 'deferred') {
    return {
      completed_stages: [],
      completed_stages_label: '—',
      current_stage: 'deferred',
      current_stage_label: '延期',
      current_stage_status: 'deferred',
      feature_status: 'paused',
      feature_status_reason: 'deferred',
      ...computeStageProgress([]),
    };
  }
  for (const key of STAGE_KEYS) {
    if (currentIdx >= 0 && STAGE_KEYS.indexOf(key) >= currentIdx) break;
    if (isStageCompletedForFeature(doc, key, ctx)) completed.push(key);
  }
  const current_stage_status = deriveCurrentStageStatus(doc, currentKey, ctx);
  const overall = deriveFeatureOverallStatus(doc, ctx);
  return {
    completed_stages: completed,
    completed_stages_label:
      completed.length > 0 ? completed.map((k) => displayStageKey(k)).join(', ') : '—',
    current_stage: currentKey,
    current_stage_label: displayStageKey(currentKey),
    current_stage_status,
    ...overall,
    ...computeStageProgress(completed),
  };
}

/**
 * @param {object} doc stages.json
 * @param {string} projectRoot
 * @param {object|null} runtime registry project_runtime_state row
 * @param {{ alive?: boolean|null }} pidLock
 */
function buildFeatureBoard(doc, projectRoot, runtime, pidLock) {
  const phases = collectPhasePlans(doc || {});
  const deferred = collectDeferredIds(doc || {});
  const listMeta = doc ? parseFeatureLists(projectRoot, doc) : {};
  const worktrees = collectFeatureWorktreeIds(doc, projectRoot);
  const pendingQueue = effectivePendingCodegenQueue(projectRoot, doc, runtime);
  const projectFailed = doc ? projectHasFailedStage(doc) : false;
  const currentPhase = runtime?.current_phase ? String(runtime.current_phase) : '';
  const currentStage = runtime?.current_stage ? String(runtime.current_stage) : '';
  const pidLockAlive = pidLock?.alive === true;
  const codegenRunning = String(doc?.stages?.codegen?.status || '') === 'running';
  const pipelineCurrentStage =
    (doc?.pipeline?.current_stage && String(doc.pipeline.current_stage)) ||
    currentStage ||
    '';

  const allOrderedIds = [];
  for (const { feature_ids: featureIds } of phases) {
    for (const fid of featureIds) allOrderedIds.push(fid);
  }
  const orderIndex = buildPhaseOrderIndex(phases);
  const tierById = new Map();
  if (collectFeatureMeta && doc) {
    const { meta } = collectFeatureMeta(allOrderedIds, doc, projectRoot);
    for (const fid of allOrderedIds) tierById.set(fid, meta.get(fid)?.tier ?? 3);
  }

  const activeCodegenFid =
    codegenRunning || pidLockAlive
      ? pickActiveCodegenFeature(allOrderedIds, projectRoot, pendingQueue, doc)
      : null;

  const features = [];
  for (const { phase, feature_ids: featureIds } of phases) {
    for (const fid of featureIds) {
      let pipeline_status = 'pending';
      const hints = [];
      const codegenDone = isFeatureCodegenDone(projectRoot, fid, doc);
      const testPassed = testPerFeaturePassed(doc, fid);
      const testFailed = testPerFeatureFailed(doc, fid);
      const testRunning = isTestStageRunning(doc);
      const hasWorktree = worktrees.has(fid);
      const wtTimes = worktreeTimestamps(projectRoot, fid);
      const isActiveCodegen = fid === activeCodegenFid;

      if (deferred.has(fid)) {
        pipeline_status = 'deferred';
        hints.push('deferred_in_prd_review');
      } else if (listMeta[fid]?.status === 'blocked') {
        pipeline_status = 'failed';
        hints.push('blocked_in_feature_list');
      } else if (testFailed) {
        pipeline_status = 'failed';
        hints.push('test_per_feature_failed');
      } else if (projectFailed && (pendingQueue.has(fid) || phase === currentPhase)) {
        pipeline_status = 'failed';
        hints.push('project_stage_failed');
      } else if (testPassed && isProjectUiE2eDone(doc)) {
        pipeline_status = 'completed';
        hints.push('test_per_feature_passed');
        hints.push('ui_e2e_done');
        if (codegenDone) hints.push('codegen_done');
      } else if (testPassed) {
        pipeline_status = 'pending';
        hints.push('test_per_feature_passed');
        hints.push('awaiting_ui_e2e');
        if (codegenDone) hints.push('codegen_done');
      } else if (codegenDone && testRunning) {
        pipeline_status = 'in_progress';
        hints.push('codegen_done_test_running');
      } else if (codegenDone) {
        pipeline_status = 'pending';
        hints.push('codegen_done_awaiting_test');
        if (hasWorktree) hints.push('has_worktree');
      } else if (isActiveCodegen) {
        pipeline_status = 'in_progress';
        hints.push('active_codegen_feature');
        if (hasWorktree) hints.push('has_worktree');
      } else if (hasWorktree) {
        pipeline_status = 'pending';
        hints.push('worktree_incomplete_not_active');
      } else if (pendingQueue.has(fid)) {
        pipeline_status = 'pending';
        hints.push('queued_for_codegen');
      } else {
        pipeline_status = 'pending';
      }

      const stageCtx = {
        fid,
        pipeline_status,
        codegenDone,
        testPassed,
        testFailed,
        testRunning,
        hasWorktree,
        pendingInQueue: pendingQueue.has(fid),
        blockedInList: listMeta[fid]?.status === 'blocked',
        projectStageFailed:
          projectFailed && (pendingQueue.has(fid) || phase === currentPhase),
        pipelineCurrentStage: pipelineCurrentStage || currentStage,
        codegenRunning,
        isActiveCodegen,
      };
      const stageFields = deriveFeatureStageFields({
        ...stageCtx,
        currentStage: pipelineCurrentStage || currentStage,
        doc,
        wtTimes,
      });
      const stageProgress = deriveFeatureStageProgress(doc, fid, stageFields, stageCtx);
      const feature_status = stageProgress.feature_status || pipeline_status;
      const agentTiming = deriveAgentRunningTiming(doc, fid);
      const timing =
        feature_status === 'running'
          ? agentTiming
          : { stage_started_at: null, stage_elapsed_ms: null, agent_running_stage: null };

      features.push({
        feature_id: fid,
        phase,
        name: listMeta[fid]?.name || '',
        list_status: listMeta[fid]?.status || null,
        client_target: listMeta[fid]?.client_target || null,
        priority_tier: tierById.get(fid) ?? 3,
        pipeline_status: feature_status,
        feature_status,
        stage_feature_status: buildFeatureStageStatusMap(doc, fid),
        hints,
        ...stageFields,
        ...stageProgress,
        stage_started_at: timing.stage_started_at,
        stage_elapsed_ms: timing.stage_elapsed_ms,
        agent_running_stage: timing.agent_running_stage,
        last_heartbeat_at: timing.last_heartbeat_at,
      });
    }
  }

  const sortedFeatures = sortFeaturesByPriority(features, doc, projectRoot, orderIndex);

  return {
    phases: phases.map((p) => ({ phase: p.phase, feature_ids: p.feature_ids.slice() })),
    features: sortedFeatures,
    runtime: runtime
      ? {
          active_run_id: runtime.active_run_id || null,
          current_phase: currentPhase || null,
          current_stage: currentStage || null,
          pending_features: [...pendingQueue],
          updated_at: runtime.updated_at || null,
        }
      : {
          active_run_id: null,
          current_phase: null,
          current_stage: null,
          pending_features: [],
          updated_at: null,
        },
    autorun_active: pidLockAlive,
    registry_run_active_hint: !pidLockAlive && !!runtime?.active_run_id,
    active_codegen_feature_id: activeCodegenFid,
  };
}

module.exports = {
  collectPhasePlans,
  buildFeatureBoard,
  parseFeatureLists,
  worktreesOnDisk,
  isFeatureCodegenDone,
  isFeaturePipelineCompleted,
  isScaffoldOnlyWorktree,
  collectFeatureWorktreeIds,
  filterRemainingCodegenQueue,
  sortFeaturesByPriority,
  buildPhaseOrderIndex,
};

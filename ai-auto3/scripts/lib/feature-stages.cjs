'use strict';

const fs = require('fs');
const path = require('path');
const agentLog = require('../../../scripts/lib/agent-sessions-log.cjs');

/** 与 dash3 / stages.json.template 对齐 */
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
  'ui_e2e',
  'report',
];

/** stages.<k>.inputs.requires_stage */
const REQUIRES_STAGE = {
  prd_review: 'prd',
  design: 'prd_review',
  contract: 'design',
  design_review: 'contract',
  codegen: 'design_review',
  typecheck: 'codegen',
  test: 'typecheck',
  code_review: 'test',
  merge_push: 'code_review',
  build: 'merge_push',
  deploy: 'build',
  smoke: 'deploy',
  ui_e2e: 'smoke',
  report: null,
};

/** feature.status 终态（与 input-spec §7.1.1 一致） */
const TERMINAL_FEATURE = new Set(['completed', 'failed', 'skipped']);

/** @type {Set<string>} */
const FEATURE_STATUS_ENUM = new Set(['not_started', 'running', 'completed', 'failed', 'skipped']);

function isoNow() {
  return new Date().toISOString();
}

/**
 * 归一化 feature.status（读路径兼容 complete / pending / deferred）
 * @param {string} raw
 * @returns {string}
 */
function normalizeFeatureStatus(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return 'not_started';
  if (s === 'complete') return 'completed';
  if (s === 'pending') return 'not_started';
  if (s === 'deferred') return 'skipped';
  if (FEATURE_STATUS_ENUM.has(s)) return s;
  return 'not_started';
}

function collectPhaseFeatureIds(doc) {
  const phases = doc?.stages?.prd_review?.review?.phase_plan || [];
  const out = [];
  const seen = new Set();
  for (const row of phases) {
    for (const fid of row?.feature_ids || []) {
      const id = String(fid || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function collectDeferredFeatureIds(doc) {
  const raw = doc?.stages?.prd_review?.review?.deferred_features || [];
  const out = new Set();
  for (const row of raw) {
    const id = String(row?.feature_id || row?.id || row || '').trim();
    if (id) out.add(id);
  }
  return out;
}

function stageBlock(doc, stageKey) {
  return doc?.stages?.[stageKey] || {};
}

function projectStageCompleted(doc, stageKey) {
  const s = stageBlock(doc, stageKey);
  if (!s || !s.status) return false;
  const st = String(s.status);
  if (st === 'completed' || st === 'skipped') {
    if (s.validation && s.validation.passed === false) return false;
    return true;
  }
  return false;
}

/** @deprecated 读路径：outputs.per_feature */
function legacyPerFeatureArray(doc, stageKey) {
  const outs = stageBlock(doc, stageKey).outputs || {};
  if (Array.isArray(outs.per_feature)) return outs.per_feature;
  return null;
}

function featuresArray(doc, stageKey) {
  const block = stageBlock(doc, stageKey);
  if (Array.isArray(block.features)) return block.features;
  const legacy = legacyPerFeatureArray(doc, stageKey);
  if (legacy) return legacy;
  return null;
}

function findFeatureRow(doc, stageKey, featureId) {
  const fid = String(featureId || '').trim();
  const arr = featuresArray(doc, stageKey);
  if (!arr || !fid) return null;
  return arr.find((r) => String(r?.feature_id || '').trim() === fid) || null;
}

/** @deprecated */
const findPerFeatureRow = findFeatureRow;

/** 从既有 outputs 结构推断 feature 行（只读；不写回） */
function legacyFeatureRow(doc, stageKey, featureId) {
  const fid = String(featureId || '').trim();
  if (!fid) return null;
  const outs = stageBlock(doc, stageKey).outputs || {};

  if (stageKey === 'design') {
    const spec = (outs.design_specs || []).find((r) => String(r?.feature_id || '').trim() === fid);
    if (!spec) return null;
    const st = String(spec.status || '').toLowerCase();
    if (st === 'approved' || st === 'completed') return { feature_id: fid, status: 'completed' };
    if (st === 'draft') return { feature_id: fid, status: 'not_started' };
    return { feature_id: fid, status: 'not_started' };
  }

  if (stageKey === 'contract') {
    const art = (outs.artifacts || []).find((r) => String(r?.feature_id || '').trim() === fid);
    if (!art) return null;
    const filled = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'].every(
      (k) => typeof art[k] === 'string' && art[k].trim()
    );
    return { feature_id: fid, status: filled ? 'completed' : 'not_started' };
  }

  if (stageKey === 'codegen') {
    const wt = (outs.worktrees || []).find((r) => String(r?.feature_id || '').trim() === fid);
    if (!wt) return null;
    if (wt.commit || (Array.isArray(wt.files_changed) && wt.files_changed.length)) {
      return { feature_id: fid, status: 'completed' };
    }
    if (wt.worktree_path) return { feature_id: fid, status: 'running' };
    return null;
  }

  if (stageKey === 'test') {
    const legacyPf = legacyPerFeatureArray(doc, stageKey) || [];
    const row = legacyPf.find((r) => String(r?.feature_id || '').trim() === fid);
    if (!row) return null;
    const result = String(row.result || row.status || '').toLowerCase();
    if (row.passed === true || result === 'passed' || result === 'success') {
      return { feature_id: fid, status: 'completed', ...row };
    }
    if (row.passed === false || result === 'failed' || result === 'failure') {
      return { feature_id: fid, status: 'failed', ...row };
    }
    return { feature_id: fid, status: 'not_started', ...row };
  }

  return null;
}

/**
 * @returns {{ feature_id: string, status: string, started_at?: string|null, completed_at?: string|null, message?: string }|null}
 */
function getFeatureStageRow(doc, stageKey, featureId) {
  const direct = findFeatureRow(doc, stageKey, featureId);
  const legacy = legacyFeatureRow(doc, stageKey, featureId);
  if (direct?.status) {
    const norm = normalizeFeatureStatus(direct.status);
    if (norm !== 'not_started') return { ...direct, status: norm };
    if (legacy?.status) {
      const ln = normalizeFeatureStatus(legacy.status);
      if (ln !== 'not_started') return { ...legacy, status: ln };
    }
    return { ...direct, status: norm };
  }
  if (legacy?.status) {
    return { ...legacy, status: normalizeFeatureStatus(legacy.status) };
  }
  return null;
}

function isFeatureStageCompleted(doc, stageKey, featureId) {
  const row = getFeatureStageRow(doc, stageKey, featureId);
  const st = normalizeFeatureStatus(row?.status);
  return st === 'completed' || st === 'skipped';
}

function isPreviousStageDoneForFeature(doc, stageKey, featureId) {
  const prev = REQUIRES_STAGE[stageKey];
  if (!prev) return true;
  if (prev === 'prd') return projectStageCompleted(doc, 'prd');
  return isFeatureStageCompleted(doc, prev, featureId);
}

function ensureStageBlock(doc, stageKey) {
  if (!doc.stages) doc.stages = {};
  if (!doc.stages[stageKey]) doc.stages[stageKey] = {};
  if (!Array.isArray(doc.stages[stageKey].features)) {
    doc.stages[stageKey].features = [];
  }
  return doc.stages[stageKey].features;
}

function upsertFeature(doc, stageKey, featureId, patch) {
  const fid = String(featureId || '').trim();
  if (!fid) return doc;
  const arr = ensureStageBlock(doc, stageKey);
  const idx = arr.findIndex((r) => String(r?.feature_id || '').trim() === fid);
  const prev = idx >= 0 ? arr[idx] : { feature_id: fid, status: 'not_started' };
  const nextStatus = patch.status != null ? normalizeFeatureStatus(patch.status) : prev.status;
  const next = { ...prev, feature_id: fid, ...patch, status: nextStatus };
  if (idx >= 0) arr[idx] = next;
  else arr.push(next);
  return doc;
}

/** @deprecated 使用 upsertFeature */
const upsertPerFeature = upsertFeature;

const STAGES_JSON_SUBPATH = path.join('.pipeline', 'stages.json');

/**
 * §15 per-feature 心跳：将 last_heartbeat_at + elapsed_ms 写入 feature row。
 * 由各 stage 脚本在调用 agent / tool 前启动的 setInterval 中调用，每 30 s 一次。
 * 写入失败不阻断主流程（静默忽略异常）。
 * @param {string} projectRoot
 * @param {string} stageKey
 * @param {string} featureId
 * @param {string} startedAt  ISO 时间戳（markFeatureStage 写入的 started_at）
 */
function writeFeatureHeartbeat(projectRoot, stageKey, featureId, startedAt) {
  const fid = String(featureId || '').trim();
  if (!fid || !projectRoot) return;
  const p = path.join(projectRoot, STAGES_JSON_SUBPATH);
  try {
    if (!fs.existsSync(p)) return;
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const now = new Date().toISOString();
    const startMs = startedAt ? Date.parse(String(startedAt)) : 0;
    const elapsedMs = startMs > 0 ? Math.max(0, Date.now() - startMs) : 0;
    const patchedDoc = upsertFeature(doc, stageKey, fid, {
      last_heartbeat_at: now,
      elapsed_ms: elapsedMs,
    });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(patchedDoc, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, p);
  } catch {
    // 心跳失败不阻断主流程
  }
}

/**
 * 为 phase_plan 内 feature 在各非 prd stage 确保存在 not_started 行（不覆盖已有状态）
 */
function ensureFeatureRowsForPhasePlan(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const ids = collectPhaseFeatureIds(doc);
  if (!ids.length) return doc;

  for (const stageKey of STAGE_KEYS) {
    if (stageKey === 'prd') continue;
    const arr = ensureStageBlock(doc, stageKey);
    const have = new Set(arr.map((r) => String(r?.feature_id || '').trim()).filter(Boolean));
    for (const fid of ids) {
      if (have.has(fid)) continue;
      arr.push({
        feature_id: fid,
        status: 'not_started',
        started_at: null,
        completed_at: null,
        message: '',
      });
      have.add(fid);
    }
  }
  return doc;
}

/**
 * 旧项目：从 legacy 结构只读推断后补齐 features[]（仅补缺，不覆盖已有行）
 */
function backfillFeatureStages(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const ids = collectPhaseFeatureIds(doc);
  if (!ids.length) return doc;

  for (const stageKey of STAGE_KEYS) {
    if (stageKey === 'prd') continue;
    const arr = ensureStageBlock(doc, stageKey);
    const have = new Set(arr.map((r) => String(r?.feature_id || '').trim()).filter(Boolean));
    for (const fid of ids) {
      if (have.has(fid)) continue;
      const legacy = legacyFeatureRow(doc, stageKey, fid);
      if (legacy) {
        arr.push({
          feature_id: fid,
          status: normalizeFeatureStatus(legacy.status) || 'not_started',
          started_at: legacy.started_at || null,
          completed_at: legacy.completed_at || null,
          message: legacy.message || 'backfill_from_legacy_outputs',
        });
        have.add(fid);
      }
    }
    const legacyPf = legacyPerFeatureArray(doc, stageKey);
    if (legacyPf) {
      for (const row of legacyPf) {
        const fid = String(row?.feature_id || '').trim();
        if (!fid || have.has(fid)) continue;
        arr.push({
          ...row,
          feature_id: fid,
          status: normalizeFeatureStatus(row.status),
        });
        have.add(fid);
      }
    }
  }
  return ensureFeatureRowsForPhasePlan(doc);
}

function markStageRunning(doc, stageKey, updatedBy) {
  const now = isoNow();
  const st = stageBlock(doc, stageKey);
  if (!doc.stages[stageKey]) doc.stages[stageKey] = {};
  doc.stages[stageKey].status = 'running';
  if (!doc.stages[stageKey].started_at) doc.stages[stageKey].started_at = now;
  if (!doc.pipeline) doc.pipeline = {};
  doc.pipeline.current_stage = stageKey;
  doc.pipeline.updated_at = now;
  doc.pipeline.updated_by = updatedBy || st.updated_by || 'pipeline';
  return doc;
}

/**
 * 阶段开跑：仅标 stage 为 running + 确保 features[] 行存在；**不**批量改 feature.status（§1.3）
 */
function beginStageForFeatures(doc, opts) {
  const stageKey = opts.stageKey;
  const skill = opts.skill || 'pipeline';
  let ids = opts.featureIds?.length ? opts.featureIds.map(String) : collectPhaseFeatureIds(doc);
  ids = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];

  doc = backfillFeatureStages(doc);
  doc = markStageRunning(doc, stageKey, skill);

  return { doc, marked: [], skipped: ids, featureIds: ids };
}

function markFeatureStage(doc, stageKey, featureId, status, meta = {}) {
  const now = isoNow();
  const norm = normalizeFeatureStatus(status);
  const patch = {
    status: norm,
    message: meta.message != null ? String(meta.message) : '',
  };
  if (norm === 'running') {
    patch.started_at = meta.started_at || now;
    patch.completed_at = null;
  }
  if (TERMINAL_FEATURE.has(norm)) {
    patch.completed_at = meta.completed_at || now;
  }
  if (meta.extra && typeof meta.extra === 'object') {
    Object.assign(patch, meta.extra);
  }
  return upsertFeature(doc, stageKey, featureId, patch);
}

function markFeaturesRunning(doc, stageKey, featureIds, meta = {}) {
  for (const fid of featureIds || []) {
    doc = markFeatureStage(doc, stageKey, fid, 'running', meta);
  }
  return doc;
}

function markFeaturesCompleted(doc, stageKey, featureIds, meta = {}) {
  for (const fid of featureIds || []) {
    doc = markFeatureStage(doc, stageKey, fid, 'completed', meta);
  }
  return doc;
}

function markFeaturesFailed(doc, stageKey, featureIds, meta = {}) {
  for (const fid of featureIds || []) {
    doc = markFeatureStage(doc, stageKey, fid, 'failed', meta);
  }
  return doc;
}

function markFeaturesSkipped(doc, stageKey, featureIds, meta = {}) {
  for (const fid of featureIds || []) {
    doc = markFeatureStage(doc, stageKey, fid, 'skipped', meta);
  }
  return doc;
}

function isFeatureStageRunning(doc, stageKey, featureId) {
  const row = getFeatureStageRow(doc, stageKey, featureId);
  return normalizeFeatureStatus(row?.status) === 'running';
}

function anyFeatureStageRunning(doc, featureId, stageKeys = STAGE_KEYS) {
  const fid = String(featureId || '').trim();
  if (!fid) return false;
  for (const key of stageKeys) {
    if (isFeatureStageCompleted(doc, key, fid)) continue;
    if (isFeatureStageRunning(doc, key, fid)) return true;
  }
  return false;
}

/**
 * 给人看的阶段日志：
 * - `.agent-sessions/logs/sessions/<session_id>.log`
 * - `.agent-sessions/logs/stages/<stage>.log`
 * - `.agent-sessions/logs/features/<feature_id>.log`（本行涉及的全部 feature）
 */
function appendStageLog(projectRoot, rec) {
  const ts = isoNow();
  const stage = agentLog.normalizeStageKey(rec.stageKey || rec.stage || '');
  const level = rec.level || 'info';
  const skill = rec.skill || 'pipeline';
  const fid = rec.featureId || rec.feature_id || '';
  const featureIds = agentLog.resolveFeatureIds(rec);

  try {
    agentLog.appendAgentLog(projectRoot, {
      ...rec,
      stageKey: stage,
      skill,
      level,
      sessionId: rec.sessionId || rec.session_id || '',
    });
    const dir = agentLog.agentSessionsRoot(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const ndjson = path.join(dir, `${skill}.ndjson`);
    fs.appendFileSync(
      ndjson,
      `${JSON.stringify({
        ts,
        skill,
        stage,
        feature_ids: featureIds.length ? featureIds : fid ? [fid] : undefined,
        level,
        message: rec.message,
        detail: rec.detail,
      })}\n`,
      'utf8'
    );
  } catch {
    /* 日志失败不阻断 */
  }

  const head = `[${skill}] 阶段=${stage}${fid ? ` feature=${fid}` : ''}`;
  const line = `${head} | ${level.toUpperCase()} | ${String(rec.message || '').trim()}${
    rec.detail ? ` | ${rec.detail}` : ''
  }`;
  if (process.env.AI_FEATURE_STAGES_QUIET !== '1') {
    console.error(`${ts} ${line}`);
  }
}

module.exports = {
  STAGE_KEYS,
  REQUIRES_STAGE,
  FEATURE_STATUS_ENUM,
  TERMINAL_FEATURE,
  normalizeFeatureStatus,
  collectPhaseFeatureIds,
  collectDeferredFeatureIds,
  getFeatureStageRow,
  findFeatureRow,
  findPerFeatureRow,
  isFeatureStageCompleted,
  isFeatureStageRunning,
  isPreviousStageDoneForFeature,
  anyFeatureStageRunning,
  ensureFeatureRowsForPhasePlan,
  backfillFeatureStages,
  beginStageForFeatures,
  markStageRunning,
  markFeatureStage,
  markFeaturesRunning,
  markFeaturesCompleted,
  markFeaturesFailed,
  markFeaturesSkipped,
  upsertFeature,
  upsertPerFeature,
  writeFeatureHeartbeat,
  appendStageLog,
  projectStageCompleted,
};

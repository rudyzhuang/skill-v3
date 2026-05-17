'use strict';

const fs = require('fs');
const path = require('path');

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

/** 上一阶段完成态以项目级 status 为准（非 per_feature） */
const PROJECT_GATE_STAGES = new Set([
  'prd',
  'prd_review',
  'design_review',
  'merge_push',
  'build',
  'deploy',
  'smoke',
  'ui_e2e',
  'report',
]);

const TERMINAL_FEATURE = new Set(['completed', 'failed', 'skipped', 'deferred']);

function isoNow() {
  return new Date().toISOString();
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

function perFeatureArray(doc, stageKey) {
  const outs = stageBlock(doc, stageKey).outputs || {};
  if (Array.isArray(outs.per_feature)) return outs.per_feature;
  return null;
}

function findPerFeatureRow(doc, stageKey, featureId) {
  const fid = String(featureId || '').trim();
  const arr = perFeatureArray(doc, stageKey);
  if (!arr || !fid) return null;
  return arr.find((r) => String(r?.feature_id || '').trim() === fid) || null;
}

/** 从既有 outputs 结构推断 feature 行（旧项目无 per_feature 时） */
function legacyFeatureRow(doc, stageKey, featureId) {
  const fid = String(featureId || '').trim();
  if (!fid) return null;
  const outs = stageBlock(doc, stageKey).outputs || {};

  if (stageKey === 'design') {
    const spec = (outs.design_specs || []).find((r) => String(r?.feature_id || '').trim() === fid);
    if (!spec) return null;
    const st = String(spec.status || '').toLowerCase();
    if (st === 'approved' || st === 'completed') return { feature_id: fid, status: 'completed' };
    if (st === 'draft') return { feature_id: fid, status: 'pending' };
    return { feature_id: fid, status: 'pending' };
  }

  if (stageKey === 'contract') {
    const art = (outs.artifacts || []).find((r) => String(r?.feature_id || '').trim() === fid);
    if (!art) return null;
    const filled = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'].every(
      (k) => typeof art[k] === 'string' && art[k].trim()
    );
    return { feature_id: fid, status: filled ? 'completed' : 'pending' };
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
    const row = (outs.per_feature || []).find((r) => String(r?.feature_id || '').trim() === fid);
    if (!row) return null;
    const result = String(row.result || row.status || '').toLowerCase();
    if (row.passed === true || result === 'passed' || result === 'success') {
      return { feature_id: fid, status: 'completed', ...row };
    }
    if (row.passed === false || result === 'failed' || result === 'failure') {
      return { feature_id: fid, status: 'failed', ...row };
    }
    return { feature_id: fid, status: 'pending', ...row };
  }

  return null;
}

/**
 * @returns {{ feature_id: string, status: string, started_at?: string|null, completed_at?: string|null, message?: string }|null}
 */
function getFeatureStageRow(doc, stageKey, featureId) {
  const direct = findPerFeatureRow(doc, stageKey, featureId);
  if (direct?.status) return direct;
  return legacyFeatureRow(doc, stageKey, featureId);
}

function isFeatureStageCompleted(doc, stageKey, featureId) {
  const row = getFeatureStageRow(doc, stageKey, featureId);
  if (row?.status === 'completed' || row?.status === 'skipped') return true;
  if (PROJECT_GATE_STAGES.has(stageKey) && projectStageCompleted(doc, stageKey)) return true;
  return false;
}

function isPreviousStageDoneForFeature(doc, stageKey, featureId) {
  const prev = REQUIRES_STAGE[stageKey];
  if (!prev) return true;
  if (PROJECT_GATE_STAGES.has(prev)) return projectStageCompleted(doc, prev);
  return isFeatureStageCompleted(doc, prev, featureId);
}

function ensureOutputs(doc, stageKey) {
  if (!doc.stages) doc.stages = {};
  if (!doc.stages[stageKey]) doc.stages[stageKey] = {};
  if (!doc.stages[stageKey].outputs) doc.stages[stageKey].outputs = {};
  if (!Array.isArray(doc.stages[stageKey].outputs.per_feature)) {
    doc.stages[stageKey].outputs.per_feature = [];
  }
  return doc.stages[stageKey].outputs.per_feature;
}

function upsertPerFeature(doc, stageKey, featureId, patch) {
  const fid = String(featureId || '').trim();
  if (!fid) return doc;
  const arr = ensureOutputs(doc, stageKey);
  const idx = arr.findIndex((r) => String(r?.feature_id || '').trim() === fid);
  const prev = idx >= 0 ? arr[idx] : { feature_id: fid, status: 'not_started' };
  const next = { ...prev, feature_id: fid, ...patch };
  if (idx >= 0) arr[idx] = next;
  else arr.push(next);
  return doc;
}

/**
 * 旧项目：从 legacy 结构补齐 outputs.per_feature[]（仅补缺，不覆盖已有行）
 */
function backfillFeatureStages(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const ids = collectPhaseFeatureIds(doc);
  if (!ids.length) return doc;

  for (const stageKey of STAGE_KEYS) {
    if (stageKey === 'prd' || stageKey === 'report') continue;
    const arr = ensureOutputs(doc, stageKey);
    const have = new Set(arr.map((r) => String(r?.feature_id || '').trim()).filter(Boolean));
    for (const fid of ids) {
      if (have.has(fid)) continue;
      const legacy = legacyFeatureRow(doc, stageKey, fid);
      if (legacy) {
        arr.push({
          feature_id: fid,
          status: legacy.status || 'not_started',
          started_at: legacy.started_at || null,
          completed_at: legacy.completed_at || null,
          message: legacy.message || 'backfill_from_legacy_outputs',
        });
        have.add(fid);
      }
    }
  }
  return doc;
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
 * 阶段脚本开跑：上一阶段已完成 → 将本 stage 内 feature 标为 running
 * @param {object} doc
 * @param {{ stageKey: string, featureIds?: string[], skill?: string, message?: string }} opts
 */
function beginStageForFeatures(doc, opts) {
  const stageKey = opts.stageKey;
  const skill = opts.skill || 'pipeline';
  let ids = opts.featureIds?.length ? opts.featureIds.map(String) : collectPhaseFeatureIds(doc);
  ids = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];

  doc = backfillFeatureStages(doc);
  doc = markStageRunning(doc, stageKey, skill);

  const now = isoNow();
  const marked = [];
  const skipped = [];

  for (const fid of ids) {
    if (!isPreviousStageDoneForFeature(doc, stageKey, fid)) {
      skipped.push(fid);
      continue;
    }
    const cur = getFeatureStageRow(doc, stageKey, fid);
    if (cur?.status === 'running') {
      marked.push(fid);
      continue;
    }
    if (TERMINAL_FEATURE.has(String(cur?.status || ''))) {
      skipped.push(fid);
      continue;
    }
    doc = upsertPerFeature(doc, stageKey, fid, {
      status: 'running',
      started_at: now,
      completed_at: null,
      message: opts.message || `${stageKey} 处理中`,
    });
    marked.push(fid);
  }

  return { doc, marked, skipped, featureIds: ids };
}

function markFeatureStage(doc, stageKey, featureId, status, meta = {}) {
  const now = isoNow();
  const patch = {
    status,
    message: meta.message || '',
  };
  if (status === 'running') {
    patch.started_at = meta.started_at || now;
    patch.completed_at = null;
  }
  if (TERMINAL_FEATURE.has(status)) {
    patch.completed_at = meta.completed_at || now;
  }
  if (meta.extra && typeof meta.extra === 'object') {
    Object.assign(patch, meta.extra);
  }
  return upsertPerFeature(doc, stageKey, featureId, patch);
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

function isFeatureStageRunning(doc, stageKey, featureId) {
  const row = getFeatureStageRow(doc, stageKey, featureId);
  if (String(row?.status || '') === 'running') return true;
  if (PROJECT_GATE_STAGES.has(stageKey) && String(stageBlock(doc, stageKey).status || '') === 'running') {
    return true;
  }
  return false;
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
 * 给人看的阶段日志（.agent-sessions/<session>.log + stderr）
 */
function appendStageLog(projectRoot, rec) {
  const ts = isoNow();
  const stage = rec.stageKey || rec.stage || '';
  const level = rec.level || 'info';
  const skill = rec.skill || 'pipeline';
  const fid = rec.featureId || rec.feature_id || '';
  const head = `[${skill}] 阶段=${stage}${fid ? ` feature=${fid}` : ''}`;
  const line = `${head} | ${level.toUpperCase()} | ${String(rec.message || '').trim()}${
    rec.detail ? ` | ${rec.detail}` : ''
  }`;

  try {
    const dir = path.join(projectRoot, '.agent-sessions');
    fs.mkdirSync(dir, { recursive: true });
    const sid = String(rec.sessionId || rec.session_id || 'pipeline').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    fs.appendFileSync(path.join(dir, `${sid}.log`), `${ts} ${line}\n`, 'utf8');
    const ndjson = path.join(dir, `${skill}.ndjson`);
    fs.appendFileSync(
      ndjson,
      `${JSON.stringify({ ts, skill, stage, feature_id: fid || undefined, level, message: rec.message, detail: rec.detail })}\n`,
      'utf8'
    );
  } catch {
    /* 日志失败不阻断 */
  }

  if (process.env.AI_FEATURE_STAGES_QUIET !== '1') {
    console.error(`${ts} ${line}`);
  }
}

module.exports = {
  STAGE_KEYS,
  REQUIRES_STAGE,
  PROJECT_GATE_STAGES,
  collectPhaseFeatureIds,
  getFeatureStageRow,
  findPerFeatureRow,
  isFeatureStageCompleted,
  isFeatureStageRunning,
  isPreviousStageDoneForFeature,
  anyFeatureStageRunning,
  backfillFeatureStages,
  beginStageForFeatures,
  markStageRunning,
  markFeatureStage,
  markFeaturesCompleted,
  markFeaturesFailed,
  upsertPerFeature,
  appendStageLog,
  projectStageCompleted,
};

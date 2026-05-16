'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isStageDone } = require('./summary.cjs');

const FEATURE_GROUPS_LIB = path.resolve(
  __dirname,
  '../../../ai-auto3/scripts/lib/feature-groups.cjs'
);
let collectFeatureMeta;
try {
  collectFeatureMeta = require(FEATURE_GROUPS_LIB).collectFeatureMeta;
} catch {
  collectFeatureMeta = null;
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
  if (doc && typeof doc === 'object') return doc;
  const fp = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
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
function isScaffoldOnlyWorktree(projectRoot, featureId) {
  const wt = worktreePath(projectRoot, featureId);
  if (!fs.existsSync(wt) || !fs.existsSync(path.join(wt, 'package.json'))) return false;
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

function testPerFeaturePassed(doc, featureId) {
  const fid = String(featureId || '').trim();
  const rows = doc?.stages?.test?.outputs?.per_feature || [];
  const row = rows.find((r) => String(r?.feature_id || '').trim() === fid);
  if (!row) return false;
  const result = String(row.result || row.status || '').toLowerCase();
  if (row.passed === true || result === 'passed' || result === 'success') return true;
  return false;
}

/**
 * feature 级 codegen 是否完成（禁止将 health 脚手架误判为已完成）
 * @param {string} projectRoot
 * @param {string} featureId
 * @param {object|null} [doc] stages.json
 */
function isFeatureCodegenDone(projectRoot, featureId, doc) {
  const fid = String(featureId || '').trim();
  if (!fid) return false;
  const stages = loadStagesDoc(projectRoot, doc);

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

  try {
    const count = Number(
      execFileSync('git', ['-C', wt, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
    );
    if (Number.isFinite(count) && count > 1) return true;
    const porcelain = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' });
    if (porcelain.trim().length === 0 && fs.existsSync(path.join(wt, 'package.json'))) return true;
  } catch {
    /* 非 git worktree */
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
  if (!runtime || !runtime.pending_features_json) return new Set();
  try {
    const arr = JSON.parse(runtime.pending_features_json);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((x) => String(x).trim()).filter(Boolean));
  } catch {
    return new Set();
  }
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
    if (!isFeatureCodegenDone(projectRoot, fid, stages)) {
      if (pendingQueue.has(fid) || worktreeTimestamps(projectRoot, fid).exists) {
        return fid;
      }
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
    pipeline_stage = currentStage || 'failed';
    pipeline_stage_label = '失败';
  } else if (codegenDone) {
    const gs = currentStage && currentStage !== 'codegen' ? currentStage : 'codegen';
    pipeline_stage = gs;
    if (gs === 'codegen' || String(doc?.stages?.codegen?.status || '') === 'completed') {
      pipeline_stage_label = 'codegen（本 feature 已完成）';
      stage_started_at = globalStageStartedAt(doc, 'codegen') || null;
      if (wtTimes.mtimeMs) {
        stage_started_at = new Date(wtTimes.mtimeMs).toISOString();
      }
    } else {
      pipeline_stage_label = `${displayStageKey(gs)}（等待项目级阶段）`;
      stage_started_at = globalStageStartedAt(doc, gs);
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
  const pendingQueue = parsePendingFeatures(runtime);
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
      const hasWorktree = worktrees.has(fid);
      const wtTimes = worktreeTimestamps(projectRoot, fid);
      const isActiveCodegen = fid === activeCodegenFid;

      if (deferred.has(fid)) {
        pipeline_status = 'deferred';
        hints.push('deferred_in_prd_review');
      } else if (listMeta[fid]?.status === 'blocked') {
        pipeline_status = 'failed';
        hints.push('blocked_in_feature_list');
      } else if (projectFailed && (pendingQueue.has(fid) || phase === currentPhase)) {
        pipeline_status = 'failed';
        hints.push('project_stage_failed');
      } else if (codegenDone) {
        pipeline_status = 'completed';
        hints.push('worktree_codegen_artifacts');
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

      const stageFields = deriveFeatureStageFields({
        fid,
        pipeline_status,
        codegenDone,
        hasWorktree,
        currentStage: pipelineCurrentStage || currentStage,
        codegenRunning,
        isActiveCodegen,
        doc,
        wtTimes,
      });

      features.push({
        feature_id: fid,
        phase,
        name: listMeta[fid]?.name || '',
        list_status: listMeta[fid]?.status || null,
        client_target: listMeta[fid]?.client_target || null,
        priority_tier: tierById.get(fid) ?? 3,
        pipeline_status,
        hints,
        ...stageFields,
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
  isScaffoldOnlyWorktree,
  collectFeatureWorktreeIds,
  filterRemainingCodegenQueue,
  sortFeaturesByPriority,
  buildPhaseOrderIndex,
};

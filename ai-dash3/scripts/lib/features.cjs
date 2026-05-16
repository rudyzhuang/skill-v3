'use strict';

const fs = require('fs');
const path = require('path');
const { isStageDone } = require('./summary.cjs');

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

/**
 * codegen 是否已在 worktree 落盘（启发式：package.json 或非空 src/）
 * @param {string} projectRoot
 * @param {string} featureId
 */
function isFeatureCodegenDone(projectRoot, featureId) {
  const fid = String(featureId || '').trim();
  if (!fid) return false;
  const wt = path.join(projectRoot, '.pipeline', 'worktrees', `v3-fc-${fid}`);
  if (!fs.existsSync(wt)) return false;
  if (fs.existsSync(path.join(wt, 'package.json'))) return true;
  const src = path.join(wt, 'src');
  try {
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
      return fs.readdirSync(src).some((n) => !n.startsWith('.'));
    }
  } catch {
    /* */
  }
  return false;
}

/**
 * 本期尚未完成 codegen 的 feature_id 列表（供 autorun pending_features_json）
 * @param {string} projectRoot
 * @param {string[]} featureIds
 */
function filterRemainingCodegenQueue(projectRoot, featureIds) {
  return featureIds.filter((fid) => !isFeatureCodegenDone(projectRoot, fid));
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
  const autorunActive = pidLock?.alive === true;
  const codegenRunning = String(doc?.stages?.codegen?.status || '') === 'running';

  const features = [];
  for (const { phase, feature_ids: featureIds } of phases) {
    for (const fid of featureIds) {
      let pipeline_status = 'pending';
      const hints = [];
      const codegenDone = isFeatureCodegenDone(projectRoot, fid);
      const hasWorktree = worktrees.has(fid);

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
      } else if (hasWorktree) {
        pipeline_status = 'in_progress';
        hints.push('has_worktree');
        if (autorunActive && codegenRunning) hints.push('codegen_running');
      } else if (autorunActive && codegenRunning && pendingQueue.has(fid)) {
        // 在队列中但 worktree 尚未创建：仍为待处理（排队），非处理中
        pipeline_status = 'pending';
        hints.push('queued_for_codegen');
      } else {
        pipeline_status = 'pending';
        if (pendingQueue.has(fid)) hints.push('in_pending_queue');
      }

      features.push({
        feature_id: fid,
        phase,
        name: listMeta[fid]?.name || '',
        list_status: listMeta[fid]?.status || null,
        client_target: listMeta[fid]?.client_target || null,
        pipeline_status,
        hints,
      });
    }
  }

  return {
    phases: phases.map((p) => ({ phase: p.phase, feature_ids: p.feature_ids.slice() })),
    features,
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
    autorun_active: autorunActive,
  };
}

module.exports = {
  collectPhasePlans,
  buildFeatureBoard,
  parseFeatureLists,
  worktreesOnDisk,
  isFeatureCodegenDone,
  collectFeatureWorktreeIds,
  filterRemainingCodegenQueue,
};

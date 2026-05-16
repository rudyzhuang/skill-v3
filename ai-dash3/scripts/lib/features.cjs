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
  const worktrees = worktreeFeatureIds(doc || {});
  const pending = parsePendingFeatures(runtime);
  const codegenDone = doc ? isStageDone(doc, 'codegen') : false;
  const projectFailed = doc ? projectHasFailedStage(doc) : false;
  const currentPhase = runtime?.current_phase ? String(runtime.current_phase) : '';
  const currentStage = runtime?.current_stage ? String(runtime.current_stage) : '';
  const autorunActive = pidLock?.alive === true;

  const features = [];
  for (const { phase, feature_ids: featureIds } of phases) {
    for (const fid of featureIds) {
      let pipeline_status = 'pending';
      const hints = [];

      if (deferred.has(fid)) {
        pipeline_status = 'deferred';
        hints.push('deferred_in_prd_review');
      } else if (listMeta[fid]?.status === 'blocked') {
        pipeline_status = 'failed';
        hints.push('blocked_in_feature_list');
      } else if (projectFailed && (pending.has(fid) || phase === currentPhase)) {
        pipeline_status = 'failed';
        hints.push('project_stage_failed');
      } else if (autorunActive && pending.has(fid)) {
        pipeline_status = 'in_progress';
        hints.push('autorun_active_pending');
      } else if (worktrees.has(fid) && codegenDone) {
        pipeline_status = 'completed';
        hints.push('codegen_worktree_done');
      } else if (worktrees.has(fid) || pending.has(fid)) {
        pipeline_status = 'in_progress';
        if (worktrees.has(fid)) hints.push('has_worktree');
        if (pending.has(fid)) hints.push('in_pending_list');
      }

      const designPath = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
      if (fs.existsSync(designPath) && pipeline_status === 'pending') {
        pipeline_status = 'in_progress';
        hints.push('design_spec_exists');
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
          pending_features: [...pending],
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
};

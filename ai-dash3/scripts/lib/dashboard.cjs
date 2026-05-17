'use strict';

const path = require('path');
const { buildJsonSummary, readStages, pidLockInfo } = require('./summary.cjs');
const { buildFeatureBoard } = require('./features.cjs');
const { buildInProgressFeatureLogs } = require('./feature-logs.cjs');
const {
  fetchRuntimeExport,
  runtimeForProject,
  recentRunsForProject,
  readRuntimeForProjectRoot,
} = require('./runtime-bridge.cjs');

function featureIndicatesFailure(f) {
  if (f.current_stage_status === 'failed') return true;
  const hints = f.hints || [];
  return hints.some((h) =>
    ['test_per_feature_failed', 'blocked_in_feature_list', 'project_stage_failed'].includes(h)
  );
}

function deriveProjectOverall(summary, featureBoard) {
  if (summary.blockers && summary.blockers.some((b) => b.code === 'stage_failed')) return 'failed';
  if (summary.blockers && summary.blockers.length) return 'blocked';
  if (featureBoard.autorun_active || featureBoard.registry_run_active) return 'running';
  const feats = featureBoard.features || [];
  if (feats.length && feats.every((f) => (f.feature_status || f.pipeline_status) === 'completed')) {
    return 'completed';
  }
  if (
    feats.some((f) => {
      const st = f.feature_status || f.pipeline_status;
      return st === 'running' || st === 'in_progress';
    })
  ) {
    return 'in_progress';
  }
  if (feats.some(featureIndicatesFailure)) return 'failed';
  const rows = summary.rows || [];
  const anyStarted = rows.some((r) => r.status && r.status !== 'not_started' && r.status !== '—');
  if (!anyStarted) return 'idle';
  return 'in_progress';
}

/**
 * @param {string} projectRoot absolute path
 * @param {object|null} registryExport optional pre-fetched registry
 */
function buildDashboard(projectRoot, registryExport) {
  const read = readStages(projectRoot);
  const summary = buildJsonSummary(projectRoot, read);
  const pid = summary.pid_lock || pidLockInfo(projectRoot);
  const projectId = summary.project_id || '';

  let runtime = null;
  let recentRuns = [];
  let registryRunActive = false;
  if (registryExport && registryExport.ok) {
    runtime = runtimeForProject(registryExport, projectId, projectRoot);
    recentRuns = recentRunsForProject(registryExport, projectId, 8, projectRoot);
    registryRunActive = (registryExport.active_runs || []).some((r) => {
      if (r.project_id === projectId) return true;
      const p = (registryExport.projects || []).find(
        (x) => x.project_id === r.project_id && path.resolve(x.root_path || '') === path.resolve(projectRoot)
      );
      return !!p;
    });
  }

  const featureBoard = read.data
    ? buildFeatureBoard(read.data, projectRoot, runtime, pid)
    : buildFeatureBoard({}, projectRoot, runtime, pid);

  const autorunActive = featureBoard.autorun_active || registryRunActive;
  const boardForOverall = {
    ...featureBoard,
    autorun_active: autorunActive,
    registry_run_active: registryRunActive,
  };

  const runtimeRead = readRuntimeForProjectRoot(projectRoot);
  const processes = runtimeRead?.doc?.processes || [];
  const projectName =
    runtimeRead?.doc?.project?.project_name ||
    runtimeRead?.doc?.project?.name ||
    (registryExport?.projects || []).find(
      (p) => path.resolve(p.root_path || '') === path.resolve(projectRoot)
    )?.project_name ||
    '';

  return {
    schema: 'ai-dash3.dashboard.v1',
    project_root: projectRoot,
    project_id: projectId,
    project_name: projectName,
    overall: deriveProjectOverall(summary, boardForOverall),
    summary,
    features: featureBoard.features,
    phases: featureBoard.phases,
    runtime: featureBoard.runtime,
    processes,
    autorun_active: autorunActive,
    registry_run_active: registryRunActive,
    pid_lock_alive: pid?.alive === true,
    registry_stale_run: registryRunActive && pid?.alive !== true,
    active_codegen_feature_id: featureBoard.active_codegen_feature_id || null,
    pipeline_stoppable: pid?.alive === true || registryRunActive,
    recent_runs: recentRuns,
    in_progress_logs: buildInProgressFeatureLogs(projectRoot, featureBoard.features),
    generated_at: new Date().toISOString(),
  };
}

function buildProjectsPayload() {
  const reg = fetchRuntimeExport();
  if (!reg.ok) {
    return {
      schema: 'ai-dash3.projects.v1',
      ok: false,
      error: reg.error,
      projects: [],
      active_runs: [],
    };
  }
  const data = reg.data;
  const projects = (data.projects || []).map((p) => {
    const rt = runtimeForProject(data, p.project_id);
    let pendingCount = 0;
    if (rt?.pending_features?.length) {
      pendingCount = rt.pending_features.length;
    } else if (rt?.pending_features_json) {
      try {
        pendingCount = JSON.parse(rt.pending_features_json).length;
      } catch {
        pendingCount = 0;
      }
    }
    const active =
      (data.active_runs || []).some((r) => r.project_id === p.project_id) || rt?.active === true;
    return {
      project_id: p.project_id,
      project_name: p.project_name || p.dir_name || p.project_id,
      dir_name: p.dir_name,
      root_path: p.root_path,
      last_seen_at: p.last_seen_at,
      current_phase: rt?.current_phase || null,
      current_stage: rt?.current_stage || null,
      pending_feature_count: pendingCount,
      autorun_active: active,
    };
  });
  return {
    schema: 'ai-dash3.projects.v1',
    ok: true,
    exported_at: data.exported_at,
    source: data.source || '_projects/runtime.json',
    projects,
    active_runs: data.active_runs || [],
  };
}

/** @deprecated 别名 */
function buildRegistryPayload() {
  const p = buildProjectsPayload();
  return { ...p, schema: p.ok ? 'ai-dash3.registry.v1' : p.schema };
}

module.exports = {
  buildDashboard,
  buildProjectsPayload,
  buildRegistryPayload,
};

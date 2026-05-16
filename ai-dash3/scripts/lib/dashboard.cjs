'use strict';

const { buildJsonSummary, readStages, pidLockInfo } = require('./summary.cjs');
const { buildFeatureBoard } = require('./features.cjs');
const { fetchRegistryExport, runtimeForProject, recentRunsForProject } = require('./registry-bridge.cjs');

function deriveProjectOverall(summary, featureBoard) {
  if (summary.blockers && summary.blockers.some((b) => b.code === 'stage_failed')) return 'failed';
  if (summary.blockers && summary.blockers.length) return 'blocked';
  if (featureBoard.autorun_active || featureBoard.registry_run_active) return 'running';
  const feats = featureBoard.features || [];
  if (feats.length && feats.every((f) => f.pipeline_status === 'completed')) return 'completed';
  if (feats.some((f) => f.pipeline_status === 'in_progress')) return 'in_progress';
  if (feats.some((f) => f.pipeline_status === 'failed')) return 'failed';
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
    runtime = runtimeForProject(registryExport, projectId);
    recentRuns = recentRunsForProject(registryExport, projectId, 8);
    registryRunActive = (registryExport.active_runs || []).some((r) => r.project_id === projectId);
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

  return {
    schema: 'ai-dash3.dashboard.v1',
    project_root: projectRoot,
    project_id: projectId,
    overall: deriveProjectOverall(summary, boardForOverall),
    summary,
    features: featureBoard.features,
    phases: featureBoard.phases,
    runtime: featureBoard.runtime,
    autorun_active: autorunActive,
    registry_run_active: registryRunActive,
    pid_lock_alive: pid?.alive === true,
    pipeline_stoppable: pid?.alive === true || registryRunActive,
    recent_runs: recentRuns,
    generated_at: new Date().toISOString(),
  };
}

function buildRegistryPayload() {
  const reg = fetchRegistryExport();
  if (!reg.ok) {
    return {
      schema: 'ai-dash3.registry.v1',
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
    if (rt?.pending_features_json) {
      try {
        pendingCount = JSON.parse(rt.pending_features_json).length;
      } catch {
        pendingCount = 0;
      }
    }
    const active = (data.active_runs || []).some((r) => r.project_id === p.project_id);
    return {
      project_id: p.project_id,
      root_path: p.root_path,
      last_seen_at: p.last_seen_at,
      current_phase: rt?.current_phase || null,
      current_stage: rt?.current_stage || null,
      pending_feature_count: pendingCount,
      autorun_active: active,
    };
  });
  return {
    schema: 'ai-dash3.registry.v1',
    ok: true,
    exported_at: data.exported_at,
    projects,
    active_runs: data.active_runs || [],
    registry_error: data.ok === false ? data.error : null,
  };
}

module.exports = {
  buildDashboard,
  buildRegistryPayload,
};

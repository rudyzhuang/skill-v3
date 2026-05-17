'use strict';

const path = require('path');
const {
  listProjectsFromRuntime,
  runtimeRowFromDoc,
  readRuntimeForProjectRoot: readRuntimeDocByRoot,
  buildRegistryExportShape,
} = require('../../../ai-auto3/scripts/lib/runtime-io.cjs');

/**
 * dash3 仅消费 <skills_root>/_projects/（不读 _runtime）
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
function fetchRuntimeExport() {
  try {
    const data = buildRegistryExportShape();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** @deprecated */
function fetchRegistryExport() {
  return fetchRuntimeExport();
}

function runtimeForProject(exportData, projectId, rootPath) {
  if (!exportData?.runtime_states) return null;
  if (rootPath) {
    const abs = path.resolve(rootPath);
    const hit = exportData.projects?.find((p) => p.root_path && path.resolve(p.root_path) === abs);
    if (hit) {
      return exportData.runtime_states.find((r) => r.project_id === hit.project_id) || null;
    }
  }
  return exportData.runtime_states.find((r) => r.project_id === projectId) || null;
}

function recentRunsForProject(exportData, projectId, limit = 5, rootPath) {
  if (!exportData?.recent_runs) return [];
  const abs = rootPath ? path.resolve(rootPath) : '';
  return exportData.recent_runs
    .filter((run) => {
      if (abs) {
        const p = (exportData.projects || []).find(
          (x) => x.project_id === run.project_id && path.resolve(x.root_path || '') === abs
        );
        if (p) return true;
      }
      return run.project_id === projectId;
    })
    .slice(0, limit);
}

function readRuntimeForProjectRoot(projectRoot) {
  const doc = readRuntimeDocByRoot(projectRoot);
  if (!doc) return null;
  return { doc, row: runtimeRowFromDoc(doc) };
}

module.exports = {
  fetchRuntimeExport,
  fetchRegistryExport,
  runtimeForProject,
  recentRunsForProject,
  readRuntimeForProjectRoot,
  listProjectsFromRuntime,
};

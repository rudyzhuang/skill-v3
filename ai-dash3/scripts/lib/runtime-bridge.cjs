'use strict';

const path = require('path');
const {
  listProjectsFromRuntime,
  runtimeRowFromDoc,
  readRuntimeFile,
  buildRegistryExportShape,
} = require('../../../ai-auto3/scripts/lib/runtime-io.cjs');

/**
 * 只读：扫描 skills_root/.pipeline 下各项目 runtime.json（dash3 不读 SQLite）
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

/** @deprecated 使用 fetchRuntimeExport */
function fetchRegistryExport() {
  return fetchRuntimeExport();
}

function runtimeForProject(exportData, projectId) {
  if (!exportData?.runtime_states) return null;
  return exportData.runtime_states.find((r) => r.project_id === projectId) || null;
}

function recentRunsForProject(exportData, projectId, limit = 5) {
  if (!exportData?.recent_runs) return [];
  return exportData.recent_runs
    .filter((run) => run.project_id === projectId)
    .slice(0, limit);
}

function readRuntimeForProjectRoot(projectRoot) {
  const projects = listProjectsFromRuntime();
  const abs = path.resolve(projectRoot);
  const row = projects.find((p) => path.resolve(p.root_path || '') === abs);
  if (!row) return null;
  const doc = readRuntimeFile(row.project_id);
  return doc ? { doc, row: runtimeRowFromDoc(doc) } : null;
}

module.exports = {
  fetchRuntimeExport,
  fetchRegistryExport,
  runtimeForProject,
  recentRunsForProject,
  readRuntimeForProjectRoot,
  listProjectsFromRuntime,
};

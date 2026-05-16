'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function skillsRootFromDash() {
  return path.resolve(__dirname, '..', '..', '..');
}

function registryExportScript() {
  return path.join(skillsRootFromDash(), 'ai-auto3', 'scripts', 'registry-export.cjs');
}

/**
 * 只读拉取 ai-auto3 registry（dash3 不直接打开 SQLite）
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
function fetchRegistryExport() {
  const script = registryExportScript();
  if (!fs.existsSync(script)) {
    return { ok: false, error: 'registry-export.cjs not found (ai-auto3)' };
  }
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim() || `exit ${r.status}`;
    return { ok: false, error: msg };
  }
  try {
    const line = (r.stdout || '').trim();
    const data = JSON.parse(line);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `invalid registry JSON: ${e.message}` };
  }
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

module.exports = {
  fetchRegistryExport,
  runtimeForProject,
  recentRunsForProject,
};

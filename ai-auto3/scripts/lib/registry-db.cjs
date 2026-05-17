'use strict';

/**
 * 兼容层：历史 import 路径 `registry-db.cjs` → `runtime-io.cjs`（不再使用 SQLite）。
 */
const runtimeIo = require('./runtime-io.cjs');

function upsertProjectFromStages(projectRoot, stagesDoc) {
  const { projectId } = runtimeIo.ensureProjectFromStages(projectRoot, stagesDoc, 'ai-auto3');
  return { projectId };
}

/** 阶段遥测曾写入 SQLite；现为空操作，保留 API 供 autorun 调用 */
function recordStageEvent() {}

/** @returns {string} 空 phase_run id（SQLite phase_runs 已移除） */
function startPhaseRun() {
  return '';
}

function finishPhaseRun() {}

module.exports = {
  hasProject: (projectId) => !!runtimeIo.readRuntimeFile(projectId),
  upsertProjectFromStages,
  startRun: (projectId, sessionId, projectRoot, stagesDoc) =>
    runtimeIo.startRun(projectId, sessionId, 'ai-auto3', projectRoot, stagesDoc),
  finishRun: runtimeIo.finishRun,
  recordStageEvent,
  startPhaseRun,
  finishPhaseRun,
  updateProjectRuntimeState: (projectId, patch, projectRoot, stagesDoc) =>
    runtimeIo.updateProjectRuntimeState(projectId, patch, 'ai-auto3', projectRoot, stagesDoc),
  clearProjectRuntimeState: (projectId, projectRoot, stagesDoc) =>
    runtimeIo.clearProjectRuntimeState(projectId, projectRoot, stagesDoc),
  registerProcess: (projectId, entry, projectRoot, stagesDoc) =>
    runtimeIo.registerProcess(projectId, entry, projectRoot, stagesDoc),
  finishActiveRuns: runtimeIo.finishActiveRuns,
};

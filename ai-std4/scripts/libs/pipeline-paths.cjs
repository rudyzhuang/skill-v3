'use strict';

/**
 * ai-std4 业务项目目录约定：
 *   output-stages/stages.json     — 流水线状态真源
 *   output-stages/<stage>/        — 各 stage 产出（merge_push 仍用 .pipeline/）
 *   .pipeline/                    — 锁、stop、worktrees、编排 recovery 等运行时
 *   .pipeline/logs/               — 全局与分 stage/feature 日志
 */

const fs   = require('fs');
const path = require('path');

/** stage 目录名（output-stages 下） */
function normalizeStageDir(stage) {
  const raw = String(stage || '').trim();
  if (!raw) return raw;
  const underscored = raw.replace(/-/g, '_');
  const map = {
    setup:                 'setup',
    prd:                   'prd',
    prd_review:            'prd-review',
    'prd-review':          'prd-review',
    design:                'design',
    design_review:         'design-review',
    'design-review':       'design-review',
    create_ui_scenarios:   'create-ui-scenarios',
    'create-ui-scenarios': 'create-ui-scenarios',
    codegen:               'codegen',
    code_review:           'code-review',
    'code-review':         'code-review',
    merge_push:            'merge_push',
    'merge-push':          'merge_push',
    build:                 'build',
    deploy:                'deploy',
    ui_e2e:                'ui_e2e',
    'ui-e2e':              'ui_e2e',
    report:                'report',
    pipeline:              'pipeline',
  };
  return map[underscored] || map[raw] || raw.replace(/_/g, '-');
}

function isMergePushStage(stage) {
  const d = normalizeStageDir(stage);
  return d === 'merge_push';
}

/**
 * @param {string} projectRoot
 */
function createPipelinePaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const pipelineDir      = path.join(root, '.pipeline');
  const outputStagesDir  = path.join(root, 'output-stages');
  const stagesJsonPath   = path.join(outputStagesDir, 'stages.json');
  const legacyStagesJson = path.join(pipelineDir, 'stages.json');
  const logsRoot         = path.join(pipelineDir, 'logs');

  function stageOutputDir(stage) {
    if (isMergePushStage(stage)) return pipelineDir;
    return path.join(outputStagesDir, normalizeStageDir(stage));
  }

  function stageOutputFile(stage, ...parts) {
    return path.join(stageOutputDir(stage), ...parts);
  }

  function ensureRuntimeDirs() {
    fs.mkdirSync(pipelineDir, { recursive: true });
    fs.mkdirSync(path.join(pipelineDir, 'locks'), { recursive: true });
    fs.mkdirSync(path.join(pipelineDir, 'worktrees'), { recursive: true });
    fs.mkdirSync(logsRoot, { recursive: true });
    fs.mkdirSync(path.join(logsRoot, 'stages'), { recursive: true });
    fs.mkdirSync(path.join(logsRoot, 'features'), { recursive: true });
    fs.mkdirSync(path.join(logsRoot, 'snapshots'), { recursive: true });
  }

  function ensureOutputStagesDir(stage) {
    ensureRuntimeDirs();
    fs.mkdirSync(outputStagesDir, { recursive: true });
    if (stage) fs.mkdirSync(stageOutputDir(stage), { recursive: true });
  }

  function readStagesJson() {
    const candidates = [stagesJsonPath, legacyStagesJson];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (_) { /* try next */ }
    }
    return null;
  }

  function writeStagesJson(obj) {
    ensureOutputStagesDir();
    fs.writeFileSync(stagesJsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return stagesJsonPath;
  }

  function globalLogPath(datetime) {
    return path.join(logsRoot, `${datetime}.log`);
  }

  function stageLogPath(stage, datetime) {
    return path.join(logsRoot, 'stages', normalizeStageDir(stage), `${datetime}.log`);
  }

  function stageLogsDir(stage) {
    return path.join(logsRoot, 'stages', normalizeStageDir(stage));
  }

  function featureLogDir(featureId) {
    return path.join(logsRoot, 'features', featureId);
  }

  function snapshotDir(scenarioId) {
    return path.join(logsRoot, 'snapshots', scenarioId);
  }

  function codegenWorkersDir() {
    return path.join(stageOutputDir('codegen'), 'workers', 'codegen');
  }

  function worktreeDir(featureId) {
    return path.join(pipelineDir, 'worktrees', `v3-${featureId}`);
  }

  function stageSummaryPath(stage, filename) {
    return stageOutputFile(stage, filename);
  }

  return {
    projectRoot:          root,
    pipelineDir,
    outputStagesDir,
    stagesJsonPath,
    legacyStagesJsonPath: legacyStagesJson,
    logsRoot,
    locksDir:             path.join(pipelineDir, 'locks'),
    stopSignalPath:       path.join(pipelineDir, 'stop.signal'),
    worktreesDir:         path.join(pipelineDir, 'worktrees'),
    reportsDirLegacy:     path.join(pipelineDir, 'reports'),
    stageOutputDir,
    stageOutputFile,
    stageSummaryPath,
    normalizeStageDir,
    isMergePushStage,
    ensureRuntimeDirs,
    ensureOutputStagesDir,
    readStagesJson,
    writeStagesJson,
    globalLogPath,
    stageLogPath,
    stageLogsDir,
    featureLogDir,
    snapshotDir,
    codegenWorkersDir,
    worktreeDir,
  };
}

module.exports = {
  normalizeStageDir,
  isMergePushStage,
  createPipelinePaths,
};

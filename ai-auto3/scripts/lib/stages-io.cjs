'use strict';

const fs = require('fs');
const path = require('path');
const { stagesJsonPath } = require('./paths.cjs');

function readStages(projectRoot) {
  const p = stagesJsonPath(projectRoot);
  if (!fs.existsSync(p)) {
    const e = new Error(`missing stages.json: ${p}`);
    e.code = 'ENOENT_STAGES';
    throw e;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeStages(projectRoot, doc) {
  atomicWriteJson(stagesJsonPath(projectRoot), doc);
}

function deepMerge(target, patch) {
  if (patch === null || patch === undefined) return target;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return { ...patch };
  const out = { ...target };
  for (const k of Object.keys(patch)) {
    out[k] = deepMerge(target[k], patch[k]);
  }
  return out;
}

function updateStage(doc, stageKey, partial) {
  if (!doc.stages) doc.stages = {};
  doc.stages[stageKey] = deepMerge(doc.stages[stageKey] || {}, partial);
  return doc;
}

/**
 * §5.2 窄接口：pipeline 元数据、contract blocked、pipeline_logs 追加
 */
function updatePipelineMeta(doc, { currentStage, lastCompleted, by }) {
  if (!doc.pipeline) doc.pipeline = {};
  const now = new Date().toISOString();
  doc.pipeline = {
    ...doc.pipeline,
    current_stage: currentStage,
    last_completed_stage: lastCompleted != null ? lastCompleted : doc.pipeline.last_completed_stage,
    updated_at: now,
    updated_by: by || 'ai-auto3',
  };
  return doc;
}

function appendPipelineLog(doc, entry) {
  if (!doc.logs) doc.logs = {};
  if (!Array.isArray(doc.logs.pipeline_logs)) doc.logs.pipeline_logs = [];
  doc.logs.pipeline_logs.push({
    session_id: entry.session_id,
    path: entry.path,
    started_at: entry.started_at,
    ended_at: entry.ended_at || null,
    skill: 'ai-auto3',
    notes: entry.notes || '',
  });
  return doc;
}

function setContractBlocked(doc) {
  return updateStage(doc, 'contract', {
    status: 'blocked',
    completed_at: doc.stages?.contract?.completed_at || null,
    validation: {
      ...(doc.stages?.contract?.validation || {}),
      passed: false,
      summary: 'human_approval pending (ai-auto3)',
    },
  });
}

module.exports = {
  readStages,
  writeStages,
  updateStage,
  updatePipelineMeta,
  appendPipelineLog,
  setContractBlocked,
  stagesJsonPath,
};

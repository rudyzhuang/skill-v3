'use strict';

/**
 * 串行化 stages.json 读-改-写，避免并发 worker 竞态。
 */
const fs   = require('fs');
const path = require('path');

function getStageRecord(stages, stageName) {
  if (!stages) return {};
  return stages[stageName] || stages[stageName.replace(/-/g, '_')] || {};
}

function resolveStageRef(stages, stageKey) {
  if (!stages) return null;
  if (stages[stageKey]) return stages[stageKey];
  const underscored = stageKey.replace(/-/g, '_');
  if (stages[underscored]) return stages[underscored];
  const hyphened = stageKey.replace(/_/g, '-');
  if (stages[hyphened]) return stages[hyphened];
  stages[underscored] = {};
  return stages[underscored];
}

function createStagesJsonWriteQueue(projectRoot, { touchUpdatedAt } = {}) {
  const pipelineDir    = path.join(projectRoot, '.pipeline');
  const stagesJsonPath = path.join(pipelineDir, 'stages.json');

  function readStagesJson() {
    if (!fs.existsSync(stagesJsonPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(stagesJsonPath, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function writeStagesJson(obj) {
    fs.mkdirSync(pipelineDir, { recursive: true });
    fs.writeFileSync(stagesJsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return stagesJsonPath;
  }

  let chain = Promise.resolve();

  function enqueue(mutator) {
    chain = chain
      .then(() => {
        const stagesObj = readStagesJson();
        if (!stagesObj) return;
        mutator(stagesObj);
        if (stagesObj.pipeline && typeof touchUpdatedAt === 'function') {
          stagesObj.pipeline.updated_at = touchUpdatedAt();
        }
        writeStagesJson(stagesObj);
      })
      .catch(() => { /* 避免链断裂 */ });
    return chain;
  }

  /**
   * @param {string} stageKey  stages 下的键（code_review / design 等）
   * @param {string} featureId
   * @param {object} patch 合并到 features[featureId]
   */
  function patchFeature(stageKey, featureId, patch) {
    return enqueue((stagesObj) => {
      if (!stagesObj.stages) stagesObj.stages = {};
      const stageRef = resolveStageRef(stagesObj.stages, stageKey);
      if (!stageRef.features) stageRef.features = {};
      if (!stageRef.features[featureId]) stageRef.features[featureId] = {};
      Object.assign(stageRef.features[featureId], patch);
    });
  }

  return { readStagesJson, writeStagesJson, enqueue, patchFeature, getStageRecord };
}

module.exports = { createStagesJsonWriteQueue, getStageRecord };

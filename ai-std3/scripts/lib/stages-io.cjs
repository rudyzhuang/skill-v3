'use strict';
/**
 * stages-io.cjs — stages.json 读写工具
 *
 * 提供:
 *   readStages(projectRoot)         → 读取并解析 stages.json（不存在则返回 null）
 *   writeStages(projectRoot, data)  → 原子写入（先写 .tmp 再 rename）
 *   initStages(projectRoot)         → 初始化骨架（若不存在）
 *   updateStage(projectRoot, key, patch) → 合并更新某个 stage key
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PIPELINE_DIR = '.pipeline';
const STAGES_FILE  = 'stages.json';

function stagesPath(projectRoot) {
  return path.join(projectRoot, PIPELINE_DIR, STAGES_FILE);
}

function readStages(projectRoot) {
  const p = stagesPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`[stages-io] stages.json 解析失败: ${e.message}`);
  }
}

function writeStages(projectRoot, data) {
  const p = stagesPath(projectRoot);
  const tmp = p + '.tmp';
  data.pipeline = data.pipeline || {};
  data.pipeline.updated_at = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function initStages(projectRoot) {
  const p = stagesPath(projectRoot);
  if (fs.existsSync(p)) return readStages(projectRoot);

  fs.mkdirSync(path.dirname(p), { recursive: true });

  // 生成 project_id
  let remote = '';
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot });
    if (r.status === 0) remote = r.stdout.toString().trim();
  } catch { /* ignore */ }

  const projectId = 'p-' + crypto
    .createHash('sha1')
    .update(`${remote}|${path.resolve(projectRoot)}`)
    .digest('hex')
    .slice(0, 12);

  const skeleton = {
    _schema: { name: 'ai-std3-stages', version: 1 },
    project: {
      project_id: projectId,
      root_path: path.resolve(projectRoot),
      name: path.basename(projectRoot),
    },
    pipeline: {
      current_stage: 'setup',
      last_completed_stage: null,
      updated_at: null,
      updated_by: 'ai-std3',
    },
    stages: {
      prd:                 stageShell('prd'),
      prd_review:          stageShell('prd_review'),
      design:              stageShell('design'),
      design_review:       stageShell('design_review'),
      create_ui_scenarios: stageShell('create_ui_scenarios'),
      codegen:             stageShell('codegen'),
      code_review:         stageShell('code_review'),
      merge_push:          stageShell('merge_push'),
      build:               stageShell('build'),
      deploy:              stageShell('deploy'),
      smoke:               stageShell('smoke'),
      ui_e2e:              stageShell('ui_e2e'),
      report:              stageShell('report'),
    },
  };

  writeStages(projectRoot, skeleton);
  return skeleton;
}

function stageShell(name) {
  return {
    status: 'not_started',
    started_at: null,
    completed_at: null,
    inputs: { summary_hash: '' },
    outputs: {},
    validation: { passed: false, checked_at: null, summary: '' },
    features: [],
  };
}

function updateStage(projectRoot, stageKey, patch) {
  // Re-read from disk to avoid clobbering concurrent writes
  let data = readStages(projectRoot);
  if (!data) data = initStages(projectRoot);

  const existing = data.stages[stageKey] || stageShell(stageKey);
  data.stages[stageKey] = deepMerge(existing, patch);
  data.pipeline.current_stage = stageKey;
  if (patch.status === 'completed') {
    data.pipeline.last_completed_stage = stageKey;
  }
  writeStages(projectRoot, data);
  return data;
}

function deepMerge(target, source) {
  const out = Object.assign({}, target);
  for (const [k, v] of Object.entries(source)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
        typeof target[k] === 'object' && !Array.isArray(target[k])) {
      out[k] = deepMerge(target[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

module.exports = { readStages, writeStages, initStages, updateStage, sha256File, sha256Text };

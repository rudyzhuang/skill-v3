'use strict';

/**
 * 流水线配置：加载 docs/config.env、解析 pipeline.model / skills 根目录
 */

const fs   = require('fs');
const path = require('path');
const { parseEnv } = require('./verify-inputs.cjs');

const DEFAULT_SKILLS_ROOT = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.cursor',
  'skills'
);
const DEFAULT_MODEL = 'composer-2';

/**
 * 将 config.env 键值注入 process.env（仅非空值；不覆盖已存在的非空环境变量）
 * @param {string} projectRoot
 * @param {{ source?: 'docs'|'inputs' }} [opts]
 */
function loadProjectEnv(projectRoot, opts = {}) {
  const preferDocs = opts.source !== 'inputs';
  const candidates = preferDocs
    ? [
        path.join(projectRoot, 'docs', 'config.env'),
        path.join(projectRoot, 'inputs', 'config.env'),
      ]
    : [
        path.join(projectRoot, 'inputs', 'config.env'),
        path.join(projectRoot, 'docs', 'config.env'),
      ];

  let envPath = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      envPath = p;
      break;
    }
  }
  if (!envPath) return { loaded: false, path: null };

  const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
  for (const [key, val] of Object.entries(env)) {
    if (!val) continue;
    if (!process.env[key] || process.env[key] === '') {
      process.env[key] = val;
    }
  }
  return { loaded: true, path: envPath };
}

function getSkillsRoot() {
  const raw = process.env.CURSOR_SKILLS_ROOT;
  if (raw && String(raw).trim()) {
    return path.resolve(String(raw).trim());
  }
  return path.resolve(DEFAULT_SKILLS_ROOT);
}

function readConfigJson(projectRoot, configName = 'dev') {
  const p = path.join(projectRoot, 'docs', `config.${configName}.json`);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return {};
  }
}

/** env PIPELINE_MODEL 优先于 config.json → pipeline.model */
function resolvePipelineModel(cfg = {}) {
  const fromEnv = process.env.PIPELINE_MODEL && String(process.env.PIPELINE_MODEL).trim();
  if (fromEnv) return fromEnv;
  if (cfg.pipeline && cfg.pipeline.model) return cfg.pipeline.model;
  return DEFAULT_MODEL;
}

function getCursorApiKey() {
  const k = process.env.CURSOR_API_KEY;
  return k && String(k).trim() ? String(k).trim() : null;
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_SKILLS_ROOT,
  loadProjectEnv,
  getSkillsRoot,
  readConfigJson,
  resolvePipelineModel,
  getCursorApiKey,
};

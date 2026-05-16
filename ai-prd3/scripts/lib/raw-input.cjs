'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_SLUGS = new Set([
  'website',
  'admin',
  'backend',
  'miniapp',
  'mobile',
  'desktop',
  'agent',
]);

/**
 * Resolve path to upstream raw requirements document (not hardcoded to req.md).
 * Priority: CLI --raw-input= > env AI_PRD3_RAW_INPUT > stages.pipeline.raw_input.path >
 * stages.prd.inputs.raw_input.primary_path > stages.prd.inputs.raw_input_refs[0] >
 * default convention inputs/req.md (ai-soak3 default, overridable via stages).
 *
 * @param {string} projectRoot
 * @param {object} [stages]
 * @param {{ rawInputOverride?: string }} [opts]
 */
function resolveRawInputPath(projectRoot, stages, opts = {}) {
  const candidates = [];
  if (opts.rawInputOverride) candidates.push(opts.rawInputOverride);
  if (process.env.AI_PRD3_RAW_INPUT) candidates.push(process.env.AI_PRD3_RAW_INPUT);
  if (stages?.pipeline?.raw_input?.path) candidates.push(stages.pipeline.raw_input.path);
  if (stages?.prd?.inputs?.raw_input?.primary_path) {
    candidates.push(stages.prd.inputs.raw_input.primary_path);
  }
  const refs = stages?.stages?.prd?.inputs?.raw_input_refs;
  if (Array.isArray(refs) && refs[0]) candidates.push(refs[0]);
  candidates.push('inputs/req.md');

  for (const rel of candidates) {
    if (!rel || typeof rel !== 'string') continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return { abs, rel: path.isAbsolute(rel) ? path.relative(projectRoot, abs) : rel };
    }
  }
  return { abs: null, rel: candidates[candidates.length - 1] || 'inputs/req.md' };
}

function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readStages(projectRoot) {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeStages(projectRoot, stages) {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(stages, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} projectRoot
 * @param {{ rawInputOverride?: string, updateCache?: boolean }} [opts]
 */
function detectRawInputDrift(projectRoot, opts = {}) {
  const stages = readStages(projectRoot) || {};
  const { abs, rel } = resolveRawInputPath(projectRoot, stages, opts);
  if (!abs) {
    return {
      ok: false,
      error: 'raw_input_missing',
      path: rel,
      message: `未找到原始需求文件（尝试过 pipeline.raw_input.path / raw_input_refs / inputs/req.md）: ${rel}`,
    };
  }

  const hash = sha256File(abs);
  const prdInputs = stages.stages?.prd?.inputs || {};
  const cachedHash = prdInputs.raw_input_hash || '';
  const cachedPath = prdInputs.raw_input_path || '';
  const changed = !cachedHash || cachedHash !== hash || (cachedPath && cachedPath !== rel);

  const result = {
    ok: true,
    path: rel,
    abs_path: abs,
    content_hash: hash,
    cached_hash: cachedHash || null,
    cached_path: cachedPath || null,
    changed,
    first_seen: !cachedHash,
  };

  if (opts.updateCache) {
    stages.stages = stages.stages || {};
    stages.stages.prd = stages.stages.prd || {};
    stages.stages.prd.inputs = stages.stages.prd.inputs || {};
    stages.stages.prd.inputs.raw_input_path = rel;
    stages.stages.prd.inputs.raw_input_hash = hash;
    stages.stages.prd.inputs.raw_input_refs = [rel];
    stages.pipeline = stages.pipeline || {};
    stages.pipeline.raw_input = { path: rel, content_hash: hash, updated_at: new Date().toISOString() };
    writeStages(projectRoot, stages);
    result.cache_updated = true;
  }

  return result;
}

module.exports = {
  ALLOWED_SLUGS,
  resolveRawInputPath,
  sha256File,
  readStages,
  writeStages,
  detectRawInputDrift,
};

'use strict';

const fs = require('fs');
const { stagesPath } = require('./paths.cjs');

function readStages(root) {
  const p = stagesPath(root);
  return { path: p, json: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

function writeStages(p, obj) {
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function markPrdFailed(root, summary) {
  const { path, json } = readStages(root);
  const now = new Date().toISOString();
  json.stages = json.stages || {};
  json.stages.prd = json.stages.prd || {};
  json.stages.prd.status = 'failed';
  json.stages.prd.validation = json.stages.prd.validation || {};
  json.stages.prd.validation.passed = false;
  json.stages.prd.validation.checked_at = now;
  json.stages.prd.validation.summary = summary;
  json.pipeline = json.pipeline || {};
  json.pipeline.updated_at = now;
  json.pipeline.updated_by = 'ai-prd3';
  writeStages(path, json);
}

function markPrdReviewFailed(root, summary) {
  const { path, json } = readStages(root);
  const now = new Date().toISOString();
  json.stages = json.stages || {};
  json.stages.prd_review = json.stages.prd_review || {};
  json.stages.prd_review.status = 'failed';
  json.stages.prd_review.validation = json.stages.prd_review.validation || {};
  json.stages.prd_review.validation.passed = false;
  json.stages.prd_review.validation.checked_at = now;
  json.stages.prd_review.validation.summary = summary;
  json.stages.prd_review.inputs = json.stages.prd_review.inputs || {};
  json.stages.prd_review.inputs.summary_hash = '';
  json.pipeline = json.pipeline || {};
  json.pipeline.updated_at = now;
  json.pipeline.updated_by = 'ai-prd3';
  writeStages(path, json);
}

/** prd3 §11：超时 → 退出码 3，写 outputs.timed_out / duration_ms / timeout_reason */
function markPrdTimeout(root, durationMs, reason = 'stage_timeout') {
  const { path, json } = readStages(root);
  const now = new Date().toISOString();
  json.stages = json.stages || {};
  json.stages.prd = json.stages.prd || {};
  json.stages.prd.status = 'failed';
  json.stages.prd.outputs = json.stages.prd.outputs || {};
  json.stages.prd.outputs.timed_out = true;
  json.stages.prd.outputs.duration_ms = durationMs;
  json.stages.prd.outputs.timeout_reason = reason;
  json.stages.prd.validation = json.stages.prd.validation || {};
  json.stages.prd.validation.passed = false;
  json.stages.prd.validation.checked_at = now;
  json.stages.prd.validation.summary = reason;
  json.pipeline = json.pipeline || {};
  json.pipeline.updated_at = now;
  json.pipeline.updated_by = 'ai-prd3';
  writeStages(path, json);
}

function markPrdReviewTimeout(root, durationMs, reason = 'stage_timeout') {
  const { path, json } = readStages(root);
  const now = new Date().toISOString();
  json.stages = json.stages || {};
  json.stages.prd_review = json.stages.prd_review || {};
  json.stages.prd_review.status = 'failed';
  json.stages.prd_review.outputs = json.stages.prd_review.outputs || {};
  json.stages.prd_review.outputs.timed_out = true;
  json.stages.prd_review.outputs.duration_ms = durationMs;
  json.stages.prd_review.outputs.timeout_reason = reason;
  json.stages.prd_review.validation = json.stages.prd_review.validation || {};
  json.stages.prd_review.validation.passed = false;
  json.stages.prd_review.validation.checked_at = now;
  json.stages.prd_review.validation.summary = reason;
  json.stages.prd_review.inputs = json.stages.prd_review.inputs || {};
  json.stages.prd_review.inputs.summary_hash = '';
  json.pipeline = json.pipeline || {};
  json.pipeline.updated_at = now;
  json.pipeline.updated_by = 'ai-prd3';
  writeStages(path, json);
}

module.exports = { markPrdFailed, markPrdReviewFailed, markPrdTimeout, markPrdReviewTimeout };

'use strict';

/**
 * prd3 §8.3：合并前对 LLM JSON 做确定性结构校验（与 templates/schemas/prd-review-output.v1.schema.json 对齐的最小必填子集）。
 * @param {unknown} payload
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
function validatePrdReviewMergePayload(payload) {
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['payload_not_object'] };
  }
  const keys = Object.keys(payload);
  if (keys.length === 0) return { ok: false, errors: ['payload_empty'] };

  const review = payload.review;
  if (review !== undefined && (review === null || typeof review !== 'object' || Array.isArray(review))) {
    errors.push('review_not_object');
  }
  const outputs = payload.outputs;
  if (outputs !== undefined && (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs))) {
    errors.push('outputs_not_object');
  }
  if (payload.blocking_issues !== undefined && !Array.isArray(payload.blocking_issues)) {
    errors.push('blocking_issues_not_array');
  }
  if (payload.conditions !== undefined && !Array.isArray(payload.conditions)) {
    errors.push('conditions_not_array');
  }
  if (review != null && typeof review === 'object' && !Array.isArray(review) && !Array.isArray(review.phase_plan)) {
    errors.push('review.phase_plan_missing_or_not_array');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

module.exports = { validatePrdReviewMergePayload };

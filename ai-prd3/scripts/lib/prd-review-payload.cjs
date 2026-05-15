'use strict';

const { validatePrdReviewOutputAgainstSchema } = require('./schema-validate.cjs');

/**
 * prd3 §8.3：合并前用 **templates/schemas/prd-review-output.v1.schema.json**（AJV）做机器校验。
 * @param {unknown} payload
 * @param {string} skillRoot ai-prd3 根目录（须含 templates/schemas）
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
function validatePrdReviewMergePayload(payload, skillRoot) {
  if (!skillRoot || typeof skillRoot !== 'string') {
    return { ok: false, errors: ['skill_root_required_for_schema_validation'] };
  }
  return validatePrdReviewOutputAgainstSchema(skillRoot, payload);
}

module.exports = { validatePrdReviewMergePayload };

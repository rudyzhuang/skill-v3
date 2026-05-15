'use strict';

const fs = require('fs');
const path = require('path');

let AjvCtor;
let addFormats;
try {
  AjvCtor = require('ajv');
  addFormats = require('ajv-formats');
} catch (_) {
  AjvCtor = null;
}

let cachedValidate = null;
let cachedSkillRoot = '';

/**
 * @param {string} skillRoot ai-prd3 根目录（含 templates/schemas）
 * @returns {import('ajv').ValidateFunction}
 */
function getPrdReviewOutputValidator(skillRoot) {
  if (!AjvCtor) {
    throw new Error(
      'Missing dependency "ajv". Run: npm install (in the ai-prd3 skill directory). See SKILL.md §3.'
    );
  }
  const root = path.resolve(skillRoot);
  if (cachedValidate && cachedSkillRoot === root) return cachedValidate;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const schemaPath = path.join(root, 'templates', 'schemas', 'prd-review-output.v1.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  cachedValidate = ajv.compile(schema);
  cachedSkillRoot = root;
  return cachedValidate;
}

/**
 * 对照 templates/schemas/prd-review-output.v1.schema.json（prd3.md §8.3 / T1）。
 * @param {string} skillRoot
 * @param {unknown} data
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
function validatePrdReviewOutputAgainstSchema(skillRoot, data) {
  try {
    const v = getPrdReviewOutputValidator(skillRoot);
    const ok = v(data);
    if (ok) return { ok: true };
    const errs = (v.errors || []).map((e) => `schema:${e.instancePath || '/'} ${e.message}`);
    return { ok: false, errors: errs.length ? errs : ['schema:unknown_error'] };
  } catch (e) {
    return { ok: false, errors: [`schema_loader:${String(e.message || e)}`] };
  }
}

module.exports = {
  validatePrdReviewOutputAgainstSchema,
  getPrdReviewOutputValidator,
};

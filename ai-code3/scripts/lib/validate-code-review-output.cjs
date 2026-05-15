'use strict';

const fs = require('fs');
const path = require('path');

let _validate;

function skillRoot() {
  return path.join(__dirname, '..', '..');
}

function schemaPath() {
  return path.join(skillRoot(), 'templates', 'schemas', 'code-review-output.v3.schema.json');
}

function loadValidator() {
  if (_validate) return _validate;
  const root = skillRoot();
  let Ajv;
  let addFormats;
  try {
    Ajv = require(path.join(root, 'node_modules', 'ajv', 'dist', '2020.js'));
    addFormats = require(path.join(root, 'node_modules', 'ajv-formats'));
  } catch (e) {
    throw new Error(`run "npm ci" in ${root} for code_review JSON Schema (${e.message || e})`);
  }
  const ajv = new Ajv({ allErrors: true, strict: true });
  if (typeof addFormats === 'function') addFormats(ajv);
  const raw = JSON.parse(fs.readFileSync(schemaPath(), 'utf8'));
  _validate = ajv.compile(raw);
  return _validate;
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, data: object } | { ok: false, errors: string }}
 */
function validateCodeReviewOutput(data) {
  const validate = loadValidator();
  if (validate(data)) return { ok: true, data };
  const errs = (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
  return { ok: false, errors: errs || 'schema validation failed' };
}

module.exports = { validateCodeReviewOutput, schemaPath, skillRoot };

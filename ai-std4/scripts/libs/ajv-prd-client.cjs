'use strict';

/**
 * Ajv 实例（预注册 prd-client.base.schema.json），供 prd / prd-review 校验各端 prd-*.json。
 */

const fs   = require('fs');
const path = require('path');

let _ajv = null;
/** @type {Map<string, import('ajv').ValidateFunction>} */
const _validators = new Map();

function getSchemasDir(skillsRoot) {
  return path.join(skillsRoot, 'ai-std4', 'schemas');
}

/** @param {string} skillsRoot */
function getPrdClientAjv(skillsRoot) {
  if (_ajv) return _ajv;
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  _ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(_ajv);

  const basePath = path.join(getSchemasDir(skillsRoot), 'prd-client.base.schema.json');
  if (fs.existsSync(basePath)) {
    const baseSchema = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    _ajv.addSchema(baseSchema);
  }
  return _ajv;
}

/**
 * @param {object} opts
 * @param {string} opts.skillsRoot
 * @param {string} opts.schemaName
 * @param {unknown} opts.data
 */
function validatePrdClientJson({ skillsRoot, schemaName, data }) {
  const schemaPath = path.join(getSchemasDir(skillsRoot), schemaName);
  if (!fs.existsSync(schemaPath)) {
    return { valid: true, errors: [] };
  }
  let validate = _validators.get(schemaName);
  if (!validate) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const ajv = getPrdClientAjv(skillsRoot);
    validate = ajv.compile(schema);
    _validators.set(schemaName, validate);
  }
  const valid = validate(data);
  return { valid, errors: validate.errors || [] };
}

module.exports = { getPrdClientAjv, validatePrdClientJson };

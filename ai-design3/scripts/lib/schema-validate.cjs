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

function createValidators(skillRoot) {
  if (!AjvCtor) {
    throw new Error(
      'Missing dependency "ajv". Run: npm install (in the ai-design3 skill directory).'
    );
  }
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const schemasDir = path.join(skillRoot, 'templates', 'schemas');
  const load = (name) => {
    const p = path.join(schemasDir, name);
    const schema = JSON.parse(fs.readFileSync(p, 'utf8'));
    return ajv.compile(schema);
  };
  return {
    validateDesignSpec: load('design-spec.v3.schema.json'),
    validateDesignSnapshot: load('design-snapshot.v3.schema.json'),
    validateArtifactItem: load('contract-artifacts-item.v3.schema.json'),
  };
}

function validateJson(v, data, label) {
  const ok = v(data);
  return { ok, errors: ok ? [] : (v.errors || []).map((e) => `${label}: ${e.instancePath} ${e.message}`) };
}

module.exports = {
  createValidators,
  validateJson,
};

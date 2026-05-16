'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function designSpecRel(featureId) {
  return path.join('docs', 'designs', `${featureId}.design.json`);
}

function computeDesignInputHash(projectRoot, featureIds) {
  const files = {};
  const addFile = (rel) => {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs)) files[rel.split(path.sep).join('/')] = sha256Hex(fs.readFileSync(abs, 'utf8'));
  };
  addFile(path.join('docs', 'prd-spec.md'));
  addFile(path.join('docs', 'config.dev.json'));
  addFile(path.join('docs', 'config.release.json'));
  for (const fid of featureIds) {
    addFile(designSpecRel(fid));
    addFile(path.join('docs', 'designs', `${fid}.style-scan.json`));
    addFile(path.join('docs', 'designs', `${fid}.lib-research.json`));
  }
  const payload = { feature_ids: featureIds, files };
  return sha256Hex(JSON.stringify(payload));
}

function computeContractInputHash(projectRoot, artifacts) {
  const files = {};
  for (const a of artifacts) {
    for (const k of ['types', 'api', 'schema', 'test_spec', 'design_snapshot']) {
      const rel = a[k];
      if (!rel) continue;
      const abs = path.join(projectRoot, ...rel.split('/'));
      if (fs.existsSync(abs)) files[rel] = sha256Hex(fs.readFileSync(abs, 'utf8'));
    }
  }
  return sha256Hex(JSON.stringify({ artifacts, files }));
}

function computeDesignReviewInputHash(projectRoot, artifacts, designSpecs) {
  const files = {};
  for (const a of artifacts) {
    for (const k of ['types', 'api', 'schema', 'test_spec', 'design_snapshot']) {
      const rel = a[k];
      if (!rel) continue;
      const abs = path.join(projectRoot, ...rel.split('/'));
      if (fs.existsSync(abs)) files[rel] = sha256Hex(fs.readFileSync(abs, 'utf8'));
    }
  }
  for (const s of designSpecs || []) {
    if (s.spec_path) {
      const abs = path.join(projectRoot, ...String(s.spec_path).split('/'));
      if (fs.existsSync(abs)) files[s.spec_path] = sha256Hex(fs.readFileSync(abs, 'utf8'));
    }
  }
  return sha256Hex(JSON.stringify({ artifacts, design_specs: designSpecs || [], files }));
}

module.exports = {
  computeDesignInputHash,
  computeContractInputHash,
  computeDesignReviewInputHash,
};

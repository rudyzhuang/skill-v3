'use strict';

const fs = require('fs');
const path = require('path');

function stagesFile(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'stages.json');
}

function readStages(projectRoot) {
  const p = stagesFile(projectRoot);
  if (!fs.existsSync(p)) {
    const err = new Error(`missing_stages_json: ${p}`);
    err.code = 'MISSING_STAGES';
    throw err;
  }
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`invalid_json_stages: ${e.message}`);
    err.code = 'BAD_JSON';
    throw err;
  }
}

function writeStages(projectRoot, data, dryRun) {
  if (dryRun) return;
  const dir = path.join(projectRoot, '.pipeline');
  fs.mkdirSync(dir, { recursive: true });
  const p = stagesFile(projectRoot);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isoNow() {
  return new Date().toISOString();
}

module.exports = {
  stagesFile,
  readStages,
  writeStages,
  isoNow,
};

'use strict';

const fs = require('fs');
const path = require('path');

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function readStages(stagesPath) {
  return JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
}

function updateStages(stagesPath, mutator) {
  const doc = readStages(stagesPath);
  mutator(doc);
  atomicWriteJson(stagesPath, doc);
  return doc;
}

module.exports = { atomicWriteJson, readStages, updateStages };

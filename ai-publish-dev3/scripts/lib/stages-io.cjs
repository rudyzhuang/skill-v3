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

/**
 * @param {string} stagesPath
 * @param {(doc: object) => void} mutator
 */
function updateStages(stagesPath, mutator) {
  const doc = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
  mutator(doc);
  atomicWriteJson(stagesPath, doc);
}

module.exports = { atomicWriteJson, updateStages };

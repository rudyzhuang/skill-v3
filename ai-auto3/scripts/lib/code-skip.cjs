'use strict';

const path = require('path');
const { skillsRootFromThisFile } = require('./paths.cjs');

function tryLoadCode3SummaryHash() {
  const p = path.join(skillsRootFromThisFile(), 'ai-code3', 'scripts', 'lib', 'summary-hash.cjs');
  try {
    return require(p);
  } catch {
    return null;
  }
}

/**
 * @param {object} stagesDoc
 * @param {string} stageKey underscore key in stages.json
 * @param {string} projectRoot
 * @param {string[]} featureIds
 * @param {string|null} forceRerun
 */
function shouldSkipCodeStage(stagesDoc, stageKey, projectRoot, featureIds, forceRerun, soakOpts = null) {
  const mod = tryLoadCode3SummaryHash();
  if (!mod || typeof mod.shouldSkipStage !== 'function') return false;
  return mod.shouldSkipStage(stagesDoc, stageKey, projectRoot, featureIds, forceRerun, soakOpts);
}

module.exports = { shouldSkipCodeStage, tryLoadCode3SummaryHash };

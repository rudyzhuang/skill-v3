'use strict';

const { scriptPath } = require('./paths.cjs');

/**
 * @returns {{ runPreflight: Function } | null}
 */
function tryLoadPublishPreflight() {
  const p = scriptPath('ai-publish-dev3', 'scripts/preflight.cjs');
  try {
    return require(p);
  } catch {
    return null;
  }
}

/**
 * deploy 前产物映射门闸（与 ai-publish-dev3 preflight 一致）
 * @param {string} projectRoot
 * @returns {{ ok: boolean, message?: string }}
 */
function runDeployArtifactPreflight(projectRoot) {
  const mod = tryLoadPublishPreflight();
  if (!mod || typeof mod.runPreflight !== 'function') {
    return { ok: true };
  }
  const r = mod.runPreflight(projectRoot);
  if (r.ok) return { ok: true };
  return { ok: false, message: r.message || 'deploy preflight failed' };
}

/**
 * 映射失败且文案暗示缺 build 产物时，可在 skip build 后强制重跑 build
 * @param {string} [message]
 * @returns {boolean}
 */
function mappingFailureLooksLikeStaleBuild(message) {
  if (!message) return false;
  return /未登记|0 条|artifact 一对一映射失败/.test(message);
}

module.exports = {
  runDeployArtifactPreflight,
  mappingFailureLooksLikeStaleBuild,
  tryLoadPublishPreflight,
};

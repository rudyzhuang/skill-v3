'use strict';

const agentLog = require('../../../scripts/lib/agent-sessions-log.cjs');

function sessionsDir(projectRoot) {
  return agentLog.agentSessionsRoot(projectRoot);
}

/**
 * @param {string} projectRoot
 * @param {string|null|undefined} sessionId
 * @param {string} line 单行正文（不含时间戳前缀）
 * @param {{ stageKey?: string, featureIds?: string[], skill?: string }} [opts]
 */
function appendSessionLog(projectRoot, sessionId, line, opts = {}) {
  agentLog.appendSessionLine(projectRoot, sessionId, line, {
    stageKey: opts.stageKey,
    featureIds: opts.featureIds,
    skill: opts.skill || 'ai-publish-dev3',
  });
}

module.exports = { appendSessionLog, sessionsDir };

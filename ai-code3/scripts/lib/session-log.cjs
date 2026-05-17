'use strict';

const agentLog = require('../../../scripts/lib/agent-sessions-log.cjs');

function sessionLogPath(projectRoot, sessionId) {
  return agentLog.sessionLogPath(projectRoot, sessionId);
}

/** §15：长阶段心跳（单行追加）；默认同时打到 stderr 便于 autorun 长等待时观察进度 */
function appendHeartbeat(projectRoot, sessionId, stage, intervalLabel, opts = {}) {
  agentLog.appendHeartbeat(projectRoot, sessionId, stage, intervalLabel, {
    ...opts,
    stderrTag: 'ai-code3',
  });
}

module.exports = { sessionLogPath, appendHeartbeat };

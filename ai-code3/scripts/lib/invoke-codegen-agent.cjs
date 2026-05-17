'use strict';

const { invokeAiCode3Agent } = require('./invoke-ai-code3-agent.cjs');

/** @deprecated 名称保留：请优先使用 {@link invokeAiCode3Agent} */
async function invokeCodegenAgent({ worktreePath, projectRoot, phase, timeoutMs, featureId, sessionId }) {
  return invokeAiCode3Agent({
    worktreePath,
    projectRoot,
    phase,
    featureId: featureId || '',
    timeoutMs,
    extraEnv: {},
    sessionId,
  });
}

module.exports = { invokeCodegenAgent };

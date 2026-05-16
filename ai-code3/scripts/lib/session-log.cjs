'use strict';

const fs = require('fs');
const path = require('path');

function sessionLogPath(projectRoot, sessionId) {
  const sid = sessionId && String(sessionId).trim() ? String(sessionId).trim() : 'default';
  const dir = path.join(projectRoot, '.agent-sessions');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sid}.log`);
}

/** §15：长阶段心跳（单行追加）；默认同时打到 stderr 便于 autorun 长等待时观察进度 */
function appendHeartbeat(projectRoot, sessionId, stage, intervalLabel) {
  const label = intervalLabel || '';
  const msg = `alive: stage=${stage} ${label}`.trim();
  try {
    const p = sessionLogPath(projectRoot, sessionId);
    fs.appendFileSync(p, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {
    /* ignore */
  }
  if (process.env.AI_AUTO3_LOG_HEARTBEAT === '0') return;
  console.error(`[ai-code3] heartbeat session=${sessionId || 'default'} ${msg}`);
}

module.exports = { sessionLogPath, appendHeartbeat };

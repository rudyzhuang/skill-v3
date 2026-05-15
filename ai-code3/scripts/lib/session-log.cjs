'use strict';

const fs = require('fs');
const path = require('path');

function sessionLogPath(projectRoot, sessionId) {
  const sid = sessionId && String(sessionId).trim() ? String(sessionId).trim() : 'default';
  const dir = path.join(projectRoot, '.agent-sessions');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sid}.log`);
}

/** §15：长阶段心跳（单行追加） */
function appendHeartbeat(projectRoot, sessionId, stage, intervalLabel) {
  try {
    const p = sessionLogPath(projectRoot, sessionId);
    const line = `${new Date().toISOString()} alive: stage=${stage} ${intervalLabel || ''}\n`;
    fs.appendFileSync(p, line, 'utf8');
  } catch {
    /* ignore */
  }
}

module.exports = { sessionLogPath, appendHeartbeat };

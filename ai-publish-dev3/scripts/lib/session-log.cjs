'use strict';

const fs = require('fs');
const path = require('path');

function sessionsDir(projectRoot) {
  return path.join(projectRoot, '.agent-sessions');
}

/**
 * @param {string} projectRoot
 * @param {string|null|undefined} sessionId
 * @param {string} line 单行正文（不含时间戳前缀）
 */
function appendSessionLog(projectRoot, sessionId, line) {
  const dir = sessionsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const sid = (sessionId && String(sessionId).trim()) || `pid-${process.pid}`;
  const f = path.join(dir, `${sid}.log`);
  const ts = new Date().toISOString();
  fs.appendFileSync(f, `${ts} ${line}\n`, { encoding: 'utf8' });
}

module.exports = { appendSessionLog, sessionsDir };

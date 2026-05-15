'use strict';

const fs = require('fs');
const path = require('path');
const { pipelineLockPath } = require('./paths.cjs');

/**
 * @returns {{ ok: boolean, release: () => void, path: string }}
 */
function acquirePipelineLock(projectRoot, sessionId) {
  const lp = pipelineLockPath(projectRoot);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  if (fs.existsSync(lp)) {
    let stale = false;
    try {
      const j = JSON.parse(fs.readFileSync(lp, 'utf8').trim());
      const pid = j.pid;
      if (typeof pid === 'number') {
        try {
          process.kill(pid, 0);
        } catch {
          stale = true;
        }
      }
    } catch {
      stale = true;
    }
    if (!stale) {
      return {
        ok: false,
        path: lp,
        release() {},
      };
    }
    try {
      fs.unlinkSync(lp);
    } catch {
      /* */
    }
  }
  const payload = `${JSON.stringify({
    pid: process.pid,
    session_id: sessionId || '',
    started_at: new Date().toISOString(),
    skill: 'ai-auto3',
    scope: 'pipeline',
  })}\n`;
  fs.writeFileSync(lp, payload, 'utf8');
  return {
    ok: true,
    path: lp,
    release() {
      try {
        if (fs.existsSync(lp)) fs.unlinkSync(lp);
      } catch {
        /* */
      }
    },
  };
}

module.exports = { acquirePipelineLock, pipelineLockPath };

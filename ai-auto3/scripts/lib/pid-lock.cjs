'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pipelineLockPath } = require('./paths.cjs');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isAgedOutAiAuto3Lock(meta, pid) {
  const maxAgeSRaw = process.env.AI_AUTO3_LOCK_MAX_AGE_S;
  const maxAgeS = Number.isFinite(Number(maxAgeSRaw)) && Number(maxAgeSRaw) > 0 ? Number(maxAgeSRaw) : 300;
  const startedAtMs = Date.parse(String(meta?.started_at || ''));
  if (!Number.isFinite(startedAtMs)) return false;
  const ageMs = Date.now() - startedAtMs;
  if (ageMs <= maxAgeS * 1000) return false;
  const cmd = readPidCommand(pid);
  return cmd.includes('ai-auto3/scripts/autorun.cjs');
}

/**
 * @returns {{ ok: boolean, release: () => void, path: string }}
 */
function acquirePipelineLock(projectRoot, sessionId) {
  const lp = pipelineLockPath(projectRoot);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  if (fs.existsSync(lp)) {
    let stale = false;
    let lockMeta = null;
    try {
      const j = JSON.parse(fs.readFileSync(lp, 'utf8').trim());
      lockMeta = j;
      const pid = j.pid;
      if (typeof pid === 'number') {
        if (!pidAlive(pid)) {
          stale = true;
        } else if (isAgedOutAiAuto3Lock(j, pid)) {
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
        meta: lockMeta,
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

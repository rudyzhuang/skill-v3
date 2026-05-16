'use strict';

const { spawn } = require('child_process');

const DEFAULT_GRACE_MS = 5000;

/**
 * SIGTERM → 宽限期 → SIGKILL；超时返回 code=3 且 timedOut=true（与 ai-code3 / input-spec 一致）。
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env?: object, timeoutMs: number, gracefulShutdownMs?: number }} opts
 * @returns {Promise<{ code: number, signal: string | null, timedOut: boolean }>}
 */
function runWithTimeout(command, args, opts) {
  const { cwd, env, timeoutMs, gracefulShutdownMs = DEFAULT_GRACE_MS } = opts;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    let timedOut = false;
    let settled = false;
    const finish = (code, signal, t) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({
        code: timedOut ? 3 : code ?? 1,
        signal: signal || null,
        timedOut,
      });
    };

    const t = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* */
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          /* */
        }
      }, gracefulShutdownMs).unref();
    }, timeoutMs);

    child.on('close', (code, signal) => {
      finish(code, signal, t);
    });
    child.on('error', () => {
      finish(1, null, t);
    });
  });
}

module.exports = { runWithTimeout, DEFAULT_GRACE_MS };

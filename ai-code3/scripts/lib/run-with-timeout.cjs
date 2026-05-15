'use strict';

const { spawn } = require('child_process');

const DEFAULT_GRACE_MS = 5000;

/**
 * SIGTERM → 宽限期 → SIGKILL（对齐 docs/spec/code3.md 附录 A · A.6）。
 * 超时返回 code=3 且 timedOut=true（与 input-spec 超时映射一致）。
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number, gracefulShutdownMs?: number }} opts
 * @returns {Promise<{ code: number, timedOut: boolean }>}
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
    const finish = (code, t) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      const c = timedOut ? 3 : code ?? 1;
      resolve({ code: c, timedOut });
    };

    const t = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {}
      }, gracefulShutdownMs).unref();
    }, timeoutMs);

    child.on('close', (code) => {
      finish(code, t);
    });
    child.on('error', () => {
      finish(1, t);
    });
  });
}

module.exports = { runWithTimeout, DEFAULT_GRACE_MS };

'use strict';

const { spawn } = require('child_process');

const DEFAULT_GRACE_MS = 5000;

/**
 * SIGTERM → 宽限期 → SIGKILL（对齐 docs/spec/code3.md 附录 A · A.6）。
 * 超时返回 code=3 且 timedOut=true（与 input-spec 超时映射一致）。
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number, gracefulShutdownMs?: number }} opts
 * @returns {Promise<{ code: number, timedOut: boolean, pid: number|null }>}
 */
function runWithTimeout(command, args, opts) {
  const {
    cwd,
    env,
    timeoutMs,
    gracefulShutdownMs = DEFAULT_GRACE_MS,
    onSpawn,
    captureIo = false,
  } = opts;
  const stdio = captureIo ? ['ignore', 'pipe', 'pipe'] : 'inherit';
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio,
    });
    if (captureIo) {
      child.stdout?.on('data', (d) => {
        stdout += d.toString();
        if (process.env.AI_CODE3_AGENT_TEE_STDOUT === '1') process.stderr.write(d);
      });
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
        if (process.env.AI_CODE3_AGENT_TEE_STDERR === '1') process.stderr.write(d);
      });
    }
    if (typeof onSpawn === 'function' && child.pid) {
      try {
        onSpawn(child.pid);
      } catch {
        /* ignore */
      }
    }
    let timedOut = false;
    let settled = false;
    const finish = (code, t) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      const c = timedOut ? 3 : code ?? 1;
      resolve({ code: c, timedOut, pid: child.pid ?? null, stdout, stderr });
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

'use strict';

const { spawn } = require('child_process');

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env?: object, timeoutMs: number }} opts
 * @returns {Promise<{ code: number, signal: string | null }>}
 */
function runWithTimeout(command, args, opts) {
  const { cwd, env, timeoutMs } = opts;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* */
      }
      setTimeout(() => {
        if (done) return;
        try {
          child.kill('SIGKILL');
        } catch {
          /* */
        }
      }, 5000);
    }, timeoutMs);

    child.on('close', (code, signal) => {
      done = true;
      clearTimeout(t);
      resolve({ code: code ?? 1, signal: signal || null });
    });
    child.on('error', () => {
      done = true;
      clearTimeout(t);
      resolve({ code: 1, signal: null });
    });
  });
}

module.exports = { runWithTimeout };

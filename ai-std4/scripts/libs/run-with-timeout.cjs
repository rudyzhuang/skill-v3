'use strict';

const { spawn } = require('child_process');

/**
 * @returns {Promise<{ code: number|null, timedOut: boolean, stdout: string, stderr: string }>}
 */
function runWithTimeout(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 600000;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, timedOut, stdout, stderr: `${stderr}\n${e.message}` });
    });
  });
}

module.exports = { runWithTimeout };

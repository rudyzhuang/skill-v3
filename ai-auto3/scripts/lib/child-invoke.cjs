'use strict';

const { runWithTimeout } = require('./run-with-timeout.cjs');

/**
 * @param {{ node: string, script: string, args: string[], cwd: string, env?: object, timeoutMs: number }} p
 */
async function runNodeScript(p) {
  const args = [p.script, ...p.args];
  const r = await runWithTimeout(p.node, args, {
    cwd: p.cwd,
    env: p.env || {},
    timeoutMs: p.timeoutMs,
  });
  return r.code;
}

module.exports = { runNodeScript };

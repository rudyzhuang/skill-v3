'use strict';

const path = require('path');
const { runWithTimeout } = require('./run-with-timeout.cjs');

/**
 * @param {{ node: string, script: string, args: string[], cwd: string, env?: object, timeoutMs: number }} p
 */
async function runNodeScript(p) {
  const args = [p.script, ...p.args];
  const cmdPreview = `${path.basename(p.script)} ${p.args.slice(0, 4).join(' ')}${p.args.length > 4 ? ' ...' : ''}`;
  const t0 = Date.now();
  console.error(`[ai-auto3] exec begin: ${cmdPreview} timeout_ms=${p.timeoutMs}`);
  const r = await runWithTimeout(p.node, args, {
    cwd: p.cwd,
    env: p.env || {},
    timeoutMs: p.timeoutMs,
  });
  const elapsed = Date.now() - t0;
  console.error(
    `[ai-auto3] exec end: ${cmdPreview} exit=${r.code} elapsed_ms=${elapsed}${r.timedOut ? ' timed_out=1' : ''}`
  );
  return r.code;
}

module.exports = { runNodeScript };

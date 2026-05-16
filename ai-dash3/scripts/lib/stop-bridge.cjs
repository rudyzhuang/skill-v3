'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function skillsRootFromDash() {
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * @param {string} projectRoot absolute path
 * @returns {{ ok: boolean, data?: object, error?: string, exit_code: number }}
 */
function invokeStopPipeline(projectRoot) {
  const script = path.join(skillsRootFromDash(), 'ai-auto3', 'scripts', 'stop-pipeline.cjs');
  const r = spawnSync(process.execPath, [script, `--project=${projectRoot}`], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  if (r.error) {
    return { ok: false, exit_code: 1, error: String(r.error.message || r.error) };
  }
  let data = null;
  if (stdout) {
    try {
      data = JSON.parse(stdout);
    } catch {
      return { ok: false, exit_code: r.status ?? 1, error: stderr || 'invalid stop-pipeline JSON output' };
    }
  }
  const exitCode = r.status ?? 1;
  if (exitCode !== 0 && exitCode !== 2) {
    return {
      ok: false,
      exit_code: exitCode,
      error: stderr || data?.error || `stop-pipeline exited ${exitCode}`,
      data,
    };
  }
  return { ok: data?.ok !== false, exit_code: exitCode, data };
}

module.exports = { invokeStopPipeline };

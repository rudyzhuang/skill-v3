'use strict';

const { spawnSync } = require('child_process');

/**
 * spawnSync + 超时。超时：status 为 null、error.code === 'ETIMEDOUT'（Node 文档）。
 * @param {string} command
 * @param {string[]} args
 * @param {import('child_process').SpawnSyncOptions} opts
 * @param {number} timeoutMs <=0 表示不限制
 * @returns {import('child_process').SpawnSyncWithStringEncoding & { timedOut?: boolean }}
 */
function spawnSyncWithTimeout(command, args, opts, timeoutMs) {
  const merged = {
    ...opts,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
  };
  const r = spawnSync(command, args, merged);
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  return { ...r, timedOut };
}

/**
 * @param {string} projectRoot
 * @param {'prd'|'prd_review'} stage
 * @returns {number} 秒，<=0 表示未配置则回退默认 600
 */
function readStageTimeoutSec(projectRoot, stage) {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return 600;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const key = stage === 'prd_review' ? 'prd_review_s' : 'prd_s';
    const v = j.timeouts?.stages?.[key];
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 600;
  } catch {
    return 600;
  }
}

module.exports = { spawnSyncWithTimeout, readStageTimeoutSec };

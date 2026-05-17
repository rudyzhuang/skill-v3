'use strict';

const fs = require('fs');
const path = require('path');

/**
 * prd3.md §11 / input-spec.md §6：可观测性。失败不阻断主流程。
 * @param {string} projectRoot
 * @param {Record<string, unknown>} rec
 */
function appendSessionLog(projectRoot, rec) {
  try {
    const dir = path.join(projectRoot, '.agent-sessions');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const payload = { ts, skill: 'ai-prd3', ...rec };
    fs.appendFileSync(path.join(dir, 'ai-prd3.ndjson'), `${JSON.stringify(payload)}\n`, 'utf8');
    const sid = typeof rec.session_id === 'string' ? rec.session_id.trim() : '';
    if (sid) {
      const safe = sid.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      const logFile = path.join(dir, `${safe}.log`);
      const human =
        rec.message ||
        `${String(rec.event || 'log')}${rec.subcommand ? ` (${rec.subcommand})` : ''}${
          rec.exit_code != null ? ` exit=${rec.exit_code}` : ''
        }`;
      const detail = rec.detail ? ` — ${rec.detail}` : rec.summary ? ` — ${rec.summary}` : '';
      const msg = `[${ts}] [ai-prd3] ${human}${detail}\n`;
      fs.appendFileSync(logFile, msg, 'utf8');
    }
  } catch (_) {
    /* 不因日志失败阻断主流程 */
  }
}

module.exports = { appendSessionLog };

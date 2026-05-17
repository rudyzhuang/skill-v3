'use strict';

const fs = require('fs');
const path = require('path');
const agentLog = require('../../../scripts/lib/agent-sessions-log.cjs');

function stageKeyFromSubcommand(sub) {
  const s = String(sub || '').trim();
  if (!s) return '';
  if (s === 'bootstrap' || s === 'validate-prd' || s === 'write-prd' || s === 'apply-raw-input-config') {
    return 'prd';
  }
  if (
    s === 'validate-prd-review' ||
    s === 'write-prd-review' ||
    s === 'finalize-prd-review' ||
    s === 'report'
  ) {
    return 'prd_review';
  }
  return '';
}

/**
 * prd3.md §11 / input-spec.md §6：可观测性。失败不阻断主流程。
 * @param {string} projectRoot
 * @param {Record<string, unknown>} rec
 */
function appendSessionLog(projectRoot, rec) {
  try {
    const dir = agentLog.agentSessionsRoot(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const payload = { ts, skill: 'ai-prd3', ...rec };
    fs.appendFileSync(path.join(dir, 'ai-prd3.ndjson'), `${JSON.stringify(payload)}\n`, 'utf8');
    const sid = typeof rec.session_id === 'string' ? rec.session_id.trim() : '';
    const stageKey = stageKeyFromSubcommand(rec.subcommand);
    const human =
      rec.message ||
      `${String(rec.event || 'log')}${rec.subcommand ? ` (${rec.subcommand})` : ''}${
        rec.exit_code != null ? ` exit=${rec.exit_code}` : ''
      }`;
    const detail = rec.detail ? ` — ${rec.detail}` : rec.summary ? ` — ${rec.summary}` : '';
    const msg = `[ai-prd3] ${human}${detail}`;
    agentLog.appendAgentLog(projectRoot, {
      sessionId: sid,
      stageKey,
      skill: 'ai-prd3',
      line: msg,
      featureIds: rec.feature_ids || rec.featureIds,
    });
  } catch (_) {
    /* 不因日志失败阻断主流程 */
  }
}

module.exports = { appendSessionLog, stageKeyFromSubcommand };

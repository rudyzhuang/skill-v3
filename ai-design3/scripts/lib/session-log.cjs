'use strict';

const fs = require('fs');
const path = require('path');
const agentLog = require('../../../scripts/lib/agent-sessions-log.cjs');

/**
 * 追加一行 NDJSON 到 <project_root>/.agent-sessions/ai-design3.ndjson（design3 §8.4 / input-spec §6）
 * @param {string} projectRoot
 * @param {object} rec
 */
function appendSessionLog(projectRoot, rec) {
  try {
    const dir = agentLog.agentSessionsRoot(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const line =
      JSON.stringify({
        ts,
        skill: 'ai-design3',
        ...rec,
      }) + '\n';
    fs.appendFileSync(path.join(dir, 'ai-design3.ndjson'), line, 'utf8');
    const sid = typeof rec.session_id === 'string' ? rec.session_id.trim() : '';
    const stageKey =
      rec.stageKey ||
      rec.stage ||
      (rec.cmd === 'validate-design' || rec.cmd === 'write-design'
        ? 'design'
        : rec.cmd && String(rec.cmd).includes('contract')
          ? 'contract'
          : rec.cmd && String(rec.cmd).includes('design-review')
            ? 'design_review'
            : '');
    const human =
      rec.message ||
      `${String(rec.event || rec.cmd || 'log')}${rec.feature_id ? ` feature=${rec.feature_id}` : ''}`;
    const detail = rec.detail ? ` — ${rec.detail}` : '';
    agentLog.appendAgentLog(projectRoot, {
      sessionId: sid,
      stageKey,
      skill: 'ai-design3',
      line: `${human}${detail}`,
      featureId: rec.feature_id,
      featureIds: rec.feature_ids || rec.featureIds,
    });
  } catch (_) {
    /* 不因日志失败阻断主流程 */
  }
}

module.exports = { appendSessionLog };

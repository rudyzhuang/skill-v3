'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 追加一行 NDJSON 到 <project_root>/.agent-sessions/ai-design3.ndjson（design3 §8.4 / input-spec §6）
 * @param {string} projectRoot
 * @param {object} rec
 */
function appendSessionLog(projectRoot, rec) {
  try {
    const dir = path.join(projectRoot, '.agent-sessions');
    fs.mkdirSync(dir, { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        skill: 'ai-design3',
        ...rec,
      }) + '\n';
    fs.appendFileSync(path.join(dir, 'ai-design3.ndjson'), line, 'utf8');
  } catch (_) {
    /* 不因日志失败阻断主流程 */
  }
}

module.exports = { appendSessionLog };

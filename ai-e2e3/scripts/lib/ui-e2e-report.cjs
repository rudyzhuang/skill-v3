'use strict';

const fs = require('fs');
const path = require('path');
const { formatLocalTime } = require('../../../scripts/lib/local-time.cjs');

function writeUiE2eReport(projectRoot, sessionId, results, meta) {
  const dir = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const name = sessionId ? `ui-e2e-${sessionId}.md` : `ui-e2e-${Date.now()}.md`;
  const reportPath = path.join(dir, name);
  const lines = [];
  lines.push('# UI 端到端测试报告');
  lines.push('');
  lines.push(`- **生成时间**: ${formatLocalTime(new Date())}`);
  lines.push(`- **session_id**: ${sessionId || 'n/a'}`);
  lines.push(`- **模式**: ${meta.stub ? 'stub' : 'agent'}`);
  lines.push(`- **合计**: ${meta.total} 通过 ${meta.passed} 失败 ${meta.failed}`);
  lines.push('');
  lines.push('## 场景结果');
  for (const r of results) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    lines.push(`- **${mark}** \`${r.scenario_id}\` (${r.client_target}/${r.platform}) ${r.duration_ms}ms`);
    if (r.human_log_path) lines.push(`  - 人话日志: \`${r.human_log_path}\``);
    if (!r.passed && r.error) lines.push(`  - ${r.error.replace(/\n/g, ' ')}`);
  }
  lines.push('');
  lines.push('## 人话 UI 测试日志');
  lines.push('');
  lines.push('每个场景另写 **`.agent-sessions/ui-test/<feature_id>/<datetime>.log`**，截图存同目录 **`*.jpg`**。');
  lines.push('');
  if (meta.fix_attempts) lines.push(`- **修复尝试次数**: ${meta.fix_attempts}`);
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

module.exports = { writeUiE2eReport };

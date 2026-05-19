'use strict';

/**
 * stop-pipeline.cjs — 写入 stop.signal 文件以触发流水线优雅停止
 *
 * 调用形态：
 *   node ai-std4/scripts/stop-pipeline.cjs \
 *     --project=<业务项目根绝对路径> \
 *     [--reason="<原因>"]
 *
 * 退出码：
 *   0  成功写入（或信号已存在）
 *   1  项目未初始化（stages.json 不存在）
 */

const fs   = require('fs');
const path = require('path');
const { createPipelinePaths } = require('./libs/pipeline-paths.cjs');

// ── 参数解析 ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    })
);

const projectRoot = args.project
  ? path.resolve(String(args.project))
  : process.env.AI_STD4_PROJECT
    ? path.resolve(process.env.AI_STD4_PROJECT)
    : process.cwd();

const reason = args.reason ? String(args.reason) : 'user_request';

// ── 路径常量 ──────────────────────────────────────────────────────
const paths          = createPipelinePaths(projectRoot);
const pipelineDir    = paths.pipelineDir;
const stagesJsonPath = paths.stagesJsonPath;
const stopSignalPath = paths.stopSignalPath;

// ── 校验：stages.json 必须存在 ────────────────────────────────────
if (!fs.existsSync(stagesJsonPath)) {
  process.stderr.write(
    `[stop-pipeline] 未找到已初始化的 std4 项目：${stagesJsonPath}\n`
  );
  process.exit(1);
}

// ── 检查是否已存在 stop.signal ────────────────────────────────────
if (fs.existsSync(stopSignalPath)) {
  process.stdout.write('[stop-pipeline] 流水线已在停止中（stop.signal 已存在）\n');
  process.exit(0);
}

// ── 写入 stop.signal ──────────────────────────────────────────────
function formatLocalTimeShort(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign   = offset >= 0 ? '+' : '-';
  const absOff = Math.abs(offset);
  const oh     = String(Math.floor(absOff / 60)).padStart(2, '0');
  const om     = String(absOff % 60).padStart(2, '0');
  const zone   = `${sign}${oh}${om}`;
  const y      = date.getFullYear();
  const mo     = String(date.getMonth() + 1).padStart(2, '0');
  const d      = String(date.getDate()).padStart(2, '0');
  const hr     = String(date.getHours()).padStart(2, '0');
  const min    = String(date.getMinutes()).padStart(2, '0');
  const sec    = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d} ${hr}:${min}:${sec} ${zone}`;
}

try {
  const signal = {
    requested_at: formatLocalTimeShort(),
    reason,
    requested_by: 'stop-pipeline-cmd',
  };
  fs.writeFileSync(stopSignalPath, JSON.stringify(signal, null, 2) + '\n', 'utf8');
} catch (err) {
  process.stderr.write(`[stop-pipeline] 写入 stop.signal 失败: ${err.message}\n`);
  process.exit(1);
}

process.stdout.write(
  `✓ 停止信号已写入。流水线将在当前步骤完成后停止。\n` +
  `  续跑命令：node ai-std4/scripts/run-pipeline.cjs --project=${projectRoot} --from-stage=<stopped_stage>\n`
);
process.exit(0);

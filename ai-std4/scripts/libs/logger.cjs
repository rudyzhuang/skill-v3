'use strict';

const fs = require('fs');
const path = require('path');
const { createPipelinePaths } = require('./pipeline-paths.cjs');

/**
 * 格式化本地时间（用于日志行前缀）
 * 格式：YYYY-MM-DD HH:mm:ss.SSS +HHMM
 */
function formatLocalTime(date = new Date()) {
  const offset = -date.getTimezoneOffset(); // minutes east of UTC
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const oh = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const om = String(absOffset % 60).padStart(2, '0');
  const zone = `${sign}${oh}${om}`;

  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hr = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');

  return `${y}-${mo}-${d} ${hr}:${min}:${sec}.${ms} ${zone}`;
}

/**
 * 用于 stages.json 中存储的本地时间字符串（无毫秒，更易读）
 * 格式：YYYY-MM-DD HH:mm:ss +HHMM
 */
function formatLocalTimeShort(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const oh = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const om = String(absOffset % 60).padStart(2, '0');
  const zone = `${sign}${oh}${om}`;

  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hr = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');

  return `${y}-${mo}-${d} ${hr}:${min}:${sec} ${zone}`;
}

/**
 * 从 run-id 或当前时间推导日志文件名前缀
 * run-id 格式：YYYY-MM-DD_HH-mm-ss-<8hex>
 * datetime 格式：YYYY-MM-DD_HH-mm-ss
 */
function datetimeFromRunId(runId) {
  if (runId && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.test(runId)) {
    return runId.replace(/-[0-9a-f]{8}$/, '');
  }
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hr = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}_${hr}-${min}-${sec}`;
}

/**
 * 创建 Logger 实例
 * @param {object} opts
 * @param {string} opts.projectRoot - 业务项目根路径
 * @param {string} opts.stage       - stage 名称（如 "setup"）
 * @param {string} [opts.runId]     - run_id，用于日志文件名前缀
 */
function createLogger({ projectRoot, stage, runId }) {
  const datetime = datetimeFromRunId(runId);
  const paths = createPipelinePaths(projectRoot);
  paths.ensureRuntimeDirs();
  fs.mkdirSync(path.dirname(paths.stageLogPath(stage, datetime)), { recursive: true });

  const globalLogPath = paths.globalLogPath(datetime);
  const stageLogPath  = paths.stageLogPath(stage, datetime);

  /**
   * 写一行日志
   * 格式：[本地时间] [LEVEL] [stage] event | message | {JSON}
   */
  function writeLine(level, event, message, meta = {}) {
    const ts = formatLocalTime();
    const metaStr = JSON.stringify(meta);
    const line = `[${ts}] [${level}] [${stage}] ${event} | ${message} | ${metaStr}\n`;
    try {
      fs.appendFileSync(globalLogPath, line);
    } catch (_) { /* ignore global log errors */ }
    try {
      fs.appendFileSync(stageLogPath, line);
    } catch (_) { /* ignore stage log errors */ }
    // 同时输出到 stdout
    process.stdout.write(line);
  }

  return {
    info:  (event, message, meta) => writeLine('INFO',  event, message, meta),
    warn:  (event, message, meta) => writeLine('WARN',  event, message, meta),
    error: (event, message, meta) => writeLine('ERROR', event, message, meta),
    debug: (event, message, meta) => writeLine('DEBUG', event, message, meta),
    datetime,
    globalLogPath,
    stageLogPath,
  };
}

module.exports = { createLogger, formatLocalTime, formatLocalTimeShort, datetimeFromRunId };

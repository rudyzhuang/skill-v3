'use strict';

/**
 * 本地时间：人读日志行前缀、报告「生成时间」、仪表盘展示。
 * JSON / stages.json 等机器字段仍用 ISO UTC（agent-sessions-log.isoNow）。
 */

function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** 日志行前缀：YYYY-MM-DD HH:mm:ss.SSS（系统本地时区） */
function logTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : toDate(date) || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 人读展示（zh-CN，24 小时制） */
function formatLocalTime(value) {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

const ISO_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

/** 解析日志行前缀时间戳（兼容旧 UTC ISO 与新本地格式） */
function parseLogLineTimestamp(line) {
  const s = String(line || '');
  const iso = s.match(ISO_PREFIX_RE);
  if (iso) return Date.parse(iso[1]);
  const loc = s.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\s/);
  if (!loc) return NaN;
  const parts = loc[1].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!parts) return NaN;
  const ms = parts[7] ? Number(String(parts[7]).padEnd(3, '0').slice(0, 3)) : 0;
  return new Date(+parts[1], +parts[2] - 1, +parts[3], +parts[4], +parts[5], +parts[6], ms).getTime();
}

/** 提取日志行前缀字符串（供卡住检测等） */
function matchLogLineTimestampPrefix(line) {
  const s = String(line || '');
  const iso = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/);
  if (iso) return iso[1];
  const loc = s.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/);
  if (loc) return loc[1];
  return null;
}

/** 将单行日志前缀从 UTC ISO 转为本地展示（已是本地则原样返回） */
function localizeLogLine(line) {
  const s = String(line || '');
  const m = s.match(ISO_PREFIX_RE);
  if (!m) return s;
  return `${formatLocalTime(m[1])} ${s.slice(m[0].length)}`;
}

function localizeLogLines(lines) {
  return (lines || []).map(localizeLogLine);
}

module.exports = {
  formatLocalTime,
  logTimestamp,
  parseLogLineTimestamp,
  matchLogLineTimestampPrefix,
  localizeLogLine,
  localizeLogLines,
};

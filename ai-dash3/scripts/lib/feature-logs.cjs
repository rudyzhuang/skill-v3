'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TAIL_LINES = 80;
const MAX_READ_BYTES = 256 * 1024;

function sessionsDir(projectRoot) {
  return path.join(projectRoot, '.agent-sessions');
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** 找最新的 autorun 主日志（排除文件名含 codegen 的独立会话） */
function findLatestAutorunLog(projectRoot) {
  const dir = sessionsDir(projectRoot);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log') && !f.includes('codegen'))
    .map((f) => {
      const p = path.join(dir, f);
      return { name: f, path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].path : null;
}

/**
 * 解析 autorun 主日志，返回 feature → 活跃 session（未完成/未失败）
 * @returns {Map<string, { session_id: string, autorun_log: string }>}
 */
function parseActiveSessionsByFeature(autorunLogPath) {
  const content = safeReadFile(autorunLogPath);
  const map = new Map();
  if (!content) return map;

  const spawned = {};
  const completed = new Set();
  const failed = new Set();

  for (const line of content.split('\n')) {
    let m;

    m = line.match(/spawn\s+ai-code3\s+codegen\s+.*?session=(\S+)/);
    if (m) {
      const sid = m[1];
      const fMatch = line.match(/(?:group=|--feature=)([\w-]+)/);
      spawned[sid] = { feature: fMatch ? fMatch[1] : 'unknown', spawnLine: line };
    }

    m = line.match(/\[ai-auto3\]\s+code3\s+codegen\s+group\s+\S+\s+begin\s+feature=([\w-]+)\s+session=(\S+)/);
    if (m) {
      spawned[m[2]] = { feature: m[1], spawnLine: line };
    }

    m = line.match(/ai-code3\s+codegen\s+group\s+\S+\s+done\s+feature=([\w-]+)\s+exit=(\d+)/);
    if (m) {
      for (const [sid, info] of Object.entries(spawned)) {
        if (info.feature === m[1]) {
          if (m[2] === '0') completed.add(sid);
          else failed.add(sid);
        }
      }
    }

    m = line.match(/\[ai-auto3\]\s+code3\s+codegen\s+group\s+\S+\s+end\s+feature=([\w-]+)\s+exit=(\d+)/);
    if (m) {
      for (const [sid, info] of Object.entries(spawned)) {
        if (info.feature === m[1]) {
          if (m[2] === '0') completed.add(sid);
          else failed.add(sid);
        }
      }
    }

    m = line.match(/\[ai-auto3\]\s+exec\s+end:.*?--feature=([\w-]+).*?exit=(\d+)/);
    if (m) {
      for (const [sid, info] of Object.entries(spawned)) {
        if (info.feature === m[1]) {
          if (m[2] === '0') completed.add(sid);
          else failed.add(sid);
        }
      }
    }
  }

  for (const [sid, info] of Object.entries(spawned)) {
    if (completed.has(sid) || failed.has(sid)) continue;
    const fid = String(info.feature || '').trim();
    if (!fid || fid === 'unknown') continue;
    map.set(fid, { session_id: sid, autorun_log: autorunLogPath });
  }
  return map;
}

function tailFileLines(filePath, maxLines) {
  const n = Math.max(1, maxLines || DEFAULT_TAIL_LINES);
  const content = safeReadFile(filePath);
  if (content == null) return { lines: [], truncated: false };
  const all = content.split('\n');
  const lines = all.length > n ? all.slice(-n) : all;
  return { lines, truncated: all.length > n };
}

/**
 * 在目录中找最近修改、且内容提及 feature 的 .log
 */
function findLogByFeatureMention(projectRoot, featureId) {
  const dir = sessionsDir(projectRoot);
  if (!fs.existsSync(dir)) return null;
  const fid = String(featureId || '').trim();
  if (!fid) return null;
  const re = new RegExp(`feature[=:]\\s*${fid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|--feature=${fid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => {
      const p = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {
        return null;
      }
      return { path: p, mtime };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  for (const { path: logPath } of candidates) {
    try {
      const stat = fs.statSync(logPath);
      const readLen = Math.min(stat.size, MAX_READ_BYTES);
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(readLen);
      const start = Math.max(0, stat.size - readLen);
      fs.readSync(fd, buf, 0, readLen, start);
      fs.closeSync(fd);
      if (re.test(buf.toString('utf8'))) return logPath;
    } catch {
      /* next */
    }
  }
  return null;
}

function resolveSessionLogPath(projectRoot, sessionId) {
  if (!sessionId) return null;
  const p = path.join(sessionsDir(projectRoot), `${sessionId}.log`);
  return fs.existsSync(p) ? p : null;
}

/**
 * @param {string} projectRoot
 * @param {string} featureId
 * @param {{ autorunLog?: string|null, activeSessions?: Map }} [ctx]
 */
function resolveFeatureLog(projectRoot, featureId, ctx) {
  const fid = String(featureId || '').trim();
  if (!fid) {
    return {
      feature_id: fid,
      log_path: null,
      session_id: null,
      source: 'none',
      lines: [],
      truncated: false,
    };
  }

  const autorunLog = ctx?.autorunLog ?? findLatestAutorunLog(projectRoot);
  const active =
    ctx?.activeSessions ??
    (autorunLog ? parseActiveSessionsByFeature(autorunLog) : new Map());

  const activeEntry = active.get(fid);
  if (activeEntry?.session_id) {
    const sessionPath = resolveSessionLogPath(projectRoot, activeEntry.session_id);
    if (sessionPath) {
      const { lines, truncated } = tailFileLines(sessionPath, DEFAULT_TAIL_LINES);
      return {
        feature_id: fid,
        log_path: path.relative(projectRoot, sessionPath),
        session_id: activeEntry.session_id,
        source: 'session',
        lines,
        truncated,
      };
    }
  }

  const mentionPath = findLogByFeatureMention(projectRoot, fid);
  if (mentionPath) {
    const { lines, truncated } = tailFileLines(mentionPath, DEFAULT_TAIL_LINES);
    return {
      feature_id: fid,
      log_path: path.relative(projectRoot, mentionPath),
      session_id: path.basename(mentionPath, '.log'),
      source: 'mention',
      lines,
      truncated,
    };
  }

  if (autorunLog && fs.existsSync(autorunLog)) {
    const { lines: allLines } = tailFileLines(autorunLog, DEFAULT_TAIL_LINES * 3);
    const fidRe = new RegExp(fid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const filtered = allLines.filter((ln) => fidRe.test(ln));
    if (filtered.length) {
      const tail = filtered.slice(-DEFAULT_TAIL_LINES);
      return {
        feature_id: fid,
        log_path: path.relative(projectRoot, autorunLog),
        session_id: null,
        source: 'autorun_filter',
        lines: tail,
        truncated: filtered.length > DEFAULT_TAIL_LINES,
      };
    }
  }

  return {
    feature_id: fid,
    log_path: null,
    session_id: null,
    source: 'none',
    lines: [],
    truncated: false,
  };
}

/**
 * @param {string} projectRoot
 * @param {object[]} features from buildFeatureBoard
 */
function buildInProgressFeatureLogs(projectRoot, features) {
  const inProgress = (features || []).filter(
    (f) => (f.feature_status || f.pipeline_status) === 'in_progress'
  );
  if (!inProgress.length) return [];

  const autorunLog = findLatestAutorunLog(projectRoot);
  const activeSessions = autorunLog ? parseActiveSessionsByFeature(autorunLog) : new Map();
  const ctx = { autorunLog, activeSessions };

  return inProgress.map((f) => {
    const log = resolveFeatureLog(projectRoot, f.feature_id, ctx);
    return {
      ...log,
      current_stage_label: f.current_stage_label || f.pipeline_stage_label || null,
    };
  });
}

module.exports = {
  findLatestAutorunLog,
  parseActiveSessionsByFeature,
  resolveFeatureLog,
  buildInProgressFeatureLogs,
  tailFileLines,
  DEFAULT_TAIL_LINES,
};

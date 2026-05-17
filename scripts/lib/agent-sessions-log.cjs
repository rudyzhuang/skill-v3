'use strict';

const fs = require('fs');
const path = require('path');
const { logTimestamp } = require('./local-time.cjs');

/** 与 stages.json.template / feature-stages.cjs 对齐 */
const STAGE_KEYS = [
  'prd',
  'prd_review',
  'design',
  'contract',
  'design_review',
  'codegen',
  'typecheck',
  'test',
  'code_review',
  'merge_push',
  'build',
  'deploy',
  'smoke',
  'ui_e2e',
  'report',
];

function isoNow() {
  return new Date().toISOString();
}

function safeFileSegment(id, maxLen = 120) {
  const s = String(id || '').trim();
  if (!s) return '';
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, maxLen);
}

function normalizeStageKey(stage) {
  const s = String(stage || '').trim();
  if (!s) return '';
  return s.replace(/-/g, '_');
}

function agentSessionsRoot(projectRoot) {
  return path.join(projectRoot, '.agent-sessions');
}

function logsRoot(projectRoot) {
  return path.join(agentSessionsRoot(projectRoot), 'logs');
}

function sessionLogPath(projectRoot, sessionId) {
  const sid = safeFileSegment(sessionId) || 'default';
  return path.join(logsRoot(projectRoot), 'sessions', `${sid}.log`);
}

function featureLogPath(projectRoot, featureId) {
  const fid = safeFileSegment(featureId);
  if (!fid) return null;
  return path.join(logsRoot(projectRoot), 'features', `${fid}.log`);
}

function stageLogPath(projectRoot, stageKey) {
  const sk = normalizeStageKey(stageKey);
  if (!sk) return null;
  return path.join(logsRoot(projectRoot), 'stages', `${sk}.log`);
}

/** 旧版根目录会话日志（只读兼容） */
function legacySessionLogPath(projectRoot, sessionId) {
  const sid = safeFileSegment(sessionId) || 'default';
  return path.join(agentSessionsRoot(projectRoot), `${sid}.log`);
}

function resolveSessionLogPath(projectRoot, sessionId) {
  const modern = sessionLogPath(projectRoot, sessionId);
  if (fs.existsSync(modern)) return modern;
  const legacy = legacySessionLogPath(projectRoot, sessionId);
  if (fs.existsSync(legacy)) return legacy;
  return modern;
}

function resolveFeatureLogPath(projectRoot, featureId) {
  const modern = featureLogPath(projectRoot, featureId);
  if (modern && fs.existsSync(modern)) return modern;
  return modern;
}

function resolveStageLogPath(projectRoot, stageKey) {
  return stageLogPath(projectRoot, stageKey);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendFileLine(filePath, line) {
  if (!filePath) return;
  try {
    ensureParent(filePath);
    fs.appendFileSync(filePath, line, 'utf8');
  } catch {
    /* 日志失败不阻断主流程 */
  }
}

/**
 * @param {object} input
 * @returns {string[]}
 */
function resolveFeatureIds(input) {
  const out = [];
  const seen = new Set();
  function add(v) {
    const id = String(v || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  }
  if (!input) return out;
  if (Array.isArray(input.featureIds)) {
    for (const x of input.featureIds) add(x);
  }
  const single = input.featureId || input.feature_id;
  if (single) {
    for (const part of String(single).split(/[,\s]+/)) add(part);
  }
  const detail = input.detail != null ? String(input.detail) : '';
  if (detail && !input.featureIds?.length && !single) {
    const t = detail.trim();
    if (/^[\w.-]+(\s*,\s*[\w.-]+)*$/.test(t)) {
      for (const part of t.split(',')) add(part.trim());
    }
  }
  if (!out.length && input.message) {
    const m = String(input.message).match(/features=([^\s|]+)/i);
    if (m) {
      for (const part of m[1].split(',')) add(part.trim());
    }
  }
  return out;
}

/**
 * 统一追加：sessions / stages / features 三路日志。
 * @param {string} projectRoot
 * @param {object} rec
 */
function appendAgentLog(projectRoot, rec = {}) {
  const ts = logTimestamp();
  const stage = normalizeStageKey(rec.stageKey || rec.stage || '');
  const skill = rec.skill || 'pipeline';
  const level = rec.level || 'info';
  const sessionId = rec.sessionId || rec.session_id || '';
  const featureIds = resolveFeatureIds(rec);

  const body =
    rec.line != null && String(rec.line) !== ''
      ? String(rec.line)
      : (() => {
          const fid = rec.featureId || rec.feature_id || '';
          const head = `[${skill}] 阶段=${stage}${fid ? ` feature=${fid}` : ''}`;
          return `${head} | ${level.toUpperCase()} | ${String(rec.message || '').trim()}${
            rec.detail ? ` | ${rec.detail}` : ''
          }`;
        })();

  const line = rec.prefixTs === false ? `${body}\n` : `${ts} ${body}\n`;

  const sid = safeFileSegment(sessionId);
  if (sid) {
    appendFileLine(sessionLogPath(projectRoot, sid), line);
  }
  if (stage) {
    appendFileLine(stageLogPath(projectRoot, stage), line);
  }
  for (const fid of featureIds) {
    appendFileLine(featureLogPath(projectRoot, fid), line);
  }

  return { ts, line: body.trim(), featureIds, stage, sessionId: sid };
}

function appendSessionLine(projectRoot, sessionId, line, opts = {}) {
  return appendAgentLog(projectRoot, {
    sessionId,
    line,
    stageKey: opts.stageKey,
    featureIds: opts.featureIds,
    featureId: opts.featureId,
    skill: opts.skill,
    prefixTs: opts.prefixTs !== false,
  });
}

function appendHeartbeat(projectRoot, sessionId, stageKey, intervalLabel, opts = {}) {
  const label = intervalLabel || '';
  const sk = normalizeStageKey(stageKey);
  const msg = `alive: stage=${sk} ${label}`.trim();
  appendAgentLog(projectRoot, {
    sessionId,
    stageKey: sk,
    line: msg,
    featureIds: opts.featureIds,
    skill: opts.skill || 'pipeline',
  });
  if (process.env.AI_AUTO3_LOG_HEARTBEAT === '0') return;
  const tag = opts.stderrTag || 'heartbeat';
  console.error(`[${tag}] session=${sessionId || 'default'} ${msg}`);
}

/**
 * @param {string} projectRoot
 * @param {(name: string) => boolean} [predicate]
 */
function findLatestSessionLog(projectRoot, predicate) {
  const files = [];
  const dirs = [path.join(logsRoot(projectRoot), 'sessions'), agentSessionsRoot(projectRoot)];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      if (!f.endsWith('.log')) continue;
      if (predicate && !predicate(f)) continue;
      const p = path.join(dir, f);
      try {
        files.push({ path: p, mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* next */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].path : null;
}

module.exports = {
  STAGE_KEYS,
  agentSessionsRoot,
  logsRoot,
  sessionLogPath,
  featureLogPath,
  stageLogPath,
  legacySessionLogPath,
  resolveSessionLogPath,
  resolveFeatureLogPath,
  resolveStageLogPath,
  resolveFeatureIds,
  appendAgentLog,
  appendSessionLine,
  appendHeartbeat,
  findLatestSessionLog,
  safeFileSegment,
  normalizeStageKey,
  isoNow,
};

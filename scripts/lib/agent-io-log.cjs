'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const agentLog = require('./agent-sessions-log.cjs');

const DEFAULT_MAX_IO = 6000;

function sha256Short(text) {
  if (text == null || String(text) === '') return '';
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

function truncate(text, max = DEFAULT_MAX_IO) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/**
 * 提示词来源引用（避免在日志中重复贴全文）。
 * @returns {string} 如 @skill/ai-code3/scripts/lib/invoke-ai-code3-agent.cjs#buildCursorAgentPrompt
 */
function promptRef({ skill, relPath, symbol }) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const sym = symbol ? `#${String(symbol)}` : '';
  return `@skill/${skill}/${p}${sym}`;
}

function resolveSessionId(opts = {}) {
  return String(opts.sessionId || opts.session_id || process.env.AI_SESSION_ID || '').trim();
}

function relProjectPath(projectRoot, absPath) {
  if (!absPath) return '';
  try {
    const rel = path.relative(projectRoot, absPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  } catch {
    /* ignore */
  }
  return String(absPath);
}

function summarizeJsonFile(filePath, maxKeys = 10) {
  if (!filePath || !fs.existsSync(filePath)) return { path: filePath, missing: true };
  try {
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const keys = Object.keys(j);
    const excerpt = {};
    for (const k of keys.slice(0, maxKeys)) {
      const v = j[k];
      if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        excerpt[k] = v;
      } else if (Array.isArray(v)) {
        excerpt[k] = `[array len=${v.length}]`;
      } else {
        excerpt[k] = `[object keys=${Object.keys(v).length}]`;
      }
    }
    return { path: filePath, key_count: keys.length, excerpt };
  } catch (e) {
    return { path: filePath, parse_error: e.message };
  }
}

function appendIoBlock(projectRoot, rec, blockLabel, text, maxIo) {
  const body = truncate(text, maxIo);
  if (!body.trim()) return;
  const header = `${rec.line || ''} | ${blockLabel}`;
  agentLog.appendAgentLog(projectRoot, { ...rec, line: header, prefixTs: true });
  for (const ln of body.split('\n')) {
    agentLog.appendAgentLog(projectRoot, { ...rec, line: `  | ${ln}`, prefixTs: false });
  }
}

/**
 * 记录外部 Agent 调用起止与 I/O（提示词用 prompt_ref + prompt_sha，不全文重复）。
 * @param {string} projectRoot
 * @param {'begin'|'end'|'skip'} event
 * @param {object} opts
 */
function logAgentIo(projectRoot, event, opts = {}) {
  if (!projectRoot) return { callId: opts.callId || '' };
  const callId =
    opts.callId ||
    opts.call_id ||
    sha256Short(`${event}:${Date.now()}:${Math.random()}`) ||
    'unknown';
  const sessionId = resolveSessionId(opts);
  const stageKey = agentLog.normalizeStageKey(opts.stageKey || opts.stage || '');
  const skill = opts.skill || 'pipeline';
  const maxIo = opts.maxIo || DEFAULT_MAX_IO;

  const head = [
    `agent_io.${event}`,
    `call_id=${callId}`,
    opts.phase ? `phase=${opts.phase}` : '',
    opts.agentBin ? `bin=${path.basename(String(opts.agentBin))}` : '',
    opts.promptRef ? `prompt_ref=${opts.promptRef}` : '',
    opts.promptSha ? `prompt_sha=${opts.promptSha}` : '',
    opts.inputPath ? `input=${relProjectPath(projectRoot, opts.inputPath)}` : '',
    opts.outputPath ? `output=${relProjectPath(projectRoot, opts.outputPath)}` : '',
    opts.argvSummary ? `argv=${opts.argvSummary}` : '',
    event === 'end' && opts.elapsedMs != null ? `elapsed_ms=${opts.elapsedMs}` : '',
    event === 'end' && opts.exitCode != null ? `exit=${opts.exitCode}` : '',
    event === 'end' && opts.ok != null ? `ok=${opts.ok ? 1 : 0}` : '',
    opts.reason ? `reason=${opts.reason}` : '',
    event === 'skip' ? 'skipped=1' : '',
  ]
    .filter(Boolean)
    .join(' | ');

  const rec = {
    sessionId,
    stageKey,
    skill,
    featureId: opts.featureId || opts.feature_id,
    featureIds: opts.featureIds || opts.feature_ids,
    line: `[${skill}] ${head}`,
  };

  try {
    agentLog.appendAgentLog(projectRoot, rec);
    if (event === 'begin' && opts.inputSummary) {
      appendIoBlock(projectRoot, rec, 'input_summary', JSON.stringify(opts.inputSummary, null, 2), maxIo);
    }
    if (opts.promptDynamic) {
      appendIoBlock(projectRoot, rec, 'prompt_dynamic', opts.promptDynamic, Math.min(maxIo, 2000));
    }
    if (event === 'end') {
      if (opts.stdout) appendIoBlock(projectRoot, rec, 'stdout', opts.stdout, maxIo);
      if (opts.stderr) appendIoBlock(projectRoot, rec, 'stderr', opts.stderr, maxIo);
      if (opts.outputSummary) {
        appendIoBlock(
          projectRoot,
          rec,
          'output_summary',
          JSON.stringify(opts.outputSummary, null, 2),
          maxIo
        );
      }
    }
  } catch {
    /* 日志失败不阻断 */
  }

  return { callId, promptSha: opts.promptSha || '' };
}

/**
 * Agent 产出 JSON 落盘时（脚本侧接收），记录输入文件摘要 + prompt_ref。
 */
function logAgentArtifactIn(projectRoot, opts = {}) {
  const summary = opts.jsonPath ? summarizeJsonFile(opts.jsonPath) : opts.inputSummary;
  return logAgentIo(projectRoot, 'end', {
    ...opts,
    inputPath: opts.jsonPath || opts.inputPath,
    inputSummary: summary,
    ok: opts.ok !== false,
    exitCode: opts.exitCode ?? 0,
    stdout: opts.stdout,
    stderr: opts.stderr,
  });
}

module.exports = {
  DEFAULT_MAX_IO,
  sha256Short,
  truncate,
  promptRef,
  resolveSessionId,
  relProjectPath,
  summarizeJsonFile,
  logAgentIo,
  logAgentArtifactIn,
};

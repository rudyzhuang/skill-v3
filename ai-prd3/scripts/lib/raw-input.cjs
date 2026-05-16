'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_SLUGS = new Set([
  'website',
  'admin',
  'backend',
  'miniapp',
  'mobile',
  'desktop',
  'agent',
]);

/** 相对项目根；内联原始需求持久化路径（可复现、可哈希） */
const RAW_INPUT_SNAPSHOT_REL = '.pipeline/cache/raw-input.snapshot.md';

function snapshotAbs(projectRoot) {
  return path.join(projectRoot, RAW_INPUT_SNAPSHOT_REL);
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sha256File(absPath) {
  return sha256Text(fs.readFileSync(absPath, 'utf8'));
}

function readStdinUtf8() {
  if (process.stdin.isTTY) return null;
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} value CLI --raw-input-text= 的值；以 @ 开头则读取路径（相对 cwd 或绝对）
 */
function decodeRawInputTextArg(value, cwd) {
  const v = String(value ?? '');
  if (v.startsWith('@')) {
    const p = v.slice(1).trim();
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
    if (!fs.existsSync(abs)) {
      throw new Error(`raw_input_text_file_not_found:${abs}`);
    }
    return fs.readFileSync(abs, 'utf8');
  }
  return v;
}

/**
 * 解析磁盘上的需求文件路径（不含内联文本）。
 */
function resolveRawInputFilePath(projectRoot, stages, opts = {}) {
  const candidates = [];
  if (opts.rawInputOverride) candidates.push(opts.rawInputOverride);
  if (process.env.AI_PRD3_RAW_INPUT) candidates.push(process.env.AI_PRD3_RAW_INPUT);
  if (stages?.pipeline?.raw_input?.source === 'file' && stages.pipeline.raw_input.path) {
    candidates.push(stages.pipeline.raw_input.path);
  }
  if (stages?.pipeline?.raw_input?.path && stages?.pipeline?.raw_input?.source !== 'inline') {
    candidates.push(stages.pipeline.raw_input.path);
  }
  if (stages?.prd?.inputs?.raw_input?.primary_path) {
    candidates.push(stages.prd.inputs.raw_input.primary_path);
  }
  const refs = stages?.stages?.prd?.inputs?.raw_input_refs;
  if (Array.isArray(refs) && refs[0] && !String(refs[0]).includes('raw-input.snapshot')) {
    candidates.push(refs[0]);
  }
  candidates.push('inputs/req.md');

  for (const rel of candidates) {
    if (!rel || typeof rel !== 'string') continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return { abs, rel: path.isAbsolute(rel) ? path.relative(projectRoot, abs) : rel };
    }
  }
  return { abs: null, rel: candidates[candidates.length - 1] || 'inputs/req.md' };
}

function persistInlineSnapshot(projectRoot, text) {
  const abs = snapshotAbs(projectRoot);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return { abs, rel: RAW_INPUT_SNAPSHOT_REL };
}

/**
 * 加载原始需求正文。来源优先级（高→低）：
 * 1. CLI --raw-input-text= / --raw-input-text（下一参数）
 * 2. 环境变量 AI_PRD3_RAW_INPUT_TEXT
 * 3. CLI --stdin（或 detect/apply 在显式传参时读 stdin）
 * 4. 已缓存的内联快照 stages.pipeline.raw_input.source=inline
 * 5. 需求文件（--raw-input= / AI_PRD3_RAW_INPUT / inputs/req.md 等）
 *
 * @returns {{ ok: boolean, source?: 'inline'|'file', path?: string, abs_path?: string, text?: string, content_hash?: string, error?: string, message?: string }}
 */
function loadRawInputContent(projectRoot, stages, opts = {}) {
  stages = stages || readStages(projectRoot) || {};

  let inlineText = null;
  let inlineOrigin = null;

  if (opts.rawInputText !== undefined && opts.rawInputText !== null) {
    try {
      inlineText = decodeRawInputTextArg(opts.rawInputText, projectRoot);
      inlineOrigin = 'cli';
    } catch (e) {
      return { ok: false, error: 'raw_input_text_decode_failed', message: String(e.message || e) };
    }
  } else if (process.env.AI_PRD3_RAW_INPUT_TEXT) {
    inlineText = process.env.AI_PRD3_RAW_INPUT_TEXT;
    inlineOrigin = 'env';
  } else if (opts.rawInputStdin) {
    inlineText = readStdinUtf8();
    inlineOrigin = 'stdin';
    if (inlineText === null || inlineText === '') {
      return { ok: false, error: 'raw_input_stdin_empty', message: 'stdin 无内容或未管道传入' };
    }
  } else if (stages.pipeline?.raw_input?.source === 'inline') {
    const snap = snapshotAbs(projectRoot);
    if (fs.existsSync(snap)) {
      inlineText = fs.readFileSync(snap, 'utf8');
      inlineOrigin = 'cache';
    }
  }

  if (inlineText !== null) {
    const trimmed = String(inlineText).trim();
    if (!trimmed) {
      return { ok: false, error: 'raw_input_inline_empty', message: '内联原始需求为空' };
    }
    const snap = persistInlineSnapshot(projectRoot, inlineText);
    return {
      ok: true,
      source: 'inline',
      path: snap.rel,
      abs_path: snap.abs,
      text: inlineText,
      content_hash: sha256Text(inlineText),
      inline_origin: inlineOrigin,
    };
  }

  const file = resolveRawInputFilePath(projectRoot, stages, opts);
  if (!file.abs) {
    return {
      ok: false,
      error: 'raw_input_missing',
      path: file.rel,
      message:
        '未找到原始需求：无内联输入（--raw-input-text / AI_PRD3_RAW_INPUT_TEXT / --stdin / 缓存快照），且无可用文件（inputs/req.md 等）',
    };
  }
  const text = fs.readFileSync(file.abs, 'utf8');
  return {
    ok: true,
    source: 'file',
    path: file.rel,
    abs_path: file.abs,
    text,
    content_hash: sha256Text(text),
    inline_origin: null,
  };
}

function readStages(projectRoot) {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeStages(projectRoot, stages) {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(stages, null, 2)}\n`, 'utf8');
}

function writeRawInputCache(projectRoot, stages, loaded) {
  stages.stages = stages.stages || {};
  stages.stages.prd = stages.stages.prd || {};
  stages.stages.prd.inputs = stages.stages.prd.inputs || {};
  stages.stages.prd.inputs.raw_input_path = loaded.path;
  stages.stages.prd.inputs.raw_input_hash = loaded.content_hash;
  stages.stages.prd.inputs.raw_input_source = loaded.source;
  stages.stages.prd.inputs.raw_input_refs = [loaded.path];
  stages.pipeline = stages.pipeline || {};
  stages.pipeline.raw_input = {
    source: loaded.source,
    path: loaded.path,
    snapshot_path: loaded.source === 'inline' ? RAW_INPUT_SNAPSHOT_REL : null,
    content_hash: loaded.content_hash,
    updated_at: new Date().toISOString(),
  };
  writeStages(projectRoot, stages);
}

/**
 * @param {string} projectRoot
 * @param {{ rawInputOverride?: string, rawInputText?: string, rawInputStdin?: boolean, updateCache?: boolean }} [opts]
 */
function detectRawInputDrift(projectRoot, opts = {}) {
  const stages = readStages(projectRoot) || {};
  const loaded = loadRawInputContent(projectRoot, stages, opts);
  if (!loaded.ok) return loaded;

  const prdInputs = stages.stages?.prd?.inputs || {};
  const cachedHash = prdInputs.raw_input_hash || '';
  const cachedPath = prdInputs.raw_input_path || '';
  const cachedSource = prdInputs.raw_input_source || stages.pipeline?.raw_input?.source || '';
  const changed =
    !cachedHash ||
    cachedHash !== loaded.content_hash ||
    (cachedPath && cachedPath !== loaded.path) ||
    (cachedSource && cachedSource !== loaded.source);

  const result = {
    ok: true,
    source: loaded.source,
    path: loaded.path,
    abs_path: loaded.abs_path,
    content_hash: loaded.content_hash,
    cached_hash: cachedHash || null,
    cached_path: cachedPath || null,
    cached_source: cachedSource || null,
    changed,
    first_seen: !cachedHash,
    inline_origin: loaded.inline_origin || null,
  };

  if (opts.updateCache) {
    writeRawInputCache(projectRoot, stages, loaded);
    result.cache_updated = true;
  }

  return result;
}

module.exports = {
  ALLOWED_SLUGS,
  RAW_INPUT_SNAPSHOT_REL,
  snapshotAbs,
  resolveRawInputFilePath,
  loadRawInputContent,
  sha256Text,
  sha256File,
  decodeRawInputTextArg,
  persistInlineSnapshot,
  readStages,
  writeStages,
  writeRawInputCache,
  detectRawInputDrift,
};

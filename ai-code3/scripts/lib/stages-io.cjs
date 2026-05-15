'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_MAX_SUPPORTED = 1;

function stagesPath(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'stages.json');
}

function readStagesSync(projectRoot) {
  const p = stagesPath(projectRoot);
  if (!fs.existsSync(p)) {
    const err = new Error(`missing_stages_json: ${p}`);
    err.code = 'ENOENT_STAGES';
    throw err;
  }
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function assertSchemaSupported(doc) {
  const v = doc?._schema?.version;
  if (typeof v !== 'number' || v > SCHEMA_MAX_SUPPORTED) {
    const err = new Error(`unsupported_stages_schema: got ${v}, max ${SCHEMA_MAX_SUPPORTED}`);
    err.code = 'SCHEMA_VERSION';
    throw err;
  }
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const data = `${JSON.stringify(obj, null, 2)}\n`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeStagesSync(projectRoot, doc) {
  atomicWriteJson(stagesPath(projectRoot), doc);
}

function deepMerge(target, patch) {
  if (patch === null || patch === undefined) return target;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return { ...patch };
  const out = { ...target };
  for (const k of Object.keys(patch)) {
    out[k] = deepMerge(target[k], patch[k]);
  }
  return out;
}

function updateStage(doc, stageKey, partialStage) {
  if (!doc.stages) doc.stages = {};
  doc.stages[stageKey] = deepMerge(doc.stages[stageKey] || {}, partialStage);
  return doc;
}

function lockPath(projectRoot, scope) {
  return path.join(projectRoot, '.agent-sessions', 'locks', `${scope}.pid`);
}

/**
 * @returns {{ release: () => void, ok: boolean }}
 */
function tryAcquireLock(projectRoot, scope, meta) {
  const lp = lockPath(projectRoot, scope);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  if (fs.existsSync(lp)) {
    let stale = false;
    try {
      const line = fs.readFileSync(lp, 'utf8').trim();
      const j = JSON.parse(line);
      const pid = j.pid;
      if (typeof pid === 'number') {
        try {
          process.kill(pid, 0);
        } catch {
          stale = true;
        }
      }
    } catch {
      stale = true;
    }
    if (!stale) return { ok: false, release() {} };
    try {
      fs.unlinkSync(lp);
    } catch {}
  }
  const payload = JSON.stringify({
    pid: process.pid,
    session_id: meta.sessionId || '',
    started_at: new Date().toISOString(),
    skill: 'ai-code3',
    scope,
  });
  fs.writeFileSync(lp, `${payload}\n`, 'utf8');
  return {
    ok: true,
    release() {
      try {
        if (fs.existsSync(lp)) fs.unlinkSync(lp);
      } catch {}
    },
  };
}

module.exports = {
  stagesPath,
  readStagesSync,
  writeStagesSync,
  assertSchemaSupported,
  updateStage,
  deepMerge,
  tryAcquireLock,
  lockPath,
  SCHEMA_MAX_SUPPORTED,
};

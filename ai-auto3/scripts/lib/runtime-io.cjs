'use strict';

const fs = require('fs');
const path = require('path');
const { skillsRootFromThisFile } = require('./paths.cjs');

const MAX_PROCESSES = 32;
const MAX_RECENT_RUNS = 20;

function sanitizeProjectId(projectId) {
  const s = String(projectId || '').trim();
  if (!s) return '';
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function skillsPipelineRoot() {
  return path.join(skillsRootFromThisFile(), '.pipeline');
}

function runtimeDirForProjectId(projectId) {
  const id = sanitizeProjectId(projectId);
  if (!id) throw new Error('runtime-io: empty project_id');
  return path.join(skillsPipelineRoot(), id);
}

function runtimePathForProjectId(projectId) {
  return path.join(runtimeDirForProjectId(projectId), 'runtime.json');
}

function templatePath() {
  return path.join(skillsRootFromThisFile(), 'docs', 'templates', 'runtime.json');
}

function defaultRuntimeDoc() {
  try {
    const raw = fs.readFileSync(templatePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      _schema: { name: 'skill-v3-runtime', version: 1 },
      project: { project_id: '', root_path: '', display_name: '' },
      updated_at: null,
      updated_by: null,
      orchestration: {
        active: false,
        active_run_id: null,
        session_id: null,
        orchestrator: null,
        current_phase: null,
        current_stage: null,
        pending_features: [],
        started_at: null,
        pid_lock: { present: false, pid: null, alive: null, lock_path: '.agent-sessions/locks/pipeline.pid' },
      },
      processes: [],
      recent_runs: [],
      services: { dash_serve: null },
    };
  }
}

function readRuntimeFile(projectId) {
  const fp = runtimePathForProjectId(projectId);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function writeRuntimeFile(projectId, doc) {
  const dir = runtimeDirForProjectId(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const fp = runtimePathForProjectId(projectId);
  const tmp = `${fp}.tmp`;
  doc.updated_at = doc.updated_at || new Date().toISOString();
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

function parsePendingFromPatch(patch) {
  if (patch.pending_features !== undefined) {
    return Array.isArray(patch.pending_features) ? patch.pending_features.map(String) : [];
  }
  if (patch.pending_features_json !== undefined) {
    try {
      const arr = JSON.parse(String(patch.pending_features_json || '[]'));
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }
  return undefined;
}

/**
 * Legacy row shape for ai-dash3 features.cjs
 */
function runtimeRowFromDoc(doc) {
  if (!doc?.orchestration) return null;
  const o = doc.orchestration;
  return {
    project_id: doc.project?.project_id || '',
    active_run_id: o.active_run_id || null,
    current_phase: o.current_phase || null,
    current_stage: o.current_stage || null,
    pending_features_json: JSON.stringify(o.pending_features || []),
    pending_features: o.pending_features || [],
    updated_at: doc.updated_at || null,
    active: o.active === true,
    orchestrator: o.orchestrator || null,
  };
}

function ensureProjectFromStages(projectRoot, stagesDoc, updatedBy) {
  const projectId = stagesDoc?.project?.project_id;
  if (!projectId || !String(projectId).trim()) {
    const e = new Error('runtime-io: stages.json.project.project_id 为空');
    e.code = 'NO_PROJECT_ID';
    throw e;
  }
  const id = String(projectId).trim();
  let doc = readRuntimeFile(id) || defaultRuntimeDoc();
  doc.project = {
    project_id: id,
    root_path: projectRoot,
    display_name: stagesDoc.project?.name || stagesDoc.project?.display_name || doc.project?.display_name || '',
  };
  doc.updated_by = updatedBy || doc.updated_by || 'ai-auto3';
  writeRuntimeFile(id, doc);
  return { projectId: id, doc };
}

function updateProjectRuntimeState(projectId, patch, updatedBy) {
  const id = String(projectId || '').trim();
  if (!id) return;
  let doc = readRuntimeFile(id) || defaultRuntimeDoc();
  if (!doc.project?.project_id) {
    doc.project = { project_id: id, root_path: '', display_name: '' };
  }
  const o = doc.orchestration || defaultRuntimeDoc().orchestration;
  const pending = parsePendingFromPatch(patch);
  doc.orchestration = {
    ...o,
    active: patch.active !== undefined ? !!patch.active : o.active,
    active_run_id: patch.active_run_id !== undefined ? patch.active_run_id : o.active_run_id,
    session_id: patch.session_id !== undefined ? patch.session_id : o.session_id,
    orchestrator: patch.orchestrator !== undefined ? patch.orchestrator : o.orchestrator,
    current_phase: patch.current_phase !== undefined ? patch.current_phase : o.current_phase,
    current_stage: patch.current_stage !== undefined ? patch.current_stage : o.current_stage,
    pending_features: pending !== undefined ? pending : o.pending_features || [],
    started_at: patch.started_at !== undefined ? patch.started_at : o.started_at,
    pid_lock: patch.pid_lock !== undefined ? patch.pid_lock : o.pid_lock,
  };
  if (patch.active_run_id) doc.orchestration.active = true;
  doc.updated_by = updatedBy || 'ai-auto3';
  writeRuntimeFile(id, doc);
}

function clearProjectRuntimeState(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return;
  const doc = readRuntimeFile(id);
  if (!doc) return;
  doc.orchestration = {
    ...(doc.orchestration || {}),
    active: false,
    active_run_id: null,
    session_id: null,
    current_phase: null,
    current_stage: null,
    pending_features: [],
  };
  doc.updated_by = 'ai-auto3';
  writeRuntimeFile(id, doc);
}

function startRun(projectId, sessionId, orchestrator) {
  const id = String(projectId || '').trim();
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  let doc = readRuntimeFile(id) || defaultRuntimeDoc();
  if (!doc.project?.project_id) {
    doc.project = { project_id: id, root_path: '', display_name: '' };
  }
  doc.recent_runs = doc.recent_runs || [];
  doc.recent_runs.unshift({
    run_id: runId,
    orchestrator: orchestrator || 'ai-auto3',
    session_id: sessionId || '',
    started_at: now,
    ended_at: null,
    exit_code: null,
    stopped_at_stage: null,
  });
  doc.recent_runs = doc.recent_runs.slice(0, MAX_RECENT_RUNS);
  doc.orchestration = {
    ...(doc.orchestration || defaultRuntimeDoc().orchestration),
    active: true,
    active_run_id: runId,
    session_id: sessionId || '',
    orchestrator: orchestrator || 'ai-auto3',
    started_at: now,
  };
  doc.updated_by = orchestrator || 'ai-auto3';
  writeRuntimeFile(id, doc);
  return runId;
}

function finishRun(runId, exitCode, stoppedAt) {
  const root = skillsPipelineRoot();
  if (!fs.existsSync(root)) return;
  const now = new Date().toISOString();
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const fp = path.join(root, ent.name, 'runtime.json');
    if (!fs.existsSync(fp)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      continue;
    }
    const runs = doc.recent_runs || [];
    const idx = runs.findIndex((r) => r.run_id === runId);
    if (idx < 0) continue;
    runs[idx] = {
      ...runs[idx],
      ended_at: now,
      exit_code: exitCode,
      stopped_at_stage: stoppedAt || '',
    };
    doc.recent_runs = runs;
    if (doc.orchestration?.active_run_id === runId) {
      doc.orchestration.active = false;
    }
    doc.updated_by = 'ai-auto3';
    writeRuntimeFile(doc.project?.project_id || ent.name, doc);
    return;
  }
}

function registerProcess(projectId, entry) {
  const id = String(projectId || '').trim();
  if (!id) return;
  let doc = readRuntimeFile(id) || defaultRuntimeDoc();
  const proc = {
    id: entry.id || `proc-${entry.pid || Date.now()}`,
    kind: entry.kind || 'unknown',
    pid: entry.pid || null,
    command: String(entry.command || '').slice(0, 512),
    started_at: entry.started_at || new Date().toISOString(),
    ended_at: null,
    cwd: entry.cwd || '',
    log_path: entry.log_path || '',
    status: 'running',
    exit_code: null,
  };
  doc.processes = [proc, ...(doc.processes || []).filter((p) => p.pid !== proc.pid)].slice(0, MAX_PROCESSES);
  doc.updated_by = entry.updated_by || 'ai-auto3';
  writeRuntimeFile(id, doc);
}

function markProcessExited(projectId, pid, exitCode) {
  const id = String(projectId || '').trim();
  const doc = readRuntimeFile(id);
  if (!doc) return;
  const p = Number(pid);
  doc.processes = (doc.processes || []).map((proc) => {
    if (proc.pid === p && proc.status === 'running') {
      return {
        ...proc,
        status: 'exited',
        exit_code: exitCode,
        ended_at: new Date().toISOString(),
      };
    }
    return proc;
  });
  doc.updated_by = 'ai-auto3';
  writeRuntimeFile(id, doc);
}

function listProjectsFromRuntime() {
  const root = skillsPipelineRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const fp = path.join(root, ent.name, 'runtime.json');
    if (!fs.existsSync(fp)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      continue;
    }
    const pid = doc.project?.project_id || ent.name;
    out.push({
      project_id: pid,
      root_path: doc.project?.root_path || '',
      last_seen_at: doc.updated_at || null,
      stages_schema_version: null,
      orchestration: doc.orchestration || {},
      runtime_doc: doc,
    });
  }
  out.sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')));
  return out;
}

function buildRegistryExportShape() {
  const projects = [];
  const runtime_states = [];
  const recent_runs = [];
  const active_runs = [];
  for (const row of listProjectsFromRuntime()) {
    projects.push({
      project_id: row.project_id,
      root_path: row.root_path,
      last_seen_at: row.last_seen_at,
      stages_schema_version: row.stages_schema_version,
    });
    const rt = runtimeRowFromDoc(row.runtime_doc);
    if (rt) runtime_states.push(rt);
    for (const run of row.runtime_doc?.recent_runs || []) {
      recent_runs.push({ ...run, project_id: row.project_id });
      if (!run.ended_at) {
        active_runs.push({
          run_id: run.run_id,
          project_id: row.project_id,
          session_id: run.session_id,
          started_at: run.started_at,
        });
      }
    }
  }
  recent_runs.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  return {
    schema: 'ai-auto3.registry-export.v1',
    ok: true,
    source: 'runtime.json',
    exported_at: new Date().toISOString(),
    projects,
    runtime_states,
    recent_runs: recent_runs.slice(0, 50),
    active_runs,
  };
}

function setDashServe(projectId, meta) {
  const id = String(projectId || '').trim();
  if (!id) return;
  const doc = readRuntimeFile(id) || defaultRuntimeDoc();
  doc.services = doc.services || { dash_serve: null };
  doc.services.dash_serve = meta;
  doc.updated_by = 'ai-dash3';
  writeRuntimeFile(id, doc);
}

module.exports = {
  sanitizeProjectId,
  skillsPipelineRoot,
  runtimePathForProjectId,
  readRuntimeFile,
  writeRuntimeFile,
  ensureProjectFromStages,
  updateProjectRuntimeState,
  clearProjectRuntimeState,
  startRun,
  finishRun,
  registerProcess,
  markProcessExited,
  listProjectsFromRuntime,
  runtimeRowFromDoc,
  buildRegistryExportShape,
  setDashServe,
};

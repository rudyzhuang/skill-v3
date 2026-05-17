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

/** 目录名：优先保留 project.name 可读性，仅去掉路径非法字符 */
function sanitizeDirName(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return s.replace(/[/\\:\0]/g, '_').slice(0, 128);
}

/** skill 级运行态（如 dash serve），与业务项目无关 */
function skillsRuntimeRoot() {
  return path.join(skillsRootFromThisFile(), '_runtime');
}

/** 业务项目运行态根目录 */
function skillsProjectsRoot() {
  return path.join(skillsRootFromThisFile(), '_projects');
}

/** @deprecated */
function skillsPipelineRoot() {
  return skillsProjectsRoot();
}

function configDevPath(projectRoot) {
  return path.join(projectRoot, 'docs', 'config.dev.json');
}

function readConfigDev(projectRoot) {
  const fp = configDevPath(projectRoot);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 项目目录名真源：docs/config.dev.json → project.name
 * @returns {{ dirName: string, projectName: string, projectId: string, rootPath: string }}
 */
function resolveProjectDir(projectRoot, stagesDoc) {
  const rootPath = path.resolve(projectRoot);
  const cfg = readConfigDev(rootPath);
  const projectId = String(stagesDoc?.project?.project_id || cfg?.project?.project_id || '').trim();
  let projectName = String(cfg?.project?.name || '').trim();
  if (!projectName) {
    projectName = String(stagesDoc?.project?.name || stagesDoc?.project?.display_name || '').trim();
  }
  if (!projectName && projectId) projectName = projectId;
  if (!projectName) {
    const e = new Error(`runtime-io: docs/config.dev.json 缺少 project.name（${configDevPath(rootPath)}）`);
    e.code = 'NO_PROJECT_NAME';
    throw e;
  }
  const dirName = sanitizeDirName(projectName) || sanitizeProjectId(projectId);
  if (!dirName) {
    const e = new Error('runtime-io: 无法解析项目目录名');
    e.code = 'NO_PROJECT_DIR';
    throw e;
  }
  return { dirName, projectName, projectId, rootPath };
}

function runtimeDirForDirName(dirName) {
  const d = sanitizeDirName(dirName) || sanitizeProjectId(dirName);
  if (!d) throw new Error('runtime-io: empty dirName');
  return path.join(skillsProjectsRoot(), d);
}

function runtimePathForDirName(dirName) {
  return path.join(runtimeDirForDirName(dirName), 'runtime.json');
}

/** skill 仓内 fixtures（如 ai-code3/fixtures/smoke-project）只写 _runtime，不进 _projects */
function isSkillFixtureProjectRoot(projectRoot) {
  const root = path.resolve(String(projectRoot || ''));
  if (!root) return false;
  const skillsRoot = path.resolve(skillsRootFromThisFile());
  const rel = path.relative(skillsRoot, root);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const norm = rel.split(path.sep).join('/');
  return norm.includes('/fixtures/') || norm.endsWith('/fixtures') || norm.includes('fixtures/smoke-project');
}

/**
 * @returns {{ kind: 'project'|'fixture', key: string, dir: string, filePath: string }}
 */
function getStorageForProjectRoot(projectRoot, stagesDoc) {
  const rootPath = path.resolve(projectRoot);
  if (isSkillFixtureProjectRoot(rootPath)) {
    const cfg = readConfigDev(rootPath);
    const projectId = String(
      stagesDoc?.project?.project_id || cfg?.project?.project_id || 'smoke'
    ).trim();
    const key = sanitizeProjectId(projectId) || 'smoke';
    const dir = path.join(skillsRuntimeRoot(), key);
    return { kind: 'fixture', key, dir, filePath: path.join(dir, 'runtime.json') };
  }
  const { dirName } = resolveProjectDir(rootPath, stagesDoc);
  return {
    kind: 'project',
    key: dirName,
    dir: runtimeDirForDirName(dirName),
    filePath: runtimePathForDirName(dirName),
  };
}

function readRuntimeStorage(storage) {
  if (!storage?.filePath || !fs.existsSync(storage.filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(storage.filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeRuntimeStorage(storage, doc) {
  fs.mkdirSync(storage.dir, { recursive: true });
  const tmp = `${storage.filePath}.tmp`;
  doc.updated_at = doc.updated_at || new Date().toISOString();
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, storage.filePath);
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
      project: { project_id: '', project_name: '', root_path: '', display_name: '' },
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

function readRuntimeFileAtDir(dirName) {
  const fp = runtimePathForDirName(dirName);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function writeRuntimeFileAtDir(dirName, doc) {
  const dir = runtimeDirForDirName(dirName);
  fs.mkdirSync(dir, { recursive: true });
  const fp = runtimePathForDirName(dirName);
  const tmp = `${fp}.tmp`;
  doc.updated_at = doc.updated_at || new Date().toISOString();
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

function readRuntimeForProjectRoot(projectRoot, stagesDoc) {
  const stages = stagesDoc || readStagesQuick(projectRoot);
  const storage = getStorageForProjectRoot(projectRoot, stages);
  return readRuntimeStorage(storage);
}

function writeRuntimeForProjectRoot(projectRoot, doc, stagesDoc) {
  const stages = stagesDoc || readStagesQuick(projectRoot);
  const storage = getStorageForProjectRoot(projectRoot, stages);
  writeRuntimeStorage(storage, doc);
}

function readStagesQuick(projectRoot) {
  const fp = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function findStorageByProjectId(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return null;
  migrateLegacyRuntimeDirs();
  const scanDir = (base, kind) => {
    if (!fs.existsSync(base)) return null;
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const fp = path.join(base, ent.name, 'runtime.json');
      if (!fs.existsSync(fp)) continue;
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        continue;
      }
      if (doc?.project?.project_id !== id) continue;
      return {
        kind,
        key: ent.name,
        dir: path.join(base, ent.name),
        filePath: fp,
      };
    }
    return null;
  };
  return scanDir(skillsProjectsRoot(), 'project') || scanDir(skillsRuntimeRoot(), 'fixture');
}

/** @returns {string|null} _projects 目录名；fixture 返回 _runtime 子目录名 */
function findDirNameByProjectId(projectId) {
  const s = findStorageByProjectId(projectId);
  return s ? s.key : null;
}

/** @deprecated 按 project_id 查；优先 _projects */
function readRuntimeFile(projectId) {
  const dir = findDirNameByProjectId(projectId);
  return dir ? readRuntimeFileAtDir(dir) : null;
}

function writeRuntimeFile(projectId, doc) {
  const dir =
    findDirNameByProjectId(projectId) ||
    sanitizeDirName(doc?.project?.project_name || doc?.project?.name) ||
    sanitizeProjectId(projectId);
  writeRuntimeFileAtDir(dir, doc);
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

function runtimeRowFromDoc(doc) {
  if (!doc?.orchestration) return null;
  const o = doc.orchestration;
  const projectName = doc.project?.project_name || doc.project?.name || doc.project?.display_name || '';
  return {
    project_id: doc.project?.project_id || '',
    project_name: projectName,
    root_path: doc.project?.root_path || '',
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
  migrateLegacyRuntimeDirs();
  const storage = getStorageForProjectRoot(projectRoot, stagesDoc);
  const { projectName, projectId, rootPath } = resolveProjectDir(projectRoot, stagesDoc);
  let doc = readRuntimeStorage(storage) || defaultRuntimeDoc();
  doc.project = {
    project_id: projectId,
    project_name: projectName,
    name: projectName,
    root_path: rootPath,
    display_name: projectName,
  };
  doc.updated_by = updatedBy || doc.updated_by || 'ai-auto3';
  writeRuntimeStorage(storage, doc);
  return { projectId, dirName: storage.key, projectName, doc, storageKind: storage.kind };
}

function loadOrCreateByProjectId(projectId, projectRoot, stagesDoc) {
  const existing = findStorageByProjectId(projectId);
  if (existing) {
    return {
      storage: existing,
      dirName: existing.key,
      doc: readRuntimeStorage(existing) || defaultRuntimeDoc(),
    };
  }
  if (projectRoot) {
    const storage = getStorageForProjectRoot(projectRoot, stagesDoc);
    return {
      storage,
      dirName: storage.key,
      doc: readRuntimeStorage(storage) || defaultRuntimeDoc(),
    };
  }
  const id = String(projectId || '').trim();
  const key = sanitizeProjectId(id);
  return {
    storage: {
      kind: 'project',
      key,
      dir: runtimeDirForDirName(key),
      filePath: runtimePathForDirName(key),
    },
    dirName: key,
    doc: defaultRuntimeDoc(),
  };
}

function writeLoadedRuntime(loaded, doc) {
  if (loaded.storage) {
    writeRuntimeStorage(loaded.storage, doc);
    return;
  }
  writeRuntimeFileAtDir(loaded.dirName, doc);
}

function updateProjectRuntimeState(projectId, patch, updatedBy, projectRoot, stagesDoc) {
  const id = String(projectId || '').trim();
  if (!id) return;
  const loaded = loadOrCreateByProjectId(id, projectRoot, stagesDoc);
  let doc = loaded.doc;
  if (projectRoot && stagesDoc) {
    const r = resolveProjectDir(projectRoot, stagesDoc);
    doc.project = {
      project_id: r.projectId,
      project_name: r.projectName,
      name: r.projectName,
      root_path: r.rootPath,
      display_name: r.projectName,
    };
  } else if (!doc.project?.project_id) {
    doc.project = { project_id: id, root_path: projectRoot || '', project_name: '', display_name: '' };
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
  writeLoadedRuntime(loaded, doc);
}

function clearProjectRuntimeState(projectId, projectRoot, stagesDoc) {
  const id = String(projectId || '').trim();
  if (!id) return;
  const loaded = loadOrCreateByProjectId(id, projectRoot, stagesDoc);
  const doc = readRuntimeStorage(loaded.storage) || loaded.doc;
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
  writeLoadedRuntime(loaded, doc);
}

function startRun(projectId, sessionId, orchestrator, projectRoot, stagesDoc) {
  const id = String(projectId || '').trim();
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  const loaded = loadOrCreateByProjectId(id, projectRoot, stagesDoc);
  const doc = loaded.doc;
  if (projectRoot && stagesDoc) {
    const r = resolveProjectDir(projectRoot, stagesDoc);
    doc.project = {
      project_id: r.projectId,
      project_name: r.projectName,
      name: r.projectName,
      root_path: r.rootPath,
      display_name: r.projectName,
    };
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
  writeLoadedRuntime(loaded, doc);
  return runId;
}

function finishActiveRuns(projectId, exitCode, stoppedAtStage) {
  const id = String(projectId || '').trim();
  if (!id) return [];
  const storage = findStorageByProjectId(id);
  if (!storage) return [];
  const doc = readRuntimeStorage(storage);
  if (!doc) return [];
  const now = new Date().toISOString();
  const finished = [];
  for (const run of doc.recent_runs || []) {
    if (!run.ended_at) {
      run.ended_at = now;
      run.exit_code = exitCode;
      run.stopped_at_stage = stoppedAtStage || 'user_stop';
      finished.push(run.run_id);
    }
  }
  if (doc.orchestration?.active) doc.orchestration.active = false;
  doc.updated_by = 'ai-auto3';
  writeRuntimeStorage(storage, doc);
  return finished;
}

function finishRun(runId, exitCode, stoppedAt) {
  migrateLegacyRuntimeDirs();
  const now = new Date().toISOString();
  const tryRoot = (base, kind) => {
    if (!fs.existsSync(base)) return false;
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const fp = path.join(base, ent.name, 'runtime.json');
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
      runs[idx] = { ...runs[idx], ended_at: now, exit_code: exitCode, stopped_at_stage: stoppedAt || '' };
      doc.recent_runs = runs;
      if (doc.orchestration?.active_run_id === runId) doc.orchestration.active = false;
      doc.updated_by = 'ai-auto3';
      const storage = {
        kind,
        key: ent.name,
        dir: path.join(base, ent.name),
        filePath: fp,
      };
      writeRuntimeStorage(storage, doc);
      return true;
    }
    return false;
  };
  if (tryRoot(skillsProjectsRoot(), 'project')) return;
  tryRoot(skillsRuntimeRoot(), 'fixture');
}

function registerProcess(projectId, entry, projectRoot, stagesDoc) {
  const id = String(projectId || '').trim();
  if (!id) return;
  const loaded = loadOrCreateByProjectId(id, projectRoot, stagesDoc);
  const doc = loaded.doc;
  if (projectRoot && stagesDoc) {
    const r = resolveProjectDir(projectRoot, stagesDoc);
    doc.project = {
      project_id: r.projectId,
      project_name: r.projectName,
      name: r.projectName,
      root_path: r.rootPath,
      display_name: r.projectName,
    };
  }
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
  writeLoadedRuntime(loaded, doc);
}

function markProcessExited(projectId, pid, exitCode) {
  const storage = findStorageByProjectId(projectId);
  if (!storage) return;
  const doc = readRuntimeStorage(storage);
  if (!doc) return;
  const p = Number(pid);
  doc.processes = (doc.processes || []).map((proc) => {
    if (proc.pid === p && proc.status === 'running') {
      return { ...proc, status: 'exited', exit_code: exitCode, ended_at: new Date().toISOString() };
    }
    return proc;
  });
  doc.updated_by = 'ai-auto3';
  writeRuntimeStorage(storage, doc);
}

function moveRuntimeFile(fromDir, toDir) {
  if (fromDir === toDir) return;
  const from = runtimePathForDirName(fromDir);
  const to = runtimePathForDirName(toDir);
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  try {
    const left = path.dirname(from);
    if (fs.readdirSync(left).length === 0) fs.rmdirSync(left);
  } catch {
    /* ignore */
  }
}

function migrateDocToStorage(doc, fallbackDirName) {
  const rootPath = doc?.project?.root_path;
  if (rootPath && isSkillFixtureProjectRoot(rootPath)) {
    const stages = fs.existsSync(rootPath) ? readStagesQuick(rootPath) : null;
    const storage = getStorageForProjectRoot(rootPath, stages);
    writeRuntimeStorage(storage, doc);
    return storage.key;
  }
  let targetDir = fallbackDirName;
  if (rootPath && fs.existsSync(rootPath)) {
    try {
      const stages = readStagesQuick(rootPath);
      targetDir = resolveProjectDir(rootPath, stages).dirName;
    } catch {
      const name = doc?.project?.project_name || doc?.project?.name || doc?.project?.display_name;
      if (name) targetDir = sanitizeDirName(name) || fallbackDirName;
    }
  } else {
    const name = doc?.project?.project_name || doc?.project?.name;
    if (name) targetDir = sanitizeDirName(name) || fallbackDirName;
  }
  fs.mkdirSync(runtimeDirForDirName(targetDir), { recursive: true });
  writeRuntimeFileAtDir(targetDir, doc);
  return targetDir;
}

/** _projects 中误登记的 skill fixtures → _runtime/<project_id>/ */
function relocateMisplacedFixtureRuntimes() {
  const projectsRoot = skillsProjectsRoot();
  if (!fs.existsSync(projectsRoot)) return;
  for (const ent of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const fp = path.join(projectsRoot, ent.name, 'runtime.json');
    if (!fs.existsSync(fp)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      continue;
    }
    const rootPath = doc?.project?.root_path;
    if (!rootPath || !isSkillFixtureProjectRoot(rootPath)) continue;
    const stages = fs.existsSync(rootPath) ? readStagesQuick(rootPath) : null;
    const target = getStorageForProjectRoot(rootPath, stages);
    const existing = readRuntimeStorage(target);
    const pick =
      !existing ||
      String(doc.updated_at || '') >= String(existing.updated_at || '')
        ? doc
        : existing;
    writeRuntimeStorage(target, pick);
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
    try {
      const left = path.join(projectsRoot, ent.name);
      if (fs.readdirSync(left).length === 0) fs.rmdirSync(left);
    } catch {
      /* ignore */
    }
  }
}

/** .pipeline/、_runtime/<id>/ → _projects/<project.name>/ 或 fixtures → _runtime/<project_id>/ */
function migrateLegacyRuntimeDirs() {
  const skillsRoot = skillsRootFromThisFile();
  const legacyPipeline = path.join(skillsRoot, '.pipeline');
  const legacyRuntime = skillsRuntimeRoot();

  const ingestFile = (fromPath, fallbackDir) => {
    if (!fs.existsSync(fromPath)) return;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(fromPath, 'utf8'));
    } catch {
      return;
    }
    migrateDocToStorage(doc, fallbackDir);
    try {
      fs.unlinkSync(fromPath);
    } catch {
      /* ignore */
    }
  };

  if (fs.existsSync(legacyPipeline)) {
    for (const ent of fs.readdirSync(legacyPipeline, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      ingestFile(path.join(legacyPipeline, ent.name, 'runtime.json'), ent.name);
      try {
        const left = path.join(legacyPipeline, ent.name);
        if (fs.readdirSync(left).length === 0) fs.rmdirSync(left);
      } catch {
        /* ignore */
      }
    }
    try {
      if (fs.readdirSync(legacyPipeline).length === 0) fs.rmdirSync(legacyPipeline);
    } catch {
      /* ignore */
    }
  }

  if (fs.existsSync(legacyRuntime)) {
    for (const ent of fs.readdirSync(legacyRuntime, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'dash-serve.json') continue;
      const fp = path.join(legacyRuntime, ent.name, 'runtime.json');
      if (!fs.existsSync(fp)) continue;
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        continue;
      }
      if (doc?.services?.dash_serve && !doc.orchestration?.active && !(doc.recent_runs || []).length) {
        try {
          fs.unlinkSync(fp);
        } catch {
          /* ignore */
        }
        continue;
      }
      migrateDocToStorage(doc, ent.name);
      try {
        fs.unlinkSync(fp);
      } catch {
        /* ignore */
      }
      try {
        const left = path.join(legacyRuntime, ent.name);
        if (fs.readdirSync(left).length === 0) fs.rmdirSync(left);
      } catch {
        /* ignore */
      }
    }
  }

  relocateMisplacedFixtureRuntimes();
}

/** ai-dash3 仅扫描 _projects */
function listProjectsFromRuntime() {
  migrateLegacyRuntimeDirs();
  const root = skillsProjectsRoot();
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
    const projectName =
      doc.project?.project_name || doc.project?.name || doc.project?.display_name || ent.name;
    const pid = doc.project?.project_id || ent.name;
    out.push({
      project_id: pid,
      project_name: projectName,
      dir_name: ent.name,
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
      project_name: row.project_name,
      dir_name: row.dir_name,
      root_path: row.root_path,
      last_seen_at: row.last_seen_at,
      stages_schema_version: row.stages_schema_version,
    });
    const rt = runtimeRowFromDoc(row.runtime_doc);
    if (rt) runtime_states.push(rt);
    for (const run of row.runtime_doc?.recent_runs || []) {
      recent_runs.push({ ...run, project_id: row.project_id, project_name: row.project_name });
      if (!run.ended_at) {
        active_runs.push({
          run_id: run.run_id,
          project_id: row.project_id,
          project_name: row.project_name,
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
    source: '_projects/runtime.json',
    exported_at: new Date().toISOString(),
    projects,
    runtime_states,
    recent_runs: recent_runs.slice(0, 50),
    active_runs,
  };
}

function dashServePath() {
  return path.join(skillsRuntimeRoot(), 'dash-serve.json');
}

/** skill 级：dash serve 元数据写入 _runtime/dash-serve.json */
function setDashServe(_projectId, meta) {
  fs.mkdirSync(skillsRuntimeRoot(), { recursive: true });
  const fp = dashServePath();
  const payload = {
    schema: 'ai-dash3.serve.v1',
    updated_at: new Date().toISOString(),
    ...meta,
  };
  fs.writeFileSync(fp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function runtimePathForProjectId(projectId) {
  const dir = findDirNameByProjectId(projectId);
  return dir ? runtimePathForDirName(dir) : null;
}

module.exports = {
  sanitizeProjectId,
  sanitizeDirName,
  skillsRuntimeRoot,
  skillsProjectsRoot,
  skillsPipelineRoot,
  migrateLegacyRuntimeDirs,
  resolveProjectDir,
  readConfigDev,
  runtimePathForProjectId,
  runtimePathForDirName,
  readRuntimeFile,
  readRuntimeFileAtDir,
  readRuntimeForProjectRoot,
  writeRuntimeFile,
  writeRuntimeFileAtDir,
  ensureProjectFromStages,
  updateProjectRuntimeState,
  clearProjectRuntimeState,
  startRun,
  finishRun,
  finishActiveRuns,
  registerProcess,
  markProcessExited,
  listProjectsFromRuntime,
  runtimeRowFromDoc,
  buildRegistryExportShape,
  setDashServe,
  findDirNameByProjectId,
  findStorageByProjectId,
  isSkillFixtureProjectRoot,
  getStorageForProjectRoot,
  relocateMisplacedFixtureRuntimes,
};

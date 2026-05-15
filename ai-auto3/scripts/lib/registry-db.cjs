'use strict';

const fs = require('fs');
const path = require('path');
const { skillsRootFromThisFile } = require('./paths.cjs');

const REGISTRY_DIR = () => path.join(skillsRootFromThisFile(), '_registry');
const REGISTRY_DB = () => path.join(REGISTRY_DIR(), 'registry.sqlite');

let _db;

function openDb() {
  if (_db) return _db;
  let Database;
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    Database = require('better-sqlite3');
  } catch (e) {
    const err = new Error(
      'ai-auto3: 无法加载 better-sqlite3。请在 ai-auto3 目录执行 npm install（registry.sqlite 需要）。'
    );
    err.code = 'NO_SQLITE';
    throw err;
  }
  const dir = REGISTRY_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = REGISTRY_DB();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      stages_schema_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER,
      stopped_at_stage TEXT
    );
    CREATE TABLE IF NOT EXISTS stage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      child_exit_code INTEGER,
      duration_ms INTEGER,
      skipped INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_project ON pipeline_runs(project_id, started_at);
  `);
  _db = db;
  return db;
}

function hasProject(projectId) {
  const db = openDb();
  const row = db.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId);
  return !!row;
}

/**
 * @param {string} projectRoot
 * @param {object} stagesDoc
 */
function upsertProjectFromStages(projectRoot, stagesDoc) {
  const db = openDb();
  const projectId = stagesDoc.project?.project_id;
  if (!projectId || !String(projectId).trim()) {
    const e = new Error('registry: stages.json.project.project_id 为空');
    e.code = 'NO_PROJECT_ID';
    throw e;
  }
  const schemaVer = stagesDoc._schema?.version ?? 1;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (project_id, root_path, last_seen_at, stages_schema_version)
     VALUES (@project_id, @root_path, @last_seen_at, @sv)
     ON CONFLICT(project_id) DO UPDATE SET
       root_path = excluded.root_path,
       last_seen_at = excluded.last_seen_at,
       stages_schema_version = excluded.stages_schema_version`
  ).run({
    project_id: String(projectId),
    root_path: projectRoot,
    last_seen_at: now,
    sv: schemaVer,
  });
  return { projectId };
}

function startRun(projectId, sessionId) {
  const db = openDb();
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pipeline_runs (run_id, project_id, session_id, started_at, ended_at, exit_code, stopped_at_stage)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL)`
  ).run(runId, projectId, sessionId || '', now);
  return runId;
}

function finishRun(runId, exitCode, stoppedAt) {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pipeline_runs SET ended_at = ?, exit_code = ?, stopped_at_stage = ? WHERE run_id = ?`
  ).run(now, exitCode, stoppedAt || '', runId);
}

function recordStageEvent(runId, stage, childExit, durationMs, skipped, notes) {
  const db = openDb();
  db.prepare(
    `INSERT INTO stage_events (run_id, stage, child_exit_code, duration_ms, skipped, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(runId, stage, childExit, durationMs || 0, skipped ? 1 : 0, notes || '');
}

module.exports = {
  openDb,
  hasProject,
  upsertProjectFromStages,
  startRun,
  finishRun,
  recordStageEvent,
  REGISTRY_DB,
};

#!/usr/bin/env node
'use strict';

/**
 * 只读导出 registry.sqlite → 单行 JSON（供 ai-dash3 web 等多项目看板消费）
 * schema: ai-auto3.registry-export.v1
 */

const { openDb } = require('./lib/registry-db.cjs');

function main() {
  let db;
  try {
    db = openDb();
  } catch (e) {
    const out = {
      schema: 'ai-auto3.registry-export.v1',
      ok: false,
      error: String(e.message || e),
      projects: [],
      runtime_states: [],
      recent_runs: [],
      active_runs: [],
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(e.code === 'NO_SQLITE' ? 2 : 1);
  }

  const projects = db
    .prepare(
      `SELECT project_id, root_path, last_seen_at, stages_schema_version
       FROM projects ORDER BY last_seen_at DESC`
    )
    .all();

  const runtime_states = db
    .prepare(
      `SELECT project_id, active_run_id, current_phase, current_stage, pending_features_json, updated_at
       FROM project_runtime_state`
    )
    .all();

  const recent_runs = db
    .prepare(
      `SELECT run_id, project_id, session_id, started_at, ended_at, exit_code, stopped_at_stage
       FROM pipeline_runs
       ORDER BY started_at DESC
       LIMIT 50`
    )
    .all();

  const active_runs = db
    .prepare(
      `SELECT run_id, project_id, session_id, started_at
       FROM pipeline_runs
       WHERE ended_at IS NULL
       ORDER BY started_at DESC`
    )
    .all();

  const payload = {
    schema: 'ai-auto3.registry-export.v1',
    ok: true,
    exported_at: new Date().toISOString(),
    projects,
    runtime_states,
    recent_runs,
    active_runs,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();

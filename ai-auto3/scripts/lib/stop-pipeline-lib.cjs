'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pipelineLockPath } = require('./paths.cjs');
const {
  openDb,
  clearProjectRuntimeState,
  upsertProjectFromStages,
} = require('./registry-db.cjs');

const GRACE_MS = 5000;

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepMs(ms) {
  if (ms <= 0) return;
  try {
    execFileSync('sleep', [String(Math.ceil(ms / 1000))], { stdio: 'ignore' });
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy fallback */
    }
  }
}

function readLockMeta(projectRoot) {
  const lp = pipelineLockPath(projectRoot);
  if (!fs.existsSync(lp)) return { path: lp, meta: null };
  try {
    return { path: lp, meta: JSON.parse(fs.readFileSync(lp, 'utf8').trim()) };
  } catch {
    return { path: lp, meta: null };
  }
}

function removeLockIfSafe(projectRoot) {
  const { path: lp, meta } = readLockMeta(projectRoot);
  if (!fs.existsSync(lp)) return false;
  const pid = meta?.pid;
  if (typeof pid === 'number' && pidAlive(pid)) return false;
  try {
    fs.unlinkSync(lp);
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出与该项目流水线相关的进程（autorun / ai-code3 / ai-design3 / cursor-agent 等）
 * @param {string} projectRoot
 */
function listPipelineProcesses(projectRoot) {
  const abs = path.resolve(projectRoot);
  const wtPrefix = path.join(abs, '.pipeline', 'worktrees');
  let psOut;
  try {
    psOut = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const hits = [];
  const seen = new Set();
  for (const line of psOut.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
    if (seen.has(pid)) continue;
    if (cmd.includes('ai-dash3/scripts/serve')) continue;
    if (cmd.includes('stop-pipeline.cjs')) continue;

    const mentionsRoot = cmd.includes(abs);
    const mentionsWt = cmd.includes(wtPrefix);
    const isPipeline =
      mentionsRoot &&
      (cmd.includes('ai-auto3/scripts/autorun.cjs') ||
        cmd.includes('ai-code3/scripts/') ||
        cmd.includes('ai-design3/scripts/') ||
        cmd.includes('ai-publish-dev3/scripts/') ||
        cmd.includes('ai-publish-release3/scripts/') ||
        cmd.includes('ai-e2e3/scripts/'));
    const isAgent = cmd.includes('cursor-agent') && (mentionsRoot || mentionsWt);

    if (isPipeline || isAgent) {
      seen.add(pid);
      hits.push({
        pid,
        role: isAgent ? 'cursor-agent' : 'pipeline_child',
        command: cmd.length > 240 ? `${cmd.slice(0, 237)}...` : cmd,
      });
    }
  }
  return hits.sort((a, b) => a.pid - b.pid);
}

function collectDescendantPids(rootPid) {
  const out = new Set();
  function walk(pid) {
    if (!Number.isFinite(pid) || pid <= 0 || out.has(pid)) return;
    out.add(pid);
    let children = '';
    try {
      children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim();
    } catch {
      return;
    }
    for (const line of children.split('\n')) {
      const cp = Number(line.trim());
      if (Number.isFinite(cp)) walk(cp);
    }
  }
  walk(rootPid);
  return [...out];
}

function terminatePids(pids) {
  const unique = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0 && p !== process.pid))];
  const results = [];
  if (!unique.length) return results;

  for (const pid of unique) {
    try {
      process.kill(pid, 'SIGTERM');
      results.push({ pid, signal: 'SIGTERM', ok: true });
    } catch (e) {
      results.push({ pid, signal: 'SIGTERM', ok: false, error: String(e.message || e) });
    }
  }
  sleepMs(GRACE_MS);
  for (const pid of unique) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      results.push({ pid, signal: 'SIGKILL', ok: true });
    } catch (e) {
      results.push({ pid, signal: 'SIGKILL', ok: false, error: String(e.message || e) });
    }
  }
  return results;
}

function finishActiveRegistryRuns(projectId) {
  if (!projectId) return [];
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT run_id FROM pipeline_runs WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC`
    )
    .all(projectId);
  const now = new Date().toISOString();
  const finished = [];
  for (const row of rows) {
    db.prepare(
      `UPDATE pipeline_runs SET ended_at = ?, exit_code = ?, stopped_at_stage = ? WHERE run_id = ?`
    ).run(now, 130, 'user_stop', row.run_id);
    finished.push(row.run_id);
  }
  return finished;
}

/**
 * @param {string} projectRoot absolute path
 */
function stopProjectPipeline(projectRoot) {
  const abs = path.resolve(projectRoot);
  if (!fs.existsSync(abs)) {
    const e = new Error(`project path does not exist: ${abs}`);
    e.code = 'PROJECT_NOENT';
    throw e;
  }

  const { meta: lockMeta } = readLockMeta(abs);
  const lockPid = typeof lockMeta?.pid === 'number' ? lockMeta.pid : null;

  const listed = listPipelineProcesses(abs);
  const pidSet = new Set(listed.map((p) => p.pid));
  if (lockPid && pidAlive(lockPid)) {
    for (const dp of collectDescendantPids(lockPid)) pidSet.add(dp);
    pidSet.add(lockPid);
  }

  const killResults = terminatePids([...pidSet]);
  const lockRemoved = removeLockIfSafe(abs);

  let projectId = '';
  const stagesPath = path.join(abs, '.pipeline', 'stages.json');
  if (fs.existsSync(stagesPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
      projectId = String(doc?.project?.project_id || '').trim();
      try {
        upsertProjectFromStages(abs, doc);
      } catch {
        /* registry optional */
      }
    } catch {
      /* */
    }
  }

  let runsFinished = [];
  if (projectId) {
    try {
      runsFinished = finishActiveRegistryRuns(projectId);
      clearProjectRuntimeState(projectId);
    } catch (e) {
      return {
        ok: true,
        project_root: abs,
        project_id: projectId,
        processes: listed,
        killed: killResults,
        lock_removed: lockRemoved,
        runs_finished: runsFinished,
        registry_warning: String(e.message || e),
      };
    }
  }

  const stillAlive = listPipelineProcesses(abs).filter((p) => pidAlive(p.pid));

  return {
    ok: stillAlive.length === 0,
    project_root: abs,
    project_id: projectId,
    processes_matched: listed.length,
    processes: listed,
    killed: killResults,
    lock_removed: lockRemoved,
    runs_finished: runsFinished,
    still_running: stillAlive,
  };
}

module.exports = {
  stopProjectPipeline,
  listPipelineProcesses,
  pidAlive,
};

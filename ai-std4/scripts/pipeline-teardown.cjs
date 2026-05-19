'use strict';

/**
 * pipeline-teardown.cjs — ai-std4 流水线收尾脚本（§3.3）
 *
 * 调用形态：
 *   node ai-std4/scripts/pipeline-teardown.cjs \
 *     --project=<业务项目根绝对路径> \
 *     --session-id=<run_id>
 *
 * 职责：
 *   1. 从 session 文件 / 锁文件收集需要终止的 PID
 *   2. SIGTERM → 等待 5s → SIGKILL 优雅结束各子进程
 *   3. 记录日志 pipeline_teardown_start / pipeline_teardown_complete
 *   4. 更新 stages.json pipeline.teardown_at
 *
 * 禁止：git reset --hard、删除 worktrees/ / logs/ / .pipeline/reports/
 *
 * 退出码：总是 0（尽力而为，不因 kill 失败而报错）
 */

const fs   = require('fs');
const path = require('path');

const { createLogger, formatLocalTimeShort } = require('./libs/logger.cjs');
const { createPipelinePaths } = require('./libs/pipeline-paths.cjs');

// ── 参数解析 ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    })
);

const projectRoot = args.project
  ? path.resolve(String(args.project))
  : process.env.AI_STD4_PROJECT
    ? path.resolve(process.env.AI_STD4_PROJECT)
    : process.cwd();

const sessionId = args['session-id'] ? String(args['session-id']) : null;

// ── 路径常量 ──────────────────────────────────────────────────────
const paths          = createPipelinePaths(projectRoot);
const pipelineDir    = paths.pipelineDir;
const stagesJsonPath = paths.stagesJsonPath;
const locksDir       = paths.locksDir;

// ── Logger ────────────────────────────────────────────────────────
paths.ensureRuntimeDirs();
const log = createLogger({ projectRoot, stage: 'pipeline-teardown', runId: sessionId });

// ── stages.json 读写 ──────────────────────────────────────────────
function readStagesJson() {
  return paths.readStagesJson();
}

function writeStagesJson(obj) {
  return paths.writeStagesJson(obj);
}

// ── PID 收集 ──────────────────────────────────────────────────────
/**
 * 读取 PID 文件，返回有效整数 PID 或 null
 */
function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

/**
 * 收集所有需要终止的 PID
 * 优先级：
 *   1. .pipeline/session-<session_id>.json（最精确）
 *   2. .pipeline/locks/*.pid（fallback）
 *   3. .pipeline/run-dash.pid（fallback）
 */
function collectPids() {
  const pids = new Set();

  // 1. session 文件
  if (sessionId) {
    const sessionPath = path.join(pipelineDir, `session-${sessionId}.json`);
    if (fs.existsSync(sessionPath)) {
      try {
        const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        if (session.run_dash_pid && Number.isFinite(session.run_dash_pid)) {
          pids.add(session.run_dash_pid);
        }
        if (Array.isArray(session.worker_pids)) {
          session.worker_pids.forEach(p => {
            if (Number.isFinite(p) && p > 0) pids.add(p);
          });
        }
        if (Array.isArray(session.stage_pids)) {
          session.stage_pids.forEach(p => {
            if (Number.isFinite(p) && p > 0) pids.add(p);
          });
        }
        log.info('file_updated', `从 session 文件读取 PID 列表`, {
          session_path: sessionPath,
          pid_count: pids.size,
        });
        // session 文件读取成功，不需要 fallback
        return [...pids];
      } catch (err) {
        log.warn('file_updated', `读取 session 文件失败，降级到 fallback: ${err.message}`, {
          session_path: sessionPath,
          error: err.message,
        });
      }
    }
  }

  // 2. .pipeline/locks/*.pid
  if (fs.existsSync(locksDir)) {
    try {
      const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.pid'));
      for (const f of files) {
        const pid = readPidFile(path.join(locksDir, f));
        if (pid !== null) pids.add(pid);
      }
      if (files.length > 0) {
        log.info('file_updated', `从 locks/ 读取 ${files.length} 个 PID 文件`, {
          lock_files: files,
          pid_count: pids.size,
        });
      }
    } catch (err) {
      log.warn('file_updated', `读取 locks/ 目录失败: ${err.message}`, { error: err.message });
    }
  }

  // 3. .pipeline/run-dash.pid
  const dashPidPath = path.join(pipelineDir, 'run-dash.pid');
  const dashPid = readPidFile(dashPidPath);
  if (dashPid !== null) {
    pids.add(dashPid);
    log.info('file_updated', `从 run-dash.pid 读取 dash PID: ${dashPid}`, {
      pid_path: dashPidPath,
      dash_pid: dashPid,
    });
  }

  return [...pids];
}

// ── 优雅 kill ─────────────────────────────────────────────────────
/**
 * 检查进程是否存在
 */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 对单个 PID 执行 SIGTERM → 等待 timeoutMs → SIGKILL
 * @returns {{ pid, killed, signal, error }}
 */
async function killGracefully(pid, timeoutMs = 5000) {
  if (!processExists(pid)) {
    log.info('file_updated', `PID ${pid} 不存在，跳过`, { pid, action: 'skip_nonexistent' });
    return { pid, killed: false, signal: 'none', error: null };
  }

  // SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
    log.info('file_updated', `已发送 SIGTERM 到 PID ${pid}`, { pid, signal: 'SIGTERM' });
  } catch (err) {
    log.warn('file_updated', `发送 SIGTERM 到 PID ${pid} 失败: ${err.message}`, {
      pid, signal: 'SIGTERM', error: err.message,
    });
    return { pid, killed: false, signal: 'SIGTERM_failed', error: err.message };
  }

  // 等待 timeoutMs，每 100ms 轮询进程是否已退出
  const pollInterval = 100;
  const maxPolls = Math.ceil(timeoutMs / pollInterval);
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, pollInterval));
    if (!processExists(pid)) {
      log.info('file_updated', `PID ${pid} 已在 SIGTERM 后自行退出（等待 ${(i + 1) * pollInterval}ms）`, {
        pid, signal: 'SIGTERM', wait_ms: (i + 1) * pollInterval,
      });
      return { pid, killed: true, signal: 'SIGTERM', error: null };
    }
  }

  // 超时 → SIGKILL
  try {
    process.kill(pid, 'SIGKILL');
    log.warn('file_updated', `PID ${pid} 在 ${timeoutMs}ms 内未退出，已发送 SIGKILL`, {
      pid, signal: 'SIGKILL', timeout_ms: timeoutMs,
    });
    return { pid, killed: true, signal: 'SIGKILL', error: null };
  } catch (err) {
    // 进程可能在 SIGKILL 前的瞬间自行退出
    if (!processExists(pid)) {
      return { pid, killed: true, signal: 'SIGKILL_raced', error: null };
    }
    log.error('file_updated', `发送 SIGKILL 到 PID ${pid} 失败: ${err.message}`, {
      pid, signal: 'SIGKILL', error: err.message,
    });
    return { pid, killed: false, signal: 'SIGKILL_failed', error: err.message };
  }
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();

  // 收集 PID
  const pids = collectPids();

  // 写 teardown_start 日志
  log.info('pipeline_teardown_start', `流水线收尾开始，目标进程数: ${pids.length}`, {
    session_id: sessionId,
    targets:    pids,
    project:    projectRoot,
  });

  // 对每个 PID 优雅终止（并行）
  const results = await Promise.all(pids.map(pid => killGracefully(pid, 5000)));

  const killedCount = results.filter(r => r.killed).length;
  const errors      = results
    .filter(r => r.error !== null)
    .map(r => ({ pid: r.pid, error: r.error }));

  const durationMs = Date.now() - t0;

  // 写 teardown_complete 日志
  log.info('pipeline_teardown_complete', `流水线收尾完成，终止进程数: ${killedCount}/${pids.length}`, {
    session_id:   sessionId,
    killed_count: killedCount,
    total_pids:   pids.length,
    duration_ms:  durationMs,
    errors,
  });

  // 更新 stages.json pipeline.teardown_at
  const teardownAt = formatLocalTimeShort();
  const stages = readStagesJson();
  if (stages) {
    if (!stages.pipeline) stages.pipeline = {};
    stages.pipeline.teardown_at = teardownAt;
    stages.pipeline.updated_at  = teardownAt;
    writeStagesJson(stages);
    log.info('file_updated', `stages.json 已更新 pipeline.teardown_at`, {
      teardown_at: teardownAt,
      path:        stagesJsonPath,
    });
  } else {
    log.warn('file_updated', 'stages.json 不存在，跳过更新 teardown_at', {
      path: stagesJsonPath,
    });
  }

  // 清理 run-dash.pid（若存在）
  const dashPidPath = path.join(pipelineDir, 'run-dash.pid');
  if (fs.existsSync(dashPidPath)) {
    try {
      fs.unlinkSync(dashPidPath);
      log.info('file_updated', '已清理 run-dash.pid', { path: dashPidPath });
    } catch (_) { /* ignore */ }
  }

  // 总是退出 0（teardown 尽力而为）
  process.exit(0);
}

main().catch(err => {
  // 即使发生未预期异常也 exit 0（不中断调用链）
  try { log.error('pipeline_teardown_complete', `teardown 未捕获异常: ${err.message}`, { error: err.message }); } catch (_) {}
  process.exit(0);
});

'use strict';

/**
 * ui-e2e-runner.cjs — 单场景确定性执行（MCP runner）
 *
 * 解析 YAML steps[]，经 http / playwright / mcp 驱动浏览器，脚本侧判定 expect[]。
 * 分诊仍由 ui-e2e.cjs 内 SDK Agent 负责。
 */

const fs = require('fs');
const path = require('path');
const { substitutePlaceholders, buildScenarioVars } = require('./ui-e2e-placeholders.cjs');
const { scenarioNeedsInteractiveSteps } = require('./ui-e2e-expect.cjs');
const { selectBrowserDriver, preflightBrowser, preflightDart } = require('./ui-e2e-mcp-preflight.cjs');
const { runWebScenarioHttp } = require('./ui-e2e-browser-http.cjs');
const { runWebScenarioPlaywright } = require('./ui-e2e-browser-playwright.cjs');
const { runWebScenarioMcp } = require('./ui-e2e-browser-mcp.cjs');
const { runMobileScenarioWithRunner, resetMobileSessions } = require('./ui-e2e-dart-runner.cjs');

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {object} opts.sc — 场景队列项（含 steps/expect/platform/mcp/base_url）
 * @param {object} opts.config
 * @param {object} opts.log — logger（info/debug/warn/error）
 * @param {string} opts.datetime — 日志文件名时间戳
 * @param {number} opts.scenarioTimeoutMs
 * @param {number} opts.maxFixAttempts
 * @param {string} [opts.browserDriver] 覆盖自动选择
 * @returns {Promise<object>} 与 ui-e2e.cjs runScenario 返回结构一致
 */
async function runScenarioWithRunner(opts) {
  const {
    projectRoot,
    sc,
    config,
    log,
    datetime,
    scenarioTimeoutMs,
    maxFixAttempts,
    browserDriver: driverOverride,
  } = opts;

  const startedAt = Date.now();
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(startedAt);
  const startedStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const scLogDir = path.join(projectRoot, 'logs', 'stages', 'ui_e2e');
  const featLogDir = path.join(projectRoot, 'logs', 'features', sc.feature_id);
  const snapDir = path.join(projectRoot, '.pipeline', 'logs', 'snapshots', sc.scenario_id);
  fs.mkdirSync(scLogDir, { recursive: true });
  fs.mkdirSync(featLogDir, { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });

  const scLogPath = path.join(scLogDir, `${datetime}-${sc.scenario_id}.log`);
  const appendLog = (line) => {
    try {
      fs.appendFileSync(scLogPath, line, 'utf8');
    } catch (_) {}
  };
  fs.writeFileSync(scLogPath, `[ui_e2e] scenario=${sc.scenario_id} runner started at ${startedStr}\n`, 'utf8');

  const completedStr = () => {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  };

  log.info('ui_scenario_start', `[ui_e2e] scenario=${sc.scenario_id} feature=${sc.feature_id} 开始执行（runner）`, {
    scenario_id: sc.scenario_id,
    feature_id: sc.feature_id,
    platform: sc.platform,
    mcp: sc.mcp,
    base_url: sc.base_url || null,
  });

  if (sc.platform === 'desktop' || sc.mcp === 'none') {
    return finishSkipped({
      sc,
      startedStr,
      scLogPath,
      projectRoot,
      startedAt,
      skip_reason: 'desktop_not_implemented',
    });
  }

  if (sc.mcp === 'dart' || sc.platform === 'android' || sc.platform === 'ios') {
    const dartPf = await preflightDart(config, projectRoot);
    if (!dartPf.ok) {
      return finishSkipped({
        sc,
        startedStr,
        scLogPath,
        projectRoot,
        startedAt,
        skip_reason: 'mobile_env_unsatisfied',
        log,
      });
    }

    const vars = buildScenarioVars(config, sc.base_url || '');
    const snapshotPaths = [];
    let fixAttempts = 0;
    let timedOut = false;
    let lastResult = { passed: false, failure_summary: 'unknown' };

    const onStep = ({ step_index, action, duration_ms }) => {
      log.debug('ui_scenario_step', `[ui_e2e] scenario=${sc.scenario_id} step=${step_index} ${action}`, {
        scenario_id: sc.scenario_id,
        step_index,
        action,
        duration_ms,
      });
    };

    while (fixAttempts <= maxFixAttempts) {
      if (fixAttempts > 0) {
        log.warn('ui_scenario_retry', `[ui_e2e] scenario=${sc.scenario_id} 即时重试 #${fixAttempts}`, {
          scenario_id: sc.scenario_id,
          attempt: fixAttempts,
          reason: lastResult.failure_summary || 'retry',
        });
      }

      const execPromise = runMobileScenarioWithRunner({
        projectRoot,
        sc,
        config,
        vars,
        appendLog,
        onStep,
        snapDir,
        scenarioTimeoutMs,
      });
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve({
            passed: false,
            timedOut: true,
            failure_summary: `场景超时（${scenarioTimeoutMs}ms）`,
          });
        }, scenarioTimeoutMs + 500)
      );

      lastResult = await Promise.race([execPromise, timeoutPromise]);

      if (Array.isArray(lastResult.snapshot_paths)) {
        for (const p of lastResult.snapshot_paths) {
          if (!snapshotPaths.includes(p)) snapshotPaths.push(p);
        }
      }

      appendLog(
        `[dart-runner] attempt=${fixAttempts} passed=${lastResult.passed} executor=${lastResult.executor || 'dart'}\n`
      );
      fs.appendFileSync(
        path.join(featLogDir, `${datetime}.log`),
        `[${sc.scenario_id}] dart passed=${lastResult.passed}\n`,
        'utf8'
      );

      if (lastResult.skipped) {
        return finishSkipped({
          sc,
          startedStr,
          scLogPath,
          projectRoot,
          startedAt,
          skip_reason: lastResult.skip_reason || 'mobile_prep_failed',
        });
      }

      if (lastResult.passed || lastResult.timedOut) break;
      if (lastResult.unresolvable) break;

      const transient = /timeout|device|emulator|install|build/i.test(
        String(lastResult.failure_summary || '')
      );
      if (!transient || fixAttempts >= maxFixAttempts) break;
      fixAttempts++;
    }

    const durationMs = Date.now() - startedAt;
    if (lastResult.passed) {
      log.info('ui_scenario_complete', `[ui_e2e] scenario=${sc.scenario_id} 通过（dart）`, {
        scenario_id: sc.scenario_id,
        duration_ms: durationMs,
        snapshot_paths: snapshotPaths,
      });
      return {
        scenario_id: sc.scenario_id,
        feature_id: sc.feature_id,
        platform: sc.platform,
        status: 'completed',
        passed: true,
        started_at: startedStr,
        completed_at: completedStr(),
        duration_ms: durationMs,
        log_path: path.relative(projectRoot, scLogPath),
        snapshot_paths: snapshotPaths,
        failure_summary: null,
        fix_attempts: fixAttempts,
        executor: lastResult.executor || 'dart',
      };
    }

    if (snapshotPaths.length === 0 && !timedOut) {
      const snapName = `fail_${Date.now()}.jpg`;
      const snapPath = path.join(snapDir, snapName);
      try {
        fs.writeFileSync(snapPath, Buffer.alloc(0));
        snapshotPaths.push(path.relative(projectRoot, snapPath));
      } catch (_) {}
    }

    const failureSummary =
      lastResult.failure_summary || lastResult.error || `mobile 场景失败（重试 ${fixAttempts} 次）`;
    log.error('ui_scenario_failed', failureSummary, {
      scenario_id: sc.scenario_id,
      feature_id: sc.feature_id,
      failure_summary: failureSummary,
      log_path: path.relative(projectRoot, scLogPath),
      snapshot_paths: snapshotPaths,
    });

    return {
      scenario_id: sc.scenario_id,
      feature_id: sc.feature_id,
      platform: sc.platform,
      status: timedOut ? 'timed_out' : 'failed',
      passed: false,
      started_at: startedStr,
      completed_at: completedStr(),
      duration_ms: durationMs,
      log_path: path.relative(projectRoot, scLogPath),
      snapshot_paths: snapshotPaths,
      failure_summary: failureSummary,
      timed_out: timedOut,
      fix_attempts: fixAttempts,
      executor: lastResult.executor || 'dart',
    };
  }

  if (!sc.base_url) {
    const msg = 'web 场景缺少 base_url';
    appendLog(`[runner] ERROR ${msg}\n`);
    return finishFailed({
      sc,
      startedStr,
      scLogPath,
      projectRoot,
      startedAt,
      failure_summary: msg,
      snapshot_paths: [],
      fix_attempts: 0,
      log,
    });
  }

  const vars = buildScenarioVars(config, sc.base_url);
  const scenario = { steps: sc.steps || [], expect: sc.expect || [] };
  const driver =
    driverOverride || selectBrowserDriver(config, scenario);

  appendLog(`[runner] browser_driver=${driver}\n`);

  if (driver === 'http' && scenarioNeedsInteractiveSteps(scenario)) {
    const msg =
      '场景含 click/type 等交互步骤，HTTP 驱动无法执行；请安装 playwright 或配置 AI_STD3_BROWSER_MCP_CMD';
    appendLog(`[runner] ERROR ${msg}\n`);
    return finishFailed({
      sc,
      startedStr,
      scLogPath,
      projectRoot,
      startedAt,
      failure_summary: msg,
      snapshot_paths: [],
      fix_attempts: 0,
      log,
    });
  }

  const snapshotPaths = [];
  let fixAttempts = 0;
  let timedOut = false;
  let lastResult = { passed: false, failure_summary: 'unknown' };

  const onStep = ({ step_index, action, duration_ms }) => {
    log.debug('ui_scenario_step', `[ui_e2e] scenario=${sc.scenario_id} step=${step_index} ${action}`, {
      scenario_id: sc.scenario_id,
      step_index,
      action,
      duration_ms,
    });
  };

  async function attemptOnce() {
    if (driver === 'mcp') {
      return runWebScenarioMcp({
        scenario,
        vars,
        substitutePlaceholders,
        appendLog,
        onStep,
        snapDir,
        projectRoot,
      });
    }
    if (driver === 'playwright') {
      return runWebScenarioPlaywright({
        scenario,
        vars,
        substitutePlaceholders,
        appendLog,
        onStep,
        snapDir,
        projectRoot,
      });
    }
    return runWebScenarioHttp({
      scenario,
      vars,
      substitutePlaceholders,
      appendLog,
      onStep,
    });
  }

  while (fixAttempts <= maxFixAttempts) {
    if (fixAttempts > 0) {
      log.warn('ui_scenario_retry', `[ui_e2e] scenario=${sc.scenario_id} 即时重试 #${fixAttempts}`, {
        scenario_id: sc.scenario_id,
        attempt: fixAttempts,
        reason: lastResult.failure_summary || lastResult.error || 'retry',
      });
    }

    const execPromise = attemptOnce();
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve({
          passed: false,
          timedOut: true,
          failure_summary: `场景超时（${scenarioTimeoutMs}ms）`,
        });
      }, scenarioTimeoutMs + 500)
    );

    lastResult = await Promise.race([execPromise, timeoutPromise]);

    if (Array.isArray(lastResult.snapshot_paths)) {
      for (const p of lastResult.snapshot_paths) {
        if (!snapshotPaths.includes(p)) snapshotPaths.push(p);
      }
    }

    appendLog(
      `[runner] attempt=${fixAttempts} passed=${lastResult.passed} executor=${lastResult.executor || driver} error=${lastResult.error || lastResult.failure_summary || ''}\n`
    );
    fs.appendFileSync(
      path.join(featLogDir, `${datetime}.log`),
      `[${sc.scenario_id}] runner driver=${driver} passed=${lastResult.passed}\n`,
      'utf8'
    );

    if (lastResult.passed || lastResult.timedOut) break;

    const transient =
      /timeout|tab|ECONNREFUSED|net::|Target closed/i.test(
        String(lastResult.error || lastResult.failure_summary || '')
      );
    if (!transient || fixAttempts >= maxFixAttempts) break;
    fixAttempts++;
  }

  const durationMs = Date.now() - startedAt;

  if (lastResult.passed) {
    log.info('ui_scenario_complete', `[ui_e2e] scenario=${sc.scenario_id} 通过，耗时 ${durationMs}ms`, {
      scenario_id: sc.scenario_id,
      duration_ms: durationMs,
      snapshot_paths: snapshotPaths,
    });
    return {
      scenario_id: sc.scenario_id,
      feature_id: sc.feature_id,
      platform: sc.platform,
      status: 'completed',
      passed: true,
      started_at: startedStr,
      completed_at: completedStr(),
      duration_ms: durationMs,
      log_path: path.relative(projectRoot, scLogPath),
      snapshot_paths: snapshotPaths,
      failure_summary: null,
      fix_attempts: fixAttempts,
      executor: lastResult.executor || driver,
    };
  }

  if (snapshotPaths.length === 0 && !timedOut) {
    const snapName = `fail_${Date.now()}.jpg`;
    const snapPath = path.join(snapDir, snapName);
    try {
      fs.writeFileSync(snapPath, Buffer.alloc(0));
      snapshotPaths.push(path.relative(projectRoot, snapPath));
      log.info('ui_scenario_snapshot', `[ui_e2e] scenario=${sc.scenario_id} 截图占位`, {
        scenario_id: sc.scenario_id,
        path: snapshotPaths[snapshotPaths.length - 1],
        step_index: -1,
      });
    } catch (_) {}
  }

  const failureSummary =
    lastResult.failure_summary || lastResult.error || `场景执行失败（重试 ${fixAttempts} 次）`;
  log.error(
    'ui_scenario_failed',
    `[ui_e2e] scenario=${sc.scenario_id} platform=${sc.platform} 失败：${failureSummary}`,
    {
      scenario_id: sc.scenario_id,
      feature_id: sc.feature_id,
      failure_summary: failureSummary,
      log_path: path.relative(projectRoot, scLogPath),
      snapshot_paths: snapshotPaths,
    }
  );

  return {
    scenario_id: sc.scenario_id,
    feature_id: sc.feature_id,
    platform: sc.platform,
    status: timedOut ? 'timed_out' : 'failed',
    passed: false,
    started_at: startedStr,
    completed_at: completedStr(),
    duration_ms: durationMs,
    log_path: path.relative(projectRoot, scLogPath),
    snapshot_paths: snapshotPaths,
    failure_summary: failureSummary,
    timed_out: timedOut,
    fix_attempts: fixAttempts,
    executor: lastResult.executor || driver,
  };
}

function finishSkipped({ sc, startedStr, scLogPath, projectRoot, startedAt, skip_reason }) {
  return {
    scenario_id: sc.scenario_id,
    feature_id: sc.feature_id,
    platform: sc.platform,
    status: 'skipped',
    passed: false,
    started_at: startedStr,
    completed_at: startedStr,
    duration_ms: Date.now() - startedAt,
    log_path: path.relative(projectRoot, scLogPath),
    snapshot_paths: [],
    failure_summary: null,
    skip_reason,
    fix_attempts: 0,
  };
}

function finishFailed({
  sc,
  startedStr,
  scLogPath,
  projectRoot,
  startedAt,
  failure_summary,
  snapshot_paths,
  fix_attempts,
  log,
}) {
  if (log) {
    log.error('ui_scenario_failed', failure_summary, {
      scenario_id: sc.scenario_id,
      feature_id: sc.feature_id,
      failure_summary,
      log_path: path.relative(projectRoot, scLogPath),
      snapshot_paths,
    });
  }
  return {
    scenario_id: sc.scenario_id,
    feature_id: sc.feature_id,
    platform: sc.platform,
    status: 'failed',
    passed: false,
    started_at: startedStr,
    completed_at: startedStr,
    duration_ms: Date.now() - startedAt,
    log_path: path.relative(projectRoot, scLogPath),
    snapshot_paths,
    failure_summary,
    fix_attempts,
  };
}

module.exports = {
  runScenarioWithRunner,
  preflightBrowser,
  preflightDart,
  selectBrowserDriver,
  resetMobileSessions,
};

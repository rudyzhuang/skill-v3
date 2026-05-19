'use strict';

/**
 * Mobile Dart runner — Flutter CLI 实现与 user-dart MCP 同构的场景语义
 * （设备/构建/单场景 integration_test / 深链 navigate / expect 判定）
 */

const fs = require('fs');
const path = require('path');
const { substitutePlaceholders } = require('./ui-e2e-placeholders.cjs');
const { evaluateWebExpects, scenarioNeedsInteractiveSteps } = require('./ui-e2e-expect.cjs');
const { runWithTimeout } = require('./run-with-timeout.cjs');
const {
  BLOCKER_ENV,
  mobileRoot,
  prepareMobileSession,
  runIntegrationTestFile,
  runSmokeLaunch,
  mobileCfg,
} = require('./ui-e2e-mobile-device.cjs');

/** @type {Map<string, Promise<object>>} */
const sessionByPlatform = new Map();

function resetMobileSessions() {
  sessionByPlatform.clear();
}

function sessionKey(projectRoot, platform) {
  return `${projectRoot}::${platform}`;
}

async function getMobileSession(projectRoot, platform, config) {
  const key = sessionKey(projectRoot, platform);
  if (!sessionByPlatform.has(key)) {
    sessionByPlatform.set(key, prepareMobileSession(projectRoot, platform, config));
  }
  return sessionByPlatform.get(key);
}

function findIntegrationTestRel(mobileDir, scenarioId) {
  const candidates = [
    `integration_test/${scenarioId}_test.dart`,
    `integration_test/${scenarioId}.dart`,
    `integration_test/scenarios/${scenarioId}_test.dart`,
    `integration_test/scenarios/${scenarioId}.dart`,
  ];
  for (const rel of candidates) {
    if (fs.existsSync(path.join(mobileDir, rel))) return rel;
  }
  return null;
}

async function mobileNavigate(platform, deviceId, url) {
  const u = String(url || '').trim();
  if (!u) return { ok: true };
  if (platform === 'android') {
    const r = await runWithTimeout(
      'adb',
      ['-s', deviceId, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', u],
      { timeoutMs: 30000 }
    );
    return { ok: !r.timedOut && r.code === 0, error: r.stderr || r.stdout };
  }
  if (platform === 'ios') {
    const r = await runWithTimeout('xcrun', ['simctl', 'openurl', deviceId, u], { timeoutMs: 30000 });
    return { ok: !r.timedOut && r.code === 0, error: r.stderr || r.stdout };
  }
  return { ok: false, error: `不支持的平台 navigate: ${platform}` };
}

async function captureMobileScreenshot(platform, deviceId, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (platform === 'android') {
    const remote = '/sdcard/ui_e2e_cap.png';
    await runWithTimeout('adb', ['-s', deviceId, 'shell', 'screencap', '-p', remote], {
      timeoutMs: 30000,
    });
    const pull = await runWithTimeout('adb', ['-s', deviceId, 'pull', remote, outPath], {
      timeoutMs: 60000,
    });
    return pull.code === 0 && fs.existsSync(outPath);
  }
  if (platform === 'ios') {
    const r = await runWithTimeout('xcrun', ['simctl', 'io', deviceId, 'screenshot', outPath], {
      timeoutMs: 30000,
    });
    return !r.timedOut && r.code === 0 && fs.existsSync(outPath);
  }
  return false;
}

/**
 * @param {object} opts
 */
async function runMobileScenarioWithRunner(opts) {
  const {
    projectRoot,
    sc,
    config,
    vars,
    appendLog,
    onStep,
    snapDir,
    scenarioTimeoutMs,
  } = opts;

  const platform = sc.platform === 'ios' ? 'ios' : 'android';
  const t0 = Date.now();
  const snapshotPaths = [];
  const scenario = { steps: sc.steps || [], expect: sc.expect || [] };

  appendLog(`[dart-runner] platform=${platform} scenario=${sc.scenario_id}\n`);

  const session = await getMobileSession(projectRoot, platform, config);
  if (!session.ok) {
    const unres = session.unresolvable || session.blocker === BLOCKER_ENV;
    return {
      passed: false,
      skipped: unres ? false : true,
      skip_reason: unres ? 'mobile_env_unsatisfied' : 'mobile_prep_failed',
      failure_summary: session.error || 'mobile 环境准备失败',
      duration_ms: Date.now() - t0,
      executor: 'dart',
      snapshot_paths: snapshotPaths,
      unresolvable: !!unres,
    };
  }

  const { deviceId, mobileDir } = session;
  appendLog(`[dart-runner] device=${deviceId} mobileDir=${mobileDir}\n`);

  const testRel = findIntegrationTestRel(mobileDir, sc.scenario_id);
  const needsInteractive = scenarioNeedsInteractiveSteps(scenario);
  const hasExpects = (scenario.expect || []).length > 0;
  let haystack = '';
  let lastUrl = '';

  if (hasExpects && !testRel && !needsInteractive) {
    return {
      passed: false,
      failure_summary:
        `mobile 场景含 expect[] 须提供 integration_test/${sc.scenario_id}_test.dart（或在测试内断言）`,
      duration_ms: Date.now() - t0,
      executor: 'dart',
      snapshot_paths: snapshotPaths,
      step_failed: 'missing_integration_test',
    };
  }

  if (testRel) {
    appendLog(`[dart-runner] integration_test ${testRel}\n`);
    const tr = await runIntegrationTestFile(mobileDir, deviceId, testRel);
    haystack = tr.output || '';
    appendLog(haystack.slice(-4000) + '\n');
    if (!tr.ok) {
      await maybeScreenshot(platform, deviceId, snapDir, projectRoot, snapshotPaths);
      return {
        passed: false,
        failure_summary: tr.error || 'integration_test 失败',
        duration_ms: Date.now() - t0,
        executor: 'dart_integration_test',
        snapshot_paths: snapshotPaths,
        step_failed: 'integration_test',
      };
    }
    if (onStep) onStep({ step_index: 0, action: 'integration_test', duration_ms: Date.now() - t0 });
  } else if (needsInteractive) {
    return {
      passed: false,
      failure_summary:
        `场景含交互步骤但缺少 integration_test/${sc.scenario_id}_test.dart；请添加对应测试或启用 --use-sdk-scenarios`,
      duration_ms: Date.now() - t0,
      executor: 'dart',
      snapshot_paths: snapshotPaths,
      step_failed: 'missing_integration_test',
    };
  } else {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const act = String(step.action || '').toLowerCase();
      const stepStart = Date.now();

      if (act === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(step.timeout_ms || 1000, 60000)));
      } else if (act === 'navigate') {
        const url = substitutePlaceholders(step.url || '', vars);
        appendLog(`[step ${i}] navigate ${url}\n`);
        const nav = await mobileNavigate(platform, deviceId, url);
        if (!nav.ok) {
          await maybeScreenshot(platform, deviceId, snapDir, projectRoot, snapshotPaths);
          return {
            passed: false,
            failure_summary: `step ${i} navigate: ${String(nav.error || 'failed').slice(0, 300)}`,
            duration_ms: Date.now() - t0,
            executor: 'dart',
            snapshot_paths: snapshotPaths,
            step_failed: act,
            step_index: i,
          };
        }
        lastUrl = url;
      } else if (act === 'snapshot') {
        await maybeScreenshot(platform, deviceId, snapDir, projectRoot, snapshotPaths, `${i}`);
      } else {
        return {
          passed: false,
          failure_summary: `无 integration_test 时 Dart runner 不支持 action=${act}`,
          duration_ms: Date.now() - t0,
          executor: 'dart',
          snapshot_paths: snapshotPaths,
          step_failed: act,
          step_index: i,
        };
      }
      if (onStep) onStep({ step_index: i, action: act, duration_ms: Date.now() - stepStart });
    }

    if (scenario.steps.length === 0 && !hasExpects) {
      const mc = mobileCfg(config, platform);
      const smoke = await runSmokeLaunch(mobileDir, deviceId, mc.smokeRunS);
      if (!smoke.ok) {
        return {
          passed: false,
          failure_summary: smoke.error || 'smoke_run 失败',
          duration_ms: Date.now() - t0,
          executor: 'dart_smoke',
          snapshot_paths: snapshotPaths,
        };
      }
    }
  }

  const ev = evaluateWebExpects(scenario, { lastUrl, body: haystack, pageText: haystack });
  if (!ev.passed) {
    await maybeScreenshot(platform, deviceId, snapDir, projectRoot, snapshotPaths);
    return {
      passed: false,
      failure_summary: ev.error,
      duration_ms: Date.now() - t0,
      executor: testRel ? 'dart_integration_test' : 'dart',
      snapshot_paths: snapshotPaths,
      step_failed: 'expect',
    };
  }

  if (Date.now() - t0 > scenarioTimeoutMs) {
    return {
      passed: false,
      timedOut: true,
      failure_summary: `场景超时（${scenarioTimeoutMs}ms）`,
      duration_ms: Date.now() - t0,
      executor: 'dart',
      snapshot_paths: snapshotPaths,
    };
  }

  return {
    passed: true,
    duration_ms: Date.now() - t0,
    executor: testRel ? 'dart_integration_test' : 'dart',
    snapshot_paths: snapshotPaths,
  };
}

async function maybeScreenshot(platform, deviceId, snapDir, projectRoot, snapshotPaths, suffix = 'fail') {
  const fname = `${suffix}_${Date.now()}.jpg`;
  const abs = path.join(snapDir, fname);
  const ok = await captureMobileScreenshot(platform, deviceId, abs);
  if (ok) snapshotPaths.push(path.relative(projectRoot, abs));
}

module.exports = {
  resetMobileSessions,
  findIntegrationTestRel,
  runMobileScenarioWithRunner,
  mobileRoot,
};

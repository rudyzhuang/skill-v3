'use strict';

const fs = require('fs');
const path = require('path');
const { loadPlaywright } = require('./ui-e2e-browser-playwright.cjs');
const { isMcpBridgeConfigured, probeMcpBridge } = require('./ui-e2e-browser-mcp.cjs');
const { scenarioNeedsInteractiveSteps } = require('./ui-e2e-expect.cjs');
const { runWithTimeout } = require('./run-with-timeout.cjs');
const { mobileRoot } = require('./ui-e2e-mobile-device.cjs');

/**
 * 选择 web 浏览器驱动：mcp | playwright | http
 */
function selectBrowserDriver(config, sampleScenario) {
  const runnerCfg = (config.ui_e2e && config.ui_e2e.runner) || {};
  const forced = String(
    process.env.UI_E2E_BROWSER_DRIVER ||
      runnerCfg.browser_driver ||
      ''
  ).toLowerCase();

  if (forced === 'mcp' || forced === 'playwright' || forced === 'http') {
    return forced;
  }

  if (loadPlaywright()) return 'playwright';

  const needsInteractive = sampleScenario && scenarioNeedsInteractiveSteps(sampleScenario);
  if (!needsInteractive) return 'http';

  return 'http';
}

async function preflightBrowser(config, sampleScenario) {
  const driver = selectBrowserDriver(config, sampleScenario);

  if (driver === 'mcp') {
    const probe = await probeMcpBridge();
    return {
      mcp: 'browser',
      ok: probe.available,
      driver: 'mcp',
      reason: probe.reason,
    };
  }

  if (driver === 'playwright') {
    const pw = loadPlaywright();
    return {
      mcp: 'browser',
      ok: !!pw,
      driver: 'playwright',
      reason: pw ? 'playwright chromium 可用' : 'playwright 未安装',
    };
  }

  return {
    mcp: 'browser',
    ok: true,
    driver: 'http',
    reason: 'HTTP 驱动（navigate + expect）',
  };
}

/**
 * Dart / Flutter mobile 预检
 * @param {object} config
 * @param {string} [projectRoot]
 */
async function preflightDart(config, projectRoot) {
  const strict = config?.ui_e2e?.strict_mobile === true;

  if (
    process.env.AI_STD4_DART_MCP_READY === '1' ||
    process.env.UI_E2E_DART_MCP_READY === '1'
  ) {
    return { mcp: 'dart', ok: true, driver: 'flutter_cli', reason: 'Dart 环境已标记就绪' };
  }

  if (!projectRoot) {
    return {
      mcp: 'dart',
      ok: !strict,
      driver: null,
      reason: '未提供 projectRoot，无法校验 src/mobile',
    };
  }

  const root = mobileRoot(projectRoot);
  if (!fs.existsSync(path.join(root, 'pubspec.yaml'))) {
    return {
      mcp: 'dart',
      ok: !strict,
      driver: null,
      reason: '缺少 src/mobile/pubspec.yaml',
    };
  }

  const ver = await runWithTimeout('flutter', ['--version'], { timeoutMs: 30000 });
  if (ver.timedOut || ver.code !== 0) {
    return {
      mcp: 'dart',
      ok: !strict,
      driver: null,
      reason: 'Flutter SDK 不可用（flutter 不在 PATH）',
    };
  }

  return {
    mcp: 'dart',
    ok: true,
    driver: 'flutter_cli',
    reason: 'Flutter SDK + src/mobile 就绪',
  };
}

module.exports = {
  selectBrowserDriver,
  preflightBrowser,
  preflightDart,
};

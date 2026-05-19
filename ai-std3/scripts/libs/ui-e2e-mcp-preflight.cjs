'use strict';

const { loadPlaywright } = require('./ui-e2e-browser-playwright.cjs');
const { isMcpBridgeConfigured, probeMcpBridge } = require('./ui-e2e-browser-mcp.cjs');
const { scenarioNeedsInteractiveSteps } = require('./ui-e2e-expect.cjs');

/**
 * 选择 web 浏览器驱动：mcp | playwright | http
 * @param {object} config
 * @param {object} [sampleScenario] 用于判断是否需要交互步骤
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

  // stdio MCP 步骤映射尚未完整实现，暂不参与自动选择
  if (loadPlaywright()) return 'playwright';

  const needsInteractive = sampleScenario && scenarioNeedsInteractiveSteps(sampleScenario);
  if (!needsInteractive) return 'http';

  return 'http';
}

/**
 * @returns {Promise<{ mcp: string, ok: boolean, driver?: string, reason: string }>}
 */
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

function preflightDart(config) {
  const strict = config.ui_e2e?.strict_mobile === true;
  const dartOk =
    process.env.AI_STD3_DART_MCP_READY === '1' ||
    process.env.UI_E2E_DART_MCP_READY === '1';

  if (dartOk) {
    return { mcp: 'dart', ok: true, reason: 'Dart MCP 已标记就绪' };
  }

  return {
    mcp: 'dart',
    ok: !strict,
    reason: strict
      ? 'Dart MCP / 模拟器未就绪（strict_mobile=true）'
      : 'Dart MCP 未配置，mobile 场景将 skipped',
  };
}

module.exports = {
  selectBrowserDriver,
  preflightBrowser,
  preflightDart,
};

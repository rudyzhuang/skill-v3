'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateWebExpects } = require('./ui-e2e-expect.cjs');

function loadPlaywright() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    return require('playwright');
  } catch (_) {
    return null;
  }
}

async function resolveLocator(page, selectorHint) {
  const hint = String(selectorHint || '').trim();
  if (!hint) throw new Error('selector_hint 为空');
  const byRole = page.getByRole('button', { name: hint });
  if ((await byRole.count()) > 0) return byRole.first();
  const byText = page.getByText(hint, { exact: false });
  if ((await byText.count()) > 0) return byText.first();
  const byLabel = page.getByLabel(hint);
  if ((await byLabel.count()) > 0) return byLabel.first();
  const byPlaceholder = page.getByPlaceholder(hint);
  if ((await byPlaceholder.count()) > 0) return byPlaceholder.first();
  throw new Error(`无法定位元素: ${hint}`);
}

/**
 * Playwright 驱动：实现与 Browser MCP 同构的步骤语义
 */
async function runWebScenarioPlaywright({
  scenario,
  vars,
  substitutePlaceholders,
  appendLog,
  onStep,
  snapDir,
  projectRoot,
}) {
  const pw = loadPlaywright();
  if (!pw) {
    return {
      passed: false,
      duration_ms: 0,
      error: 'playwright 未安装（npm i playwright -D）',
      step_failed: 'preflight',
      executor: 'playwright',
    };
  }

  const t0 = Date.now();
  const snapshotPaths = [];
  let browser;
  let page;
  let lastUrl = '';

  try {
    browser = await pw.chromium.launch({
      headless: process.env.UI_E2E_HEADLESS !== '0',
    });
    const context = await browser.newContext();
    page = await context.newPage();

    for (let i = 0; i < (scenario.steps || []).length; i++) {
      const step = scenario.steps[i];
      const act = String(step.action || '').toLowerCase();
      const stepStart = Date.now();

      if (act === 'navigate') {
        const url = substitutePlaceholders(step.url || '', vars);
        appendLog(`[step ${i}] navigate ${url}\n`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: step.timeout_ms || 30000 });
        lastUrl = page.url();
      } else if (act === 'click') {
        const loc = await resolveLocator(page, step.selector_hint);
        appendLog(`[step ${i}] click "${step.selector_hint}"\n`);
        await loc.click({ timeout: step.timeout_ms || 15000 });
      } else if (act === 'type') {
        const loc = await resolveLocator(page, step.selector_hint);
        const val = substitutePlaceholders(step.value || '', vars);
        appendLog(`[step ${i}] type "${step.selector_hint}"\n`);
        await loc.fill(val, { timeout: step.timeout_ms || 15000 });
      } else if (act === 'hover') {
        const loc = await resolveLocator(page, step.selector_hint);
        await loc.hover({ timeout: step.timeout_ms || 15000 });
      } else if (act === 'select') {
        const loc = await resolveLocator(page, step.selector_hint);
        await loc.selectOption(substitutePlaceholders(step.value || '', vars));
      } else if (act === 'wait') {
        await page.waitForTimeout(Math.min(step.timeout_ms || 1000, 60000));
      } else if (act === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded' });
        lastUrl = page.url();
      } else if (act === 'snapshot') {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const fname = `${ts}_${i}.jpg`;
        const abs = path.join(snapDir, fname);
        fs.mkdirSync(snapDir, { recursive: true });
        await page.screenshot({ path: abs, type: 'jpeg', fullPage: true });
        snapshotPaths.push(path.relative(projectRoot, abs));
        appendLog(`[step ${i}] snapshot ${fname}\n`);
      } else {
        return {
          passed: false,
          duration_ms: Date.now() - t0,
          error: `未知步骤 action=${act}`,
          step_failed: act,
          step_index: i,
          executor: 'playwright',
          snapshot_paths: snapshotPaths,
        };
      }

      if (onStep) onStep({ step_index: i, action: act, duration_ms: Date.now() - stepStart });
    }

    lastUrl = page.url();
    const pageText = await page.evaluate(() => document.body?.innerText || '');
    const body = await page.content();

    const ev = evaluateWebExpects(scenario, { lastUrl, body, pageText });
    if (!ev.passed) {
      const failSnap = path.join(snapDir, `fail_${Date.now()}.jpg`);
      fs.mkdirSync(snapDir, { recursive: true });
      try {
        await page.screenshot({ path: failSnap, type: 'jpeg', fullPage: true });
        snapshotPaths.push(path.relative(projectRoot, failSnap));
      } catch (_) {}

      return {
        passed: false,
        duration_ms: Date.now() - t0,
        error: ev.error,
        failure_summary: ev.error,
        step_failed: 'expect',
        executor: 'playwright',
        snapshot_paths: snapshotPaths,
        expect_detail: ev,
      };
    }

    return {
      passed: true,
      duration_ms: Date.now() - t0,
      error: '',
      step_failed: null,
      executor: 'playwright',
      snapshot_paths: snapshotPaths,
      lastUrl,
    };
  } catch (e) {
    if (page && snapDir) {
      try {
        const failSnap = path.join(snapDir, `error_${Date.now()}.jpg`);
        fs.mkdirSync(snapDir, { recursive: true });
        await page.screenshot({ path: failSnap, type: 'jpeg', fullPage: true });
        snapshotPaths.push(path.relative(projectRoot, failSnap));
      } catch (_) {}
    }
    return {
      passed: false,
      duration_ms: Date.now() - t0,
      error: e.message || String(e),
      failure_summary: e.message || String(e),
      step_failed: 'execution',
      executor: 'playwright',
      snapshot_paths: snapshotPaths,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  loadPlaywright,
  runWebScenarioPlaywright,
};

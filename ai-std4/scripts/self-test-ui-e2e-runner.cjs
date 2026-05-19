'use strict';

/**
 * ui-e2e-runner 自测（无网络 / 无 playwright 亦可跑大部分用例）
 */

const assert = require('assert');
const { substitutePlaceholders, buildScenarioVars } = require('./libs/ui-e2e-placeholders.cjs');
const { evaluateWebExpects, scenarioNeedsInteractiveSteps } = require('./libs/ui-e2e-expect.cjs');
const { selectBrowserDriver, preflightBrowser, preflightDart } = require('./libs/ui-e2e-mcp-preflight.cjs');
const { runWebScenarioHttp } = require('./libs/ui-e2e-browser-http.cjs');
const { findIntegrationTestRel } = require('./libs/ui-e2e-dart-runner.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

console.log('self-test-ui-e2e-runner.cjs\n');

test('substitutePlaceholders', () => {
  const out = substitutePlaceholders('{base_url}/login?u={test_user}', {
    base_url: 'https://example.com',
    test_user: 'alice',
  });
  assert.strictEqual(out, 'https://example.com/login?u=alice');
});

test('buildScenarioVars', () => {
  const v = buildScenarioVars({ ui_e2e: { test_credentials: { test_user: 'u1' } } }, 'https://x');
  assert.strictEqual(v.base_url, 'https://x');
  assert.strictEqual(v.test_user, 'u1');
});

test('evaluateWebExpects url_contains', () => {
  const r = evaluateWebExpects(
    { expect: [{ type: 'url_contains', value: '/dash' }] },
    { lastUrl: 'https://a.com/dash', body: '' }
  );
  assert.strictEqual(r.passed, true);
});

test('evaluateWebExpects text_present fail', () => {
  const r = evaluateWebExpects(
    { expect: [{ type: 'text_present', value: 'NOTHERE' }] },
    { lastUrl: '', body: '<html>hi</html>' }
  );
  assert.strictEqual(r.passed, false);
  assert.ok(r.error.includes('text_present'));
});

test('scenarioNeedsInteractiveSteps', () => {
  assert.strictEqual(
    scenarioNeedsInteractiveSteps({ steps: [{ action: 'navigate', url: 'x' }] }),
    false
  );
  assert.strictEqual(
    scenarioNeedsInteractiveSteps({ steps: [{ action: 'click', selector_hint: 'OK' }] }),
    true
  );
});

test('selectBrowserDriver http for navigate-only', () => {
  const drv = selectBrowserDriver({}, { steps: [{ action: 'navigate', url: '{base_url}' }] });
  assert.strictEqual(drv, 'http');
});

(async () => {
  await testAsync('preflightBrowser returns ok for http', async () => {
    const pf = await preflightBrowser({}, { steps: [{ action: 'navigate' }] });
    assert.strictEqual(pf.ok, true);
    assert.strictEqual(pf.driver, 'http');
  });

  await testAsync('findIntegrationTestRel discovers scenario test file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-e2e-'));
    const mobileDir = path.join(tmp, 'src', 'mobile');
    fs.mkdirSync(path.join(mobileDir, 'integration_test'), { recursive: true });
    fs.writeFileSync(path.join(mobileDir, 'integration_test', 'FEAT-001-smoke-001_test.dart'), '// t');
    const rel = findIntegrationTestRel(mobileDir, 'FEAT-001-smoke-001');
    assert.strictEqual(rel, 'integration_test/FEAT-001-smoke-001_test.dart');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await testAsync('preflightDart without mobile dir is ok when not strict', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-e2e-'));
    const pf = await preflightDart({ ui_e2e: { strict_mobile: false } }, tmp);
    assert.strictEqual(pf.ok, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await testAsync('runWebScenarioHttp rejects click without playwright', async () => {
    const r = await runWebScenarioHttp({
      scenario: {
        steps: [{ action: 'click', selector_hint: 'Submit' }],
        expect: [{ type: 'text_present', value: 'x' }],
      },
      vars: { base_url: 'https://example.com' },
      substitutePlaceholders,
      appendLog: () => {},
    });
    assert.strictEqual(r.passed, false);
    assert.ok(/不支持交互/.test(r.error));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();

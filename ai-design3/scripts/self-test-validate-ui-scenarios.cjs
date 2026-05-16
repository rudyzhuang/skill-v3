'use strict';

const assert = require('assert');
const { validateUiScenariosDocument } = require('./lib/validate-test-spec-ui.cjs');

const bad = validateUiScenariosDocument({
  required_test_levels: ['ui_e2e'],
  ui_scenarios: [],
});
assert.strictEqual(bad.ok, false);

const good = validateUiScenariosDocument({
  ui_scenarios: [
    {
      id: 'x1',
      client_target: 'admin',
      platform: 'web',
      steps: [{ action: 'navigate', url: '/' }],
      expect: [{ type: 'text_present', value: 'ok' }],
    },
  ],
});
assert.strictEqual(good.ok, true);

console.error('ai-design3 self-test-validate-ui-scenarios: ok');

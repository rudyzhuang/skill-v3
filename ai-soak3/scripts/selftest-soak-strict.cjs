#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isSoakStrict,
  buildSoakAutorunPlan,
  shouldForceRerunStage,
} = require('./lib/soak-strict.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soak-strict-'));
}

function testStrictEnv() {
  delete process.env.AI_SOAK3_STRICT;
  assert.strictEqual(isSoakStrict(), false);
  process.env.AI_SOAK3_STRICT = '1';
  assert.strictEqual(isSoakStrict(), true);
  delete process.env.AI_SOAK3_STRICT;
}

function testDriftPlan() {
  const root = tmpDir();
  const reports = path.join(root, '.pipeline', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(
    path.join(reports, 'raw-input-drift.json'),
    JSON.stringify({
      feature_impacts: [{ type: 'I', feature_ids: ['MOB-001'] }],
      run_feature_ids: ['MOB-001'],
      impacted_feature_ids: ['MOB-001'],
      config_only: false,
    }),
    'utf8'
  );
  process.env.AI_SOAK3_STRICT = '1';
  const plan = buildSoakAutorunPlan(root);
  assert(plan.strict);
  assert(plan.forceRerunStages.includes('codegen'));
  assert(plan.scopedFeatureIds.includes('MOB-001'));
  assert.strictEqual(plan.blockReason, null);
  delete process.env.AI_SOAK3_STRICT;
}

function testForceRerun() {
  assert(shouldForceRerunStage('smoke', null, ['deploy', 'smoke']));
  assert(!shouldForceRerunStage('design', null, ['codegen']));
}

function main() {
  testStrictEnv();
  testDriftPlan();
  testForceRerun();
  console.error('selftest-soak-strict: OK');
}

main();

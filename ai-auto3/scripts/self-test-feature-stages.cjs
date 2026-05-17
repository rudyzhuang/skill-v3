#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const featureStages = require('./lib/feature-stages.cjs');

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-feat-stages-'));
const stagesPath = path.join(tmp, '.pipeline', 'stages.json');
fs.mkdirSync(path.dirname(stagesPath), { recursive: true });

const baseDoc = {
  stages: {
    prd: { status: 'completed', validation: { passed: true } },
    prd_review: {
      status: 'completed',
      validation: { passed: true },
      review: { phase_plan: [{ phase: 'mvp', feature_ids: ['F-A', 'F-B'] }] },
    },
    design: {
      status: 'not_started',
      outputs: {
        design_specs: [{ feature_id: 'F-A', status: 'approved', path: 'docs/designs/F-A.design.json' }],
      },
    },
  },
};

fs.writeFileSync(stagesPath, JSON.stringify(baseDoc, null, 2));

let doc = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
doc = featureStages.backfillFeatureStages(doc);
const rowA = featureStages.getFeatureStageRow(doc, 'design', 'F-A');
assert(rowA && rowA.status === 'completed', `backfill F-A design expected completed, got ${rowA?.status}`);

const begun = featureStages.beginStageForFeatures(doc, {
  stageKey: 'contract',
  featureIds: ['F-A', 'F-B'],
  skill: 'ai-design3',
  message: 'test contract begin',
});
doc = begun.doc;
assert(begun.marked.includes('F-A'), 'F-A should enter contract (design done)');
assert(begun.skipped.includes('F-B'), 'F-B should skip contract until design done');

const runA = featureStages.getFeatureStageRow(doc, 'contract', 'F-A');
assert(runA?.status === 'running', `F-A contract expected running, got ${runA?.status}`);

doc = featureStages.markFeatureStage(doc, 'contract', 'F-A', 'completed', { message: 'ok' });
assert(
  featureStages.isFeatureStageCompleted(doc, 'contract', 'F-A'),
  'F-A contract should be completed'
);

const begun2 = featureStages.beginStageForFeatures(doc, {
  stageKey: 'contract',
  featureIds: ['F-B'],
  skill: 'ai-design3',
});
doc = begun2.doc;
assert(begun2.marked.includes('F-B') === false, 'F-B still blocked without design');

featureStages.appendStageLog(tmp, {
  skill: 'test',
  sessionId: 'selftest',
  stageKey: 'contract',
  message: '日志可读性自检',
});
const logPath = path.join(tmp, '.agent-sessions', 'selftest.log');
assert(fs.existsSync(logPath), 'appendStageLog should create session log');
const logText = fs.readFileSync(logPath, 'utf8');
assert(logText.includes('日志可读性自检'), 'log should contain human message');

doc = featureStages.markFeatureStage(doc, 'codegen', 'F-A', 'completed', { message: 'done' });
doc = featureStages.upsertPerFeature(doc, 'typecheck', 'F-A', {
  status: 'running',
  started_at: new Date().toISOString(),
  message: 'typecheck running',
});
assert(
  featureStages.anyFeatureStageRunning(doc, 'F-A'),
  'anyFeatureStageRunning should see typecheck running'
);
doc = featureStages.markFeatureStage(doc, 'typecheck', 'F-A', 'completed', { message: 'ok' });
assert(
  !featureStages.anyFeatureStageRunning(doc, 'F-A'),
  'anyFeatureStageRunning must be false when all per-feature stages are completed'
);

console.log('self-test-feature-stages: OK');

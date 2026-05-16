#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildFeatureBoard,
  isFeatureCodegenDone,
  filterRemainingCodegenQueue,
} = require('./lib/features.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dash3-features-'));
const wtDir = path.join(root, '.pipeline', 'worktrees', 'v3-fc-F-A');
fs.mkdirSync(wtDir, { recursive: true });
fs.writeFileSync(path.join(wtDir, 'package.json'), '{}', 'utf8');
fs.mkdirSync(path.join(root, 'docs', 'designs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'designs', 'F-A.design.json'), '{}', 'utf8');
fs.writeFileSync(path.join(root, 'docs', 'designs', 'F-B.design.json'), '{}', 'utf8');

const doc = {
  stages: {
    prd_review: {
      review: {
        phase_plan: [{ phase: 'mvp', feature_ids: ['F-A', 'F-B'] }],
      },
    },
    codegen: { status: 'running', outputs: { worktrees: [] } },
  },
};

const runtime = {
  pending_features_json: JSON.stringify(['F-A', 'F-B']),
  current_phase: 'mvp',
  current_stage: 'codegen',
};

const board = buildFeatureBoard(doc, root, runtime, { alive: true });
const byId = Object.fromEntries(board.features.map((f) => [f.feature_id, f]));

assert(byId['F-A'].pipeline_status === 'completed', `F-A expected completed, got ${byId['F-A'].pipeline_status}`);
assert(byId['F-B'].pipeline_status === 'in_progress', `F-B expected in_progress (active codegen), got ${byId['F-B'].pipeline_status}`);
assert(byId['F-B'].hints.includes('active_codegen_feature'), 'F-B should be active_codegen_feature');
assert(byId['F-B'].pipeline_stage_label, 'F-B should have pipeline_stage_label');
assert(typeof byId['F-B'].stage_elapsed_ms === 'number' || byId['F-B'].stage_elapsed_ms === null);

assert(isFeatureCodegenDone(root, 'F-A'), 'F-A codegen done');
assert(!isFeatureCodegenDone(root, 'F-B'), 'F-B codegen not done');
assert(
  filterRemainingCodegenQueue(root, ['F-A', 'F-B']).join(',') === 'F-B',
  'remaining queue should be F-B only'
);

console.log('ai-dash3 self-test-features: ok');

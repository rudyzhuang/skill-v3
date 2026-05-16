#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildFeatureBoard,
  isFeatureCodegenDone,
  isScaffoldOnlyWorktree,
  filterRemainingCodegenQueue,
  sortFeaturesByPriority,
  buildPhaseOrderIndex,
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
    codegen: {
      status: 'running',
      outputs: {
        worktrees: [
          {
            feature_id: 'F-A',
            commit: 'abc123def',
            files_changed: ['src/a.ts'],
            test_files_changed: [],
          },
        ],
      },
    },
  },
};

const runtime = {
  pending_features_json: JSON.stringify(['F-A', 'F-B']),
  current_phase: 'mvp',
  current_stage: 'codegen',
};

const board = buildFeatureBoard(doc, root, runtime, { alive: true });
const byId = Object.fromEntries(board.features.map((f) => [f.feature_id, f]));

assert(
  byId['F-A'].pipeline_status === 'pending',
  `F-A expected pending (codegen done, test not run), got ${byId['F-A'].pipeline_status}`
);
assert(
  byId['F-A'].pipeline_stage_label.includes('待 test'),
  `F-A label expected 待 test, got ${byId['F-A'].pipeline_stage_label}`
);
assert(byId['F-B'].pipeline_status === 'in_progress', `F-B expected in_progress (active codegen), got ${byId['F-B'].pipeline_status}`);
assert(byId['F-B'].hints.includes('active_codegen_feature'), 'F-B should be active_codegen_feature');
assert(byId['F-B'].pipeline_stage_label, 'F-B should have pipeline_stage_label');
assert(typeof byId['F-B'].stage_elapsed_ms === 'number' || byId['F-B'].stage_elapsed_ms === null);

assert(isFeatureCodegenDone(root, 'F-A', doc), 'F-A codegen done via stages worktree row');
assert(!isFeatureCodegenDone(root, 'F-B', doc), 'F-B codegen not done');
assert(
  filterRemainingCodegenQueue(root, ['F-A', 'F-B'], doc).join(',') === 'F-B',
  'remaining queue should be F-B only'
);

const scaffoldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dash3-scaffold-'));
const scaffoldWt = path.join(scaffoldRoot, '.pipeline', 'worktrees', 'v3-fc-SCAFF');
fs.mkdirSync(scaffoldWt, { recursive: true });
fs.writeFileSync(path.join(scaffoldWt, 'package.json'), '{"name":"x"}', 'utf8');
const { execFileSync } = require('child_process');
execFileSync('git', ['init'], { cwd: scaffoldWt });
execFileSync('git', ['add', 'package.json'], { cwd: scaffoldWt });
execFileSync('git', ['commit', '-m', 'init'], { cwd: scaffoldWt });
fs.mkdirSync(path.join(scaffoldWt, 'src'), { recursive: true });
fs.writeFileSync(path.join(scaffoldWt, 'src', 'placeholder.txt'), 'x', 'utf8');
assert(isScaffoldOnlyWorktree(scaffoldRoot, 'SCAFF'), 'SCAFF should be scaffold-only');
assert(!isFeatureCodegenDone(scaffoldRoot, 'SCAFF', null), 'scaffold must not count as codegen done');

const sortDoc = {
  client_targets: { allowed_values: ['website', 'admin', 'backend'] },
  stages: {
    contract: {
      outputs: {
        artifacts: [
          { feature_id: 'P3-X', design_snapshot: 'docs/designs/P3-X.design.json' },
          { feature_id: 'P0-Y', design_snapshot: 'docs/designs/P0-Y.design.json' },
        ],
      },
    },
    prd_review: { review: { phase_plan: [{ phase: 'mvp', feature_ids: ['P3-X', 'P0-Y'] }] } },
  },
};
fs.mkdirSync(path.join(root, 'docs', 'designs'), { recursive: true });
const p3Path = path.join(root, 'docs', 'designs', 'P3-X.design.json');
const p0Path = path.join(root, 'docs', 'designs', 'P0-Y.design.json');
fs.writeFileSync(p3Path, JSON.stringify({ client_targets: ['website'] }), 'utf8');
fs.writeFileSync(p0Path, JSON.stringify({ cross_client: true, client_targets: ['website', 'admin'] }), 'utf8');
const orderIndex = buildPhaseOrderIndex(sortDoc.stages.prd_review.review.phase_plan);
const sorted = sortFeaturesByPriority(
  [
    { feature_id: 'P3-X', phase: 'mvp' },
    { feature_id: 'P0-Y', phase: 'mvp' },
  ],
  sortDoc,
  root,
  orderIndex
);
assert(sorted[0].feature_id === 'P0-Y', `P0 should sort first, got ${sorted[0].feature_id}`);

const docTestPass = JSON.parse(JSON.stringify(doc));
docTestPass.stages.codegen.status = 'completed';
docTestPass.stages.test = {
  status: 'completed',
  outputs: {
    per_feature: [{ feature_id: 'F-A', result: 'passed', passed: true, finished_at: '2026-01-01T00:00:00.000Z' }],
  },
};
const boardDone = buildFeatureBoard(docTestPass, root, runtime, { alive: false });
const fA = boardDone.features.find((f) => f.feature_id === 'F-A');
assert(fA.pipeline_status === 'completed', `F-A with test pass expected completed, got ${fA.pipeline_status}`);
assert(fA.pipeline_stage_label.includes('test'), `F-A completed label should mention test: ${fA.pipeline_stage_label}`);

console.log('ai-dash3 self-test-features: ok');

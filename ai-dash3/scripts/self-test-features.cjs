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
  byId['F-A'].feature_status === 'paused',
  `F-A expected paused (codegen done, test not run), got ${byId['F-A'].feature_status}`
);
assert(
  byId['F-A'].current_stage === 'typecheck' || byId['F-A'].pipeline_stage_label.includes('待'),
  `F-A after codegen done expected typecheck or 待 label, got stage=${byId['F-A'].current_stage} label=${byId['F-A'].pipeline_stage_label}`
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
const boardTestOnly = buildFeatureBoard(docTestPass, root, runtime, { alive: false });
const fATestOnly = boardTestOnly.features.find((f) => f.feature_id === 'F-A');
assert(
  fATestOnly.feature_status === 'paused',
  `F-A test pass without ui_e2e expected paused, got ${fATestOnly.feature_status}`
);
assert(
  fATestOnly.hints.includes('awaiting_ui_e2e'),
  `F-A should hint awaiting_ui_e2e: ${fATestOnly.hints}`
);
assert(
  !fATestOnly.completed_stages.includes('ui_e2e'),
  `ui_e2e must not be in completed_stages before project ui_e2e done`
);

docTestPass.stages.ui_e2e = { status: 'completed' };
const boardDone = buildFeatureBoard(docTestPass, root, runtime, { alive: false });
const fA = boardDone.features.find((f) => f.feature_id === 'F-A');
assert(fA.pipeline_status === 'completed', `F-A with test+ui_e2e expected completed, got ${fA.pipeline_status}`);
assert(fA.feature_status === 'completed', `F-A feature_status expected completed, got ${fA.feature_status}`);
assert(fA.current_stage_status !== 'completed', 'current_stage_status must not be completed');
assert(
  Array.isArray(fA.completed_stages) && fA.completed_stages.includes('codegen'),
  `F-A completed_stages should include codegen: ${fA.completed_stages}`
);
assert(byId['F-B'].feature_status === 'in_progress', `F-B feature_status expected in_progress, got ${byId['F-B'].feature_status}`);
assert(
  byId['F-A'].stage_progress_pct >= 0 && byId['F-A'].stage_total_count === 15,
  `F-A stage progress fields: pct=${byId['F-A'].stage_progress_pct} total=${byId['F-A'].stage_total_count}`
);

const docFailed = JSON.parse(JSON.stringify(doc));
docFailed.stages.test = {
  status: 'failed',
  outputs: {
    per_feature: [{ feature_id: 'F-A', result: 'failed', passed: false, finished_at: '2026-01-01T00:00:00.000Z' }],
  },
};
const boardFail = buildFeatureBoard(docFailed, root, runtime, { alive: false });
const fAFail = boardFail.features.find((f) => f.feature_id === 'F-A');
assert(fAFail.current_stage === 'test', `F-A failed current_stage expected test, got ${fAFail.current_stage}`);
assert(fAFail.current_stage_status === 'failed', `F-A failed current_stage_status expected failed, got ${fAFail.current_stage_status}`);
assert(fAFail.feature_status === 'paused', `F-A failed feature_status expected paused, got ${fAFail.feature_status}`);
assert(
  fAFail.completed_stages.includes('codegen'),
  `F-A failed should list codegen in completed_stages: ${fAFail.completed_stages}`
);

const docPrdPending = JSON.parse(JSON.stringify(doc));
delete docPrdPending.stages.codegen;
docPrdPending.stages.prd = { status: 'pending' };
const boardPrd = buildFeatureBoard(docPrdPending, root, {}, { alive: false });
const fBPrd = boardPrd.features.find((f) => f.feature_id === 'F-B');
assert(fBPrd.feature_status === 'pending', `F-B before prd expected pending, got ${fBPrd.feature_status}`);

const docPrdRun = JSON.parse(JSON.stringify(docPrdPending));
docPrdRun.stages.prd = { status: 'running' };
const boardPrdRun = buildFeatureBoard(docPrdRun, root, {}, { alive: false });
const fBRun = boardPrdRun.features.find((f) => f.feature_id === 'F-B');
assert(
  fBRun.feature_status === 'in_progress',
  `F-B while prd running expected in_progress, got ${fBRun.feature_status}`
);

const docDesignRun = JSON.parse(JSON.stringify(doc));
docDesignRun.stages.design = {
  status: 'running',
  outputs: {
    per_feature: [{ feature_id: 'F-B', status: 'running', started_at: '2026-01-01T00:00:00.000Z' }],
  },
};
const boardDesign = buildFeatureBoard(docDesignRun, root, {}, { alive: false });
const fBDesign = boardDesign.features.find((f) => f.feature_id === 'F-B');
assert(
  fBDesign.current_stage_status === 'running',
  `F-B design per_feature running expected current_stage_status=running, got ${fBDesign.current_stage_status}`
);
assert(
  fBDesign.feature_status === 'in_progress',
  `F-B design per_feature running expected in_progress, got ${fBDesign.feature_status}`
);

const docCodegenPerFeature = JSON.parse(JSON.stringify(doc));
docCodegenPerFeature.stages.codegen = {
  status: 'running',
  outputs: {
    worktrees: [
      {
        feature_id: 'F-A',
        worktree_path: path.join(root, '.pipeline', 'worktrees', 'v3-fc-F-A'),
        commit: '',
        files_changed: [],
      },
      {
        feature_id: 'F-B',
        worktree_path: path.join(root, '.pipeline', 'worktrees', 'v3-fc-F-B'),
        commit: '',
        files_changed: [],
      },
    ],
    per_feature: [
      { feature_id: 'F-A', status: 'completed', completed_at: '2026-01-01T00:00:00.000Z' },
      { feature_id: 'F-B', status: 'running', started_at: '2026-01-01T00:00:00.000Z' },
    ],
  },
};
const runtimeStalePending = {
  ...runtime,
  pending_features_json: JSON.stringify(['F-A', 'F-B']),
};
const boardCodegenPf = buildFeatureBoard(docCodegenPerFeature, root, runtimeStalePending, { alive: true });
const fAPf = boardCodegenPf.features.find((f) => f.feature_id === 'F-A');
const fBPf = boardCodegenPf.features.find((f) => f.feature_id === 'F-B');
assert(fAPf.feature_status === 'paused', `F-A per_feature codegen done expected paused, got ${fAPf.feature_status}`);
assert(
  fAPf.current_stage_status === 'pending',
  `F-A codegen done current_stage_status expected pending, got ${fAPf.current_stage_status}`
);
assert(
  fAPf.completed_stages.includes('codegen'),
  `F-A should list codegen in completed_stages: ${fAPf.completed_stages}`
);
assert(fBPf.feature_status === 'in_progress', `F-B active codegen expected in_progress, got ${fBPf.feature_status}`);
assert(
  fBPf.current_stage_status === 'running',
  `F-B running codegen expected current_stage_status=running, got ${fBPf.current_stage_status}`
);

const docStaleRunning = JSON.parse(JSON.stringify(docCodegenPerFeature));
docStaleRunning.stages.codegen.outputs.per_feature = [
  { feature_id: 'F-A', status: 'completed', completed_at: '2026-01-01T00:00:00.000Z' },
  { feature_id: 'F-B', status: 'completed', completed_at: '2026-01-01T00:00:00.000Z' },
];
const boardAllDone = buildFeatureBoard(docStaleRunning, root, runtimeStalePending, { alive: true });
const fAStale = boardAllDone.features.find((f) => f.feature_id === 'F-A');
const fBStale = boardAllDone.features.find((f) => f.feature_id === 'F-B');
assert(
  fAStale.feature_status === 'paused' && fBStale.feature_status === 'paused',
  `all codegen done expected paused: F-A=${fAStale.feature_status} F-B=${fBStale.feature_status}`
);
assert(
  boardAllDone.active_codegen_feature_id === null,
  `no active codegen when all per_feature completed, got ${boardAllDone.active_codegen_feature_id}`
);

console.log('ai-dash3 self-test-features: ok');

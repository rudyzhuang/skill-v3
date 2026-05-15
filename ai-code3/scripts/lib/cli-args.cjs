'use strict';

const path = require('path');

/**
 * @param {string[]} argv
 * @returns {{
 *   _: string[],
 *   project: string | null,
 *   subcommand: string | null,
 *   fromStage: string | null,
 *   toStage: string | null,
 *   feature: string | null,
 *   featureIds: string[],
 *   forceRerun: string | null,
 *   dryRun: boolean,
 *   sessionId: string | null,
 *   stubRemaining: boolean,
 * }}
 */
function parseCommonArgs(argv) {
  const rest = argv.slice(2);
  const out = {
    _: [],
    project: null,
    subcommand: null,
    fromStage: null,
    toStage: null,
    feature: null,
    featureIds: [],
    forceRerun: null,
    dryRun: false,
    sessionId: null,
    stubRemaining: false,
  };

  const known = new Set([
    'all',
    'preflight',
    'codegen',
    'typecheck',
    'test',
    'code-review',
    'merge-push',
    'build',
    'clean',
    'clean-worktrees',
  ]);

  for (const a of rest) {
    if (a.startsWith('--project=')) {
      out.project = a.slice('--project='.length);
    } else if (a.startsWith('--from-stage=')) {
      out.fromStage = a.slice('--from-stage='.length);
    } else if (a.startsWith('--to-stage=')) {
      out.toStage = a.slice('--to-stage='.length);
    } else if (a.startsWith('--feature=')) {
      out.feature = a.slice('--feature='.length);
      out.featureIds = out.feature
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith('--force-rerun=')) {
      out.forceRerun = a.slice('--force-rerun='.length).replace(/-/g, '_');
    } else if (a.startsWith('--session-id=')) {
      out.sessionId = a.slice('--session-id='.length);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--stub-remaining') {
      out.stubRemaining = true;
    } else if (a.startsWith('-')) {
      out._.push(a);
    } else if (known.has(a) && !out.subcommand) {
      out.subcommand = a;
    } else if (!out.subcommand) {
      out.subcommand = a;
    } else {
      out._.push(a);
    }
  }

  if (!out.subcommand) out.subcommand = 'all';
  return out;
}

const STAGE_ORDER = ['codegen', 'typecheck', 'test', 'code_review', 'merge_push', 'build'];

function normalizeStageKey(name) {
  if (!name) return null;
  const n = name.replace(/-/g, '_');
  if (STAGE_ORDER.includes(n)) return n;
  return null;
}

function stageScriptModule(key) {
  const map = {
    codegen: './codegen.cjs',
    typecheck: './typecheck.cjs',
    test: './test.cjs',
    code_review: './code-review.cjs',
    merge_push: './merge-push.cjs',
    build: './build.cjs',
  };
  return map[key];
}

function filterOrder(fromKey, toKey) {
  let start = 0;
  let end = STAGE_ORDER.length - 1;
  if (fromKey) {
    const i = STAGE_ORDER.indexOf(fromKey);
    if (i >= 0) start = i;
  }
  if (toKey) {
    const i = STAGE_ORDER.indexOf(toKey);
    if (i >= 0) end = i;
  }
  if (start > end) return [];
  return STAGE_ORDER.slice(start, end + 1);
}

module.exports = {
  parseCommonArgs,
  STAGE_ORDER,
  normalizeStageKey,
  stageScriptModule,
  filterOrder,
};

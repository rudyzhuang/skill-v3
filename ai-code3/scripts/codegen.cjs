'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');

function gatherFeatureIds(doc, options) {
  if (options.featureIds?.length) return options.featureIds;
  const phases = doc.stages?.prd_review?.review?.phase_plan || [];
  const ids = [];
  for (const p of phases) {
    for (const id of p.feature_ids || []) ids.push(String(id));
  }
  return ids;
}

function assertCodegenGates(doc) {
  const dr = doc.stages?.design_review;
  if (!dr || dr.status !== 'completed' || !dr.validation?.passed || dr.outputs?.decision !== 'passed') {
    return 'codegen blocked: design_review must be completed with validation.passed and outputs.decision=passed';
  }
  const ct = doc.stages?.contract;
  if (!ct || ct.status !== 'completed' || !ct.validation?.passed) {
    return 'codegen blocked: contract must be completed with validation.passed';
  }
  const ha = ct.outputs?.human_approval?.status;
  if (ha !== 'approved' && ha !== 'not_required') {
    return `codegen blocked: contract.outputs.human_approval.status must be approved|not_required (got ${ha})`;
  }
  const arts = ct.outputs?.artifacts;
  if (!Array.isArray(arts) || arts.length === 0) {
    return 'codegen blocked: contract.outputs.artifacts[] missing';
  }
  return null;
}

const CONTRACT_KEYS = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'];

/** §7.2：首条 artifacts 须可解析出五类契约路径（均非空且文件存在）。 */
function collectContractRelPaths(projectRoot, doc) {
  const arts = doc.stages?.contract?.outputs?.artifacts || [];
  if (arts.length === 0) {
    throw new Error('contract.outputs.artifacts[] empty');
  }
  const art = arts[0];
  const paths = [];
  for (const k of CONTRACT_KEYS) {
    const rel = art[k];
    if (typeof rel !== 'string' || !rel.trim()) {
      throw new Error(`contract artifact missing non-empty path for key "${k}"`);
    }
    const full = path.join(projectRoot, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`contract artifact path missing: ${rel}`);
    }
    paths.push(rel);
  }
  return paths;
}

function runDiffGuard(projectRoot, relPaths) {
  const inside = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    return { exit: 1, reason: 'not_a_git_work_tree' };
  }
  if (relPaths.length === 0) return { exit: 1, reason: 'no_paths' };
  const r = spawnSync('git', ['-C', projectRoot, 'diff', '--exit-code', '--', ...relPaths], {
    encoding: 'utf8',
  });
  if (r.status === 0) return { exit: 0 };
  if (r.status === 1) return { exit: 5, reason: 'dirty_contract_paths' };
  return { exit: 1, reason: r.stderr || 'git_diff_failed' };
}

async function run(ctx) {
  const { projectRoot, options } = ctx;
  let doc;
  try {
    doc = stagesIo.readStagesSync(projectRoot);
    stagesIo.assertSchemaSupported(doc);
  } catch (e) {
    console.error(String(e.message || e));
    return 1;
  }

  const prevCg = doc.stages?.codegen;
  if (
    !options.dryRun &&
    prevCg?.status === 'completed' &&
    prevCg?.validation?.passed &&
    process.env.AI_CODE3_CODEGEN_CONFIRM !== 'yes'
  ) {
    console.error(
      'failed_stage=codegen: overwriting completed codegen requires AI_CODE3_CODEGEN_CONFIRM=yes (input-spec §7.2 / code3.md §6)'
    );
    writeTerminal(projectRoot, doc, 'codegen', 'blocked', {
      summary: 'codegen overwrite blocked pending explicit confirm',
    });
    return 1;
  }

  const gateErr = assertCodegenGates(doc);
  if (gateErr) {
    console.error(gateErr);
    if (!options.dryRun) {
      writeTerminal(projectRoot, doc, 'codegen', 'blocked', { summary: gateErr });
    }
    return 1;
  }

  let relPaths;
  try {
    relPaths = collectContractRelPaths(projectRoot, doc);
  } catch (e) {
    console.error(String(e.message || e));
    if (!options.dryRun) {
      writeTerminal(projectRoot, doc, 'codegen', 'failed', {
        summary: String(e.message || e),
      });
    }
    return 1;
  }

  const dg = runDiffGuard(projectRoot, relPaths);
  if (dg.exit !== 0) {
    if (dg.exit === 5) {
      console.error('failed_stage=codegen contract diff-guard failed (working tree dirty vs HEAD for contract paths)');
    } else {
      console.error(`failed_stage=codegen diff-guard: ${dg.reason || 'error'}`);
    }
    if (!options.dryRun) {
      doc = stagesIo.updateStage(doc, 'codegen', {
        status: 'failed',
        completed_at: new Date().toISOString(),
        validation: {
          ...doc.stages?.codegen?.validation,
          passed: false,
          contract_diff_guard_passed: dg.exit === 5 ? false : doc.stages?.codegen?.validation?.contract_diff_guard_passed,
          summary: dg.reason || 'diff-guard',
        },
        outputs: {
          ...doc.stages?.codegen?.outputs,
          duration_ms: null,
          timed_out: false,
          timeout_reason: null,
        },
      });
      stagesIo.writeStagesSync(projectRoot, doc);
    }
    return dg.exit;
  }

  const featureIds = gatherFeatureIds(doc, options);
  const hash = summaryHash.computeCodegenInputHash(doc, projectRoot, featureIds);

  if (options.dryRun) {
    console.error(`[dry-run] codegen ok; summary_hash would be ${hash}`);
    return 0;
  }

  const worktrees = doc.stages?.codegen?.outputs?.worktrees;
  let wt =
    Array.isArray(worktrees) && worktrees.length > 0
      ? worktrees.map((w) => ({
          ...w,
          worktree_path:
            w.worktree_path && String(w.worktree_path).trim()
              ? path.isAbsolute(w.worktree_path)
                ? w.worktree_path
                : path.join(projectRoot, w.worktree_path)
              : projectRoot,
        }))
      : [
          {
            feature_id: featureIds[0] || '',
            branch: '',
            worktree_path: projectRoot,
            commit: '',
            files_expected: [],
            files_changed: [],
            test_files_expected: [],
            test_files_changed: [],
          },
        ];

  const now = new Date().toISOString();
  doc = stagesIo.updateStage(doc, 'codegen', {
    status: 'completed',
    started_at: doc.stages?.codegen?.started_at || now,
    completed_at: now,
    inputs: {
      ...doc.stages?.codegen?.inputs,
      summary_hash: hash,
      requires_stage: 'design_review',
    },
    outputs: {
      ...doc.stages?.codegen?.outputs,
      worktrees: wt,
      impl_codegen_status: 'completed',
      test_codegen_status: 'completed',
      duration_ms: 0,
      timed_out: false,
      timeout_reason: null,
    },
    validation: {
      ...doc.stages?.codegen?.validation,
      passed: true,
      contract_diff_guard_passed: true,
      summary: 'ai-code3/scripts/codegen.cjs',
    },
  });
  stagesIo.writeStagesSync(projectRoot, doc);
  return 0;
}

module.exports = { run };

if (require.main === module) {
  const { parseCommonArgs } = require('./lib/cli-args.cjs');
  const o = parseCommonArgs(process.argv);
  if (!o.project) {
    console.error('missing --project=<absolute>');
    process.exit(1);
  }
  run({ projectRoot: o.project, options: o }).then((c) => process.exit(c));
}

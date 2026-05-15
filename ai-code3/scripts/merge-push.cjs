'use strict';

const fs = require('fs');
const path = require('path');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');

function loadDevConfig(projectRoot) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function run(ctx) {
  const { projectRoot, options } = ctx;

  if (options.forceRerun === 'merge_push' && process.env.AI_CODE3_MERGE_CONFIRM !== 'yes') {
    console.error(
      'failed_stage=merge_push: --force-rerun=merge_push requires explicit AI_CODE3_MERGE_CONFIRM=yes'
    );
    return 1;
  }

  const lock = stagesIo.tryAcquireLock(projectRoot, 'merge-push', {
    sessionId: options.sessionId || '',
  });
  if (!lock.ok) {
    console.error('failed_stage=merge_push: lock busy (.agent-sessions/locks/merge-push.pid)');
    return 1;
  }

  try {
    let doc;
    try {
      doc = stagesIo.readStagesSync(projectRoot);
      stagesIo.assertSchemaSupported(doc);
    } catch (e) {
      console.error(String(e.message || e));
      return 1;
    }

    const cr = doc.stages?.code_review;
    if (!cr || cr.status !== 'completed' || !cr.validation?.passed || cr.outputs?.decision !== 'passed') {
      const msg = 'merge_push blocked: code_review must be completed passed';
      console.error(msg);
      if (!options.dryRun) writeTerminal(projectRoot, doc, 'merge_push', 'blocked', { summary: msg });
      return 1;
    }

    if (process.env.AI_CODE3_MERGE_CONFLICT === '1') {
      console.error('failed_stage=merge_push simulated merge conflict (AI_CODE3_MERGE_CONFLICT=1)');
      if (!options.dryRun) {
        doc = stagesIo.updateStage(doc, 'merge_push', {
          status: 'failed',
          completed_at: new Date().toISOString(),
          outputs: {
            ...doc.stages?.merge_push?.outputs,
            merge_status: 'conflict',
            conflict_files: ['(simulated)'],
            error: 'AI_CODE3_MERGE_CONFLICT=1',
            duration_ms: 0,
            timed_out: false,
            timeout_reason: null,
          },
          validation: {
            ...doc.stages?.merge_push?.validation,
            passed: false,
            summary: 'merge conflict (simulated)',
          },
        });
        stagesIo.writeStagesSync(projectRoot, doc);
      }
      return 6;
    }

    const config = loadDevConfig(projectRoot);
    const allowPush = config.git?.allow_push === true;
    const targetBranch = config.git?.default_branch || doc.stages?.merge_push?.inputs?.target_branch || 'main';

    if (options.dryRun) {
      console.error(`[dry-run] merge_push target=${targetBranch} allow_push=${allowPush}`);
      return 0;
    }

    if (process.env.AI_CODE3_PUSH_FAIL === '1') {
      console.error('failed_stage=merge_push simulated push failure');
      if (!options.dryRun) {
        doc = stagesIo.updateStage(doc, 'merge_push', {
          status: 'failed',
          completed_at: new Date().toISOString(),
          outputs: {
            ...doc.stages?.merge_push?.outputs,
            merge_status: 'completed',
            push_requested: true,
            push_status: 'failed',
            error: 'AI_CODE3_PUSH_FAIL=1',
            duration_ms: 0,
            timed_out: false,
            timeout_reason: null,
          },
          validation: {
            ...doc.stages?.merge_push?.validation,
            passed: false,
            summary: 'push failed (simulated)',
          },
        });
        stagesIo.writeStagesSync(projectRoot, doc);
      }
      return 7;
    }

    const now = new Date().toISOString();
    const wt = doc.stages?.code_review?.inputs?.worktrees || [];

    const draft = stagesIo.updateStage(JSON.parse(JSON.stringify(doc)), 'merge_push', {
      inputs: {
        ...doc.stages?.merge_push?.inputs,
        requires_stage: 'code_review',
        worktrees: wt,
        target_branch: targetBranch,
        allow_push: allowPush,
      },
    });
    const hash = summaryHash.computeUpstreamHashForStage(draft, 'merge_push', projectRoot, options.featureIds);

    if (options.stubRemaining) {
      doc = stagesIo.updateStage(doc, 'merge_push', {
        status: 'completed',
        started_at: doc.stages?.merge_push?.started_at || now,
        completed_at: now,
        inputs: {
          ...doc.stages?.merge_push?.inputs,
          requires_stage: 'code_review',
          worktrees: wt,
          target_branch: targetBranch,
          allow_push: allowPush,
          summary_hash: hash,
        },
        outputs: {
          ...doc.stages?.merge_push?.outputs,
          merge_status: 'completed',
          target_branch: targetBranch,
          merge_commit: 'stub',
          push_requested: allowPush,
          push_status: allowPush ? 'pending' : 'not_requested',
          conflict_files: [],
          error: '',
          duration_ms: 0,
          timed_out: false,
          timeout_reason: null,
        },
        validation: {
          ...doc.stages?.merge_push?.validation,
          passed: true,
          summary: 'stub via --stub-remaining',
        },
      });
      stagesIo.writeStagesSync(projectRoot, doc);
      return 0;
    }

    console.error(
      'failed_stage=merge_push: real git merge/push not executed in this MVP; use --stub-remaining for smoke or extend scripts/merge-push.cjs'
    );
    writeTerminal(projectRoot, doc, 'merge_push', 'blocked', {
      summary: 'merge/push not implemented; use --stub-remaining or extend script',
    });
    return 1;
  } finally {
    lock.release();
  }
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

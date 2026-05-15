'use strict';

const fs = require('fs');
const path = require('path');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const mergeGit = require('./lib/merge-git.cjs');
const { runWithTimeout } = require('./lib/run-with-timeout.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');

function loadDevConfig(projectRoot) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function mergePushStageTimeoutMs(config) {
  const sec = config?.timeouts?.stages?.merge_push_s;
  if (typeof sec === 'number' && sec > 0) return sec * 1000;
  return 300 * 1000;
}

async function run(ctx) {
  const { projectRoot, options } = ctx;

  if (options.forceRerun === 'merge_push' && process.env.AI_CODE3_MERGE_CONFIRM !== 'yes') {
    console.error(
      'failed_stage=merge_push: --force-rerun=merge_push requires explicit AI_CODE3_MERGE_CONFIRM=yes'
    );
    return 1;
  }

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
    const lock = stagesIo.tryAcquireLock(projectRoot, 'merge-push', {
      sessionId: options.sessionId || '',
    });
    if (!lock.ok) {
      console.error('failed_stage=merge_push: lock busy (.agent-sessions/locks/merge-push.pid)');
      return 1;
    }
    try {
      console.error('failed_stage=merge_push simulated merge conflict (AI_CODE3_MERGE_CONFLICT=1)');
      if (!options.dryRun) {
        doc = stagesIo.readStagesSync(projectRoot);
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
    } finally {
      lock.release();
    }
  }

  const config = loadDevConfig(projectRoot);
  const allowPush = config.git?.allow_push === true;
  const targetBranch = config.git?.default_branch || doc.stages?.merge_push?.inputs?.target_branch || 'main';

  if (options.dryRun) {
    console.error(`[dry-run] merge_push target=${targetBranch} allow_push=${allowPush}`);
    return 0;
  }

  if (process.env.AI_CODE3_PUSH_FAIL === '1') {
    const lock = stagesIo.tryAcquireLock(projectRoot, 'merge-push', {
      sessionId: options.sessionId || '',
    });
    if (!lock.ok) {
      console.error('failed_stage=merge_push: lock busy (.agent-sessions/locks/merge-push.pid)');
      return 1;
    }
    try {
      console.error('failed_stage=merge_push simulated push failure');
      if (!options.dryRun) {
        doc = stagesIo.readStagesSync(projectRoot);
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
    } finally {
      lock.release();
    }
  }

  const now = new Date().toISOString();
  const wt = mergeGit.collectWorktreeRows(doc);

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
    const lock = stagesIo.tryAcquireLock(projectRoot, 'merge-push', {
      sessionId: options.sessionId || '',
    });
    if (!lock.ok) {
      console.error('failed_stage=merge_push: lock busy (.agent-sessions/locks/merge-push.pid)');
      return 1;
    }
    try {
      doc = stagesIo.readStagesSync(projectRoot);
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
    } finally {
      lock.release();
    }
  }

  const rows = mergeGit.collectWorktreeRows(doc);
  if (rows.length === 0) {
    const msg =
      'merge_push blocked: set codegen.outputs.worktrees[] or code_review.inputs.worktrees[] (non-empty)';
    console.error(`failed_stage=merge_push: ${msg}`);
    writeTerminal(projectRoot, doc, 'merge_push', 'blocked', { summary: msg });
    return 1;
  }

  if (!mergeGit.isInsideGitWorkTree(projectRoot)) {
    const msg = 'merge_push blocked: project root is not a git work tree';
    console.error(`failed_stage=merge_push: ${msg}`);
    writeTerminal(projectRoot, doc, 'merge_push', 'blocked', { summary: msg });
    return 1;
  }

  if (!mergeGit.isCleanWorkingTree(projectRoot)) {
    const msg = 'merge_push blocked: working tree must be clean (commit or stash changes first)';
    console.error(`failed_stage=merge_push: ${msg}`);
    writeTerminal(projectRoot, doc, 'merge_push', 'blocked', { summary: msg });
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
    let hbMerge;
    const sessionIdMp = options.sessionId || '';
    if (sessionIdMp) {
      const { appendHeartbeat } = require('./lib/session-log.cjs');
      hbMerge = setInterval(
        () => appendHeartbeat(projectRoot, sessionIdMp, 'merge_push', 'tick'),
        30_000
      );
    }
    try {
    doc = stagesIo.readStagesSync(projectRoot);
    const mergeStepMs = mergePushStageTimeoutMs(config);
    const featureBranches = mergeGit.listFeatureBranchesToMerge(projectRoot, doc, targetBranch);
    doc = stagesIo.updateStage(doc, 'merge_push', {
      status: 'running',
      started_at: doc.stages?.merge_push?.started_at || now,
      inputs: {
        ...doc.stages?.merge_push?.inputs,
        requires_stage: 'code_review',
        worktrees: wt,
        target_branch: targetBranch,
        allow_push: allowPush,
      },
    });
    stagesIo.writeStagesSync(projectRoot, doc);

    let mergeResult;
    if (featureBranches.length === 0) {
      const r0 = await runWithTimeout('git', ['-C', projectRoot, 'checkout', targetBranch], {
        timeoutMs: mergeStepMs,
      });
      if (r0.timedOut) {
        mergeResult = { ok: false, exit: 3, timedOut: true, stderr: 'checkout timed out' };
      } else if (r0.code !== 0) {
        mergeResult = { ok: false, exit: 1, stderr: `git checkout ${targetBranch} failed` };
      } else {
        const h = mergeGit.git(projectRoot, ['rev-parse', 'HEAD'], { stdio: 'pipe' });
        mergeResult =
          h.status === 0
            ? { ok: true, mergeCommit: String(h.stdout || '').trim() }
            : { ok: false, exit: 1, stderr: 'rev-parse HEAD failed' };
      }
    } else {
      mergeResult = await mergeGit.mergeFeatureBranchesIntoTargetAsync(
        projectRoot,
        targetBranch,
        featureBranches,
        mergeStepMs
      );
    }

    if (!mergeResult.ok) {
      const exit = mergeResult.exit ?? 1;
      const completedAt = new Date().toISOString();
      doc = stagesIo.updateStage(doc, 'merge_push', {
        status: 'failed',
        completed_at: completedAt,
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
          merge_status: exit === 6 ? 'conflict' : 'pending',
          target_branch: targetBranch,
          merge_commit: '',
          push_requested: false,
          push_status: 'not_requested',
          conflict_files: mergeResult.conflictFiles || [],
          error: mergeResult.stderr || (exit === 6 ? 'merge conflict' : 'merge failed'),
          duration_ms: 0,
          timed_out: Boolean(mergeResult.timedOut),
          timeout_reason: mergeResult.timedOut ? 'merge_push_git' : null,
        },
        validation: {
          ...doc.stages?.merge_push?.validation,
          passed: false,
          summary: mergeResult.stderr || 'merge_push failed',
        },
      });
      stagesIo.writeStagesSync(projectRoot, doc);
      if (exit === 6) console.error('failed_stage=merge_push merge conflict');
      else console.error(`failed_stage=merge_push exit=${exit}`);
      return exit;
    }

    const mergeCommit = mergeResult.mergeCommit;
    const remote = config.git?.remote || 'origin';
    let pushStatus = 'not_requested';
    let pushErr = '';

    if (allowPush) {
      if (!mergeGit.remoteExists(projectRoot, remote)) {
        pushStatus = 'failed';
        pushErr = `git remote "${remote}" not configured`;
        const completedAt = new Date().toISOString();
        doc = stagesIo.updateStage(doc, 'merge_push', {
          status: 'failed',
          completed_at: completedAt,
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
            merge_commit: mergeCommit,
            push_requested: true,
            push_status: pushStatus,
            conflict_files: [],
            error: pushErr,
            duration_ms: 0,
            timed_out: false,
            timeout_reason: null,
          },
          validation: {
            ...doc.stages?.merge_push?.validation,
            passed: false,
            summary: pushErr,
          },
        });
        stagesIo.writeStagesSync(projectRoot, doc);
        console.error('failed_stage=merge_push push failed (no remote)');
        return 7;
      }
      const pr = await mergeGit.pushTargetAsync(projectRoot, remote, targetBranch, mergeStepMs);
      if (!pr.ok) {
        pushStatus = pr.timedOut ? 'failed' : 'failed';
        pushErr = pr.stderr || 'git push failed';
        const completedAt = new Date().toISOString();
        doc = stagesIo.updateStage(doc, 'merge_push', {
          status: 'failed',
          completed_at: completedAt,
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
            merge_commit: mergeCommit,
            push_requested: true,
            push_status: pushStatus,
            conflict_files: [],
            error: pushErr,
            duration_ms: 0,
            timed_out: Boolean(pr.timedOut),
            timeout_reason: pr.timedOut ? 'merge_push_push' : null,
          },
          validation: {
            ...doc.stages?.merge_push?.validation,
            passed: false,
            summary: pushErr,
          },
        });
        stagesIo.writeStagesSync(projectRoot, doc);
        console.error('failed_stage=merge_push push failed');
        return pr.timedOut ? 3 : 7;
      }
      pushStatus = 'pushed';
    }

    const completedAt = new Date().toISOString();
    doc = stagesIo.updateStage(doc, 'merge_push', {
      status: 'completed',
      completed_at: completedAt,
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
        merge_commit: mergeCommit,
        push_requested: allowPush,
        push_status: pushStatus,
        conflict_files: [],
        error: '',
        duration_ms: 0,
        timed_out: false,
        timeout_reason: null,
      },
      validation: {
        ...doc.stages?.merge_push?.validation,
        passed: true,
        summary: 'ai-code3/scripts/merge-push.cjs (git merge)',
      },
    });
    stagesIo.writeStagesSync(projectRoot, doc);
    return 0;
    } finally {
      if (hbMerge) clearInterval(hbMerge);
    }
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

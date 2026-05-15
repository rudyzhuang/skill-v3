'use strict';

const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');

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

  const te = doc.stages?.test;
  if (!te || te.status !== 'completed' || !te.validation?.passed) {
    const msg = 'code-review blocked: test must be completed with validation.passed';
    console.error(msg);
    if (!options.dryRun) writeTerminal(projectRoot, doc, 'code_review', 'blocked', { summary: msg });
    return 1;
  }

  const cr = doc.stages?.code_review;
  const critical = cr?.outputs?.critical_issues ?? 0;
  if (critical > 0) {
    console.error(`failed_stage=code_review critical_issues=${critical}`);
    if (!options.dryRun) {
      writeTerminal(projectRoot, doc, 'code_review', 'failed', {
        summary: `critical_issues=${critical}`,
      });
    }
    return 4;
  }

  if (options.stubRemaining) {
    const now = new Date().toISOString();
    const hash = summaryHash.computeUpstreamHashForStage(doc, 'code_review', projectRoot, options.featureIds);
    const baseChecklist = cr?.outputs?.checklist || [];
    const checklist = baseChecklist.map((item) => ({
      ...item,
      passed: true,
      violations: [],
    }));
    doc = stagesIo.updateStage(doc, 'code_review', {
      status: 'completed',
      started_at: cr?.started_at || now,
      completed_at: now,
      inputs: {
        ...cr?.inputs,
        summary_hash: hash,
        requires_stage: 'test',
        worktrees: doc.stages?.test?.inputs?.worktrees || [],
      },
      outputs: {
        ...cr?.outputs,
        decision: 'passed',
        critical_issues: 0,
        warnings: 0,
        checklist,
        duration_ms: 0,
        timed_out: false,
        timeout_reason: null,
      },
      validation: {
        ...cr?.validation,
        passed: true,
        summary: 'stub via --stub-remaining',
      },
    });
    stagesIo.writeStagesSync(projectRoot, doc);
    return 0;
  }

  const decision = cr?.outputs?.decision;
  if (decision === 'passed' && critical === 0 && cr?.validation?.passed) {
    const now = new Date().toISOString();
    const hash = summaryHash.computeUpstreamHashForStage(doc, 'code_review', projectRoot, options.featureIds);
    doc = stagesIo.updateStage(doc, 'code_review', {
      completed_at: now,
      inputs: { ...cr.inputs, summary_hash: hash },
    });
    stagesIo.writeStagesSync(projectRoot, doc);
    return 0;
  }

  if (decision === 'passed_with_warnings') {
    console.error('failed_stage=code_review passed_with_warnings treated as failure (strict default)');
    if (!options.dryRun) {
      writeTerminal(projectRoot, doc, 'code_review', 'failed', {
        summary: 'passed_with_warnings (strict)',
      });
    }
    return 4;
  }

  console.error(
    'failed_stage=code_review: awaiting LLM/human to set stages.code_review.outputs (decision=passed, critical_issues=0) or pass --stub-remaining for CI smoke'
  );
  if (!options.dryRun) {
    writeTerminal(projectRoot, doc, 'code_review', 'blocked', {
      summary: 'awaiting LLM/human code_review outputs',
    });
  }
  return 1;
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

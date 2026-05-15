'use strict';

const fs = require('fs');
const path = require('path');
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

  const importPath = process.env.AI_CODE3_CODE_REVIEW_JSON;
  if (importPath && !options.stubRemaining) {
    const abs = path.isAbsolute(importPath) ? importPath : path.join(projectRoot, importPath);
    if (!fs.existsSync(abs)) {
      console.error(`failed_stage=code_review missing import file: ${abs}`);
      return 1;
    }
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      console.error(`failed_stage=code_review invalid JSON: ${e.message}`);
      return 1;
    }
    const decision = String(payload.decision || 'pending');
    const allowed = new Set(['passed', 'failed', 'passed_with_warnings', 'pending']);
    if (!allowed.has(decision)) {
      console.error(`failed_stage=code_review invalid decision: ${decision}`);
      return 1;
    }
    const crit = Number(payload.critical_issues) || 0;
    const warns = Number(payload.warnings) || 0;
    const checklist = Array.isArray(payload.checklist) ? payload.checklist : [];
    const now = new Date().toISOString();
    const hash = summaryHash.computeUpstreamHashForStage(doc, 'code_review', projectRoot, options.featureIds);
    const cr0 = doc.stages?.code_review;
    const passed = decision === 'passed' && crit === 0;
    if (options.dryRun) {
      console.error(`[dry-run] code-review import decision=${decision}`);
      return 0;
    }
    doc = stagesIo.updateStage(doc, 'code_review', {
      status: passed ? 'completed' : 'failed',
      started_at: cr0?.started_at || now,
      completed_at: now,
      inputs: {
        ...cr0?.inputs,
        summary_hash: hash,
        requires_stage: 'test',
        worktrees: doc.stages?.test?.inputs?.worktrees || [],
      },
      outputs: {
        ...cr0?.outputs,
        decision,
        critical_issues: crit,
        warnings: warns,
        checklist,
        duration_ms: 0,
        timed_out: false,
        timeout_reason: null,
      },
      validation: {
        ...cr0?.validation,
        passed,
        summary: `imported from AI_CODE3_CODE_REVIEW_JSON (${abs})`,
      },
    });
    stagesIo.writeStagesSync(projectRoot, doc);
    if (decision === 'passed_with_warnings') {
      console.error('failed_stage=code_review passed_with_warnings treated as failure (strict default)');
      return 4;
    }
    if (!passed) {
      console.error(`failed_stage=code_review decision=${decision} critical=${crit}`);
      return 4;
    }
    return 0;
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

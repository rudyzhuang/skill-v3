'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');
const { invokeAiCode3Agent } = require('./lib/invoke-ai-code3-agent.cjs');
const { validateCodeReviewOutput } = require('./lib/validate-code-review-output.cjs');
const featureStages = require('../../ai-auto3/scripts/lib/feature-stages.cjs');
const gitSync = require('../../ai-auto3/scripts/lib/git-pipeline-sync.cjs');

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

  const crFeatureIds =
    options.featureIds?.length > 0
      ? options.featureIds
      : featureStages.collectPhaseFeatureIds(doc);
  if (!options.dryRun) {
    doc = featureStages.backfillFeatureStages(doc);
    const crBegun = featureStages.beginStageForFeatures(doc, {
      stageKey: 'code_review',
      featureIds: crFeatureIds,
      skill: 'ai-code3',
      message: 'code-review 开始',
    });
    doc = crBegun.doc;
    stagesIo.writeStagesSync(projectRoot, doc);
    featureStages.appendStageLog(projectRoot, {
      skill: 'ai-code3',
      sessionId: options.sessionId || '',
      stageKey: 'code_review',
      featureIds: crFeatureIds,
      message: 'code-review 处理中',
    });
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

  const skipCrAgent =
    process.env.AI_CODE3_SKIP_AGENT === '1' ||
    (!(process.env.AI_CODE3_AGENT_BIN || '').trim() && !(process.env.AI_CODEGEN_AGENT_BIN || '').trim());

  if (!importPath && !options.stubRemaining && !skipCrAgent) {
    const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const sec = config?.timeouts?.stages?.code_review_s;
    const timeoutMs = (typeof sec === 'number' && sec > 0 ? sec : 900) * 1000;

    if (options.dryRun) {
      console.error('[dry-run] code-review external agent + JSON Schema output');
      return 0;
    }

    const outDir = path.join(projectRoot, '.agent-sessions');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `code-review-out-${crypto.randomBytes(8).toString('hex')}.json`);
    const fid =
      options.featureIds && options.featureIds.length ? options.featureIds.join(',') : '';

    const ar = await invokeAiCode3Agent({
      worktreePath: projectRoot,
      projectRoot,
      phase: 'code_review',
      featureId: fid,
      timeoutMs,
      extraEnv: { AI_CODE3_CODE_REVIEW_OUTPUT: outPath },
      sessionId: options.sessionId || '',
    });

    if (ar.skipped) {
      console.error('failed_stage=code_review agent skipped unexpectedly');
      return 1;
    }
    if (!ar.ok) {
      return ar.code === 3 ? 3 : 4;
    }
    if (!fs.existsSync(outPath)) {
      console.error(`failed_stage=code_review missing output file (set by agent): ${outPath}`);
      return 4;
    }
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch (e) {
      console.error(`failed_stage=code_review invalid JSON in output file: ${e.message}`);
      try {
        fs.unlinkSync(outPath);
      } catch {}
      return 4;
    }
    try {
      fs.unlinkSync(outPath);
    } catch {}

    let vr;
    try {
      vr = validateCodeReviewOutput(payload);
    } catch (e) {
      console.error(`failed_stage=code_review schema_loader: ${e.message || e}`);
      return 1;
    }
    if (!vr.ok) {
      console.error(`failed_stage=code_review schema_errors=${vr.errors}`);
      return 4;
    }
    payload = vr.data;

    const decision = String(payload.decision || 'pending');
    const allowed = new Set(['passed', 'failed', 'passed_with_warnings', 'pending']);
    if (!allowed.has(decision)) {
      console.error(`failed_stage=code_review invalid decision: ${decision}`);
      return 4;
    }
    const crit = Number(payload.critical_issues) || 0;
    const warns = Number(payload.warnings) || 0;
    const checklist = Array.isArray(payload.checklist) ? payload.checklist : [];
    const now = new Date().toISOString();
    const hash = summaryHash.computeUpstreamHashForStage(doc, 'code_review', projectRoot, options.featureIds);
    const cr0 = doc.stages?.code_review;
    const passed = decision === 'passed' && crit === 0;

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
        summary: 'ai-code3/scripts/code-review.cjs (external agent + JSON Schema)',
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
    const crIds =
      options.featureIds?.length > 0
        ? options.featureIds
        : featureStages.collectPhaseFeatureIds(doc);
    const config = gitSync.loadConfigDev(projectRoot);
    for (const fid of crIds) {
      const gr = gitSync.syncAfterFeature(projectRoot, 'code_review', fid, { config });
      if (!gr.ok && !gr.skipped && gr.push_status === 'failed') return 7;
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
    const stubIds =
      options.featureIds?.length > 0
        ? options.featureIds
        : featureStages.collectPhaseFeatureIds(doc);
    const configStub = gitSync.loadConfigDev(projectRoot);
    for (const fid of stubIds) {
      const gr = gitSync.syncAfterFeature(projectRoot, 'code_review', fid, { config: configStub });
      if (!gr.ok && !gr.skipped && gr.push_status === 'failed') return 7;
    }
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
    const passIds =
      options.featureIds?.length > 0
        ? options.featureIds
        : featureStages.collectPhaseFeatureIds(doc);
    const configPass = gitSync.loadConfigDev(projectRoot);
    for (const fid of passIds) {
      const gr = gitSync.syncAfterFeature(projectRoot, 'code_review', fid, { config: configPass });
      if (!gr.ok && !gr.skipped && gr.push_status === 'failed') return 7;
    }
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

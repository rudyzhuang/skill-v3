'use strict';

const fs = require('fs');
const path = require('path');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { runWithTimeout } = require('./lib/run-with-timeout.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');

function loadDevConfig(projectRoot) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stageTimeoutS(config, key, fallback) {
  const v = config?.timeouts?.stages?.[key];
  if (typeof v === 'number' && v > 0) return v;
  return fallback;
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

  const mp = doc.stages?.merge_push;
  if (!mp || mp.status !== 'completed' || !mp.validation?.passed) {
    const msg = 'build blocked: merge_push must be completed with validation.passed';
    console.error(msg);
    if (!options.dryRun) writeTerminal(projectRoot, doc, 'build', 'blocked', { summary: msg });
    return 1;
  }

  const lock = options.dryRun
    ? { ok: true, release() {} }
    : stagesIo.tryAcquireLock(projectRoot, 'build', { sessionId: options.sessionId || '' });
  if (!lock.ok) {
    console.error('failed_stage=build: lock busy (.agent-sessions/locks/build.pid)');
    return 1;
  }

  try {

  const config = loadDevConfig(projectRoot);
  const timeoutMs = stageTimeoutS(config, 'build_s', 1800) * 1000;
  const cwd = projectRoot;
  const buildCmd = config?.build?.commands?.build;

  const clientTargets = config?.build?.client_targets;
  const declared = config?.project?.default_client_targets || Object.keys(clientTargets || {});

  if (options.dryRun) {
    console.error(`[dry-run] build cmd=${buildCmd || '(none)'} targets=${declared.join(',')}`);
    return 0;
  }

  const now = new Date().toISOString();

  doc = stagesIo.updateStage(doc, 'build', {
    inputs: {
      ...doc.stages?.build?.inputs,
      requires_stage: 'merge_push',
      client_targets: declared,
    },
  });
  stagesIo.writeStagesSync(projectRoot, doc);

  const hash = summaryHash.computeUpstreamHashForStage(doc, 'build', projectRoot, options.featureIds);

  if (options.stubRemaining) {
    const artifacts = (declared.length ? declared : ['website']).map((t) => ({
      client_target: t,
      sub_platform: 'default',
      build_type: 'stub',
      command: '',
      artifact_path: path.join(projectRoot, config?.build?.artifacts_dir || 'dist', `${t}.stub`),
      status: t === 'backend' ? 'not_applicable' : 'completed',
      log_path: '',
    }));
    doc = stagesIo.updateStage(doc, 'build', {
      status: 'completed',
      started_at: doc.stages?.build?.started_at || now,
      completed_at: now,
      inputs: {
        ...doc.stages.build.inputs,
        summary_hash: hash,
      },
      outputs: {
        ...doc.stages?.build?.outputs,
        artifacts,
        skipped_targets: [],
        duration_ms: 0,
        timed_out: false,
        timeout_reason: null,
      },
      validation: {
        ...doc.stages?.build?.validation,
        passed: true,
        summary: 'stub via --stub-remaining',
      },
    });
    stagesIo.writeStagesSync(projectRoot, doc);
    return 0;
  }

  if (!buildCmd) {
    const msg = 'set docs/config.dev.json build.commands.build or use --stub-remaining';
    console.error(`failed_stage=build: ${msg}`);
    if (!options.dryRun) writeTerminal(projectRoot, doc, 'build', 'blocked', { summary: msg });
    return 1;
  }

  const r = await runWithTimeout('sh', ['-c', buildCmd], { cwd, timeoutMs });
  const passed = r.code === 0 && !r.timedOut;
  const artDir = path.join(projectRoot, config?.build?.artifacts_dir || 'dist');
  const artifacts = [
    {
      client_target: declared[0] || 'website',
      sub_platform: 'default',
      build_type: 'cli',
      command: buildCmd,
      artifact_path: fs.existsSync(artDir) ? artDir : '',
      status: passed ? 'completed' : 'failed',
      log_path: '',
    },
  ];

  doc = stagesIo.updateStage(doc, 'build', {
    status: passed ? 'completed' : 'failed',
    started_at: doc.stages?.build?.started_at || now,
    completed_at: new Date().toISOString(),
    inputs: {
      ...doc.stages.build.inputs,
      summary_hash: hash,
    },
    outputs: {
      ...doc.stages?.build?.outputs,
      artifacts,
      skipped_targets: [],
      duration_ms: 0,
      timed_out: r.timedOut,
      timeout_reason: r.timedOut ? 'build_command' : null,
    },
    validation: {
      ...doc.stages?.build?.validation,
      passed,
      summary: 'ai-code3/scripts/build.cjs',
    },
  });
  stagesIo.writeStagesSync(projectRoot, doc);

  if (!passed) {
    console.error(`failed_stage=build code=${r.code} timedOut=${r.timedOut}`);
    return r.timedOut ? 3 : 4;
  }
  return 0;
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

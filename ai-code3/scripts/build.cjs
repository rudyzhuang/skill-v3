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

  const sessionId = options.sessionId || '';
  let hb;
  if (sessionId) {
    const { appendHeartbeat } = require('./lib/session-log.cjs');
    hb = setInterval(() => appendHeartbeat(projectRoot, sessionId, 'build', 'tick'), 30_000);
  }

  const targets = declared.length ? declared : ['website'];
  const artifacts = [];
  let anyTimedOut = false;
  let anyFailed = false;

  try {
    for (const target of targets) {
      const spec = (clientTargets && clientTargets[target]) || {};
      const subs =
        Array.isArray(spec.sub_platforms) && spec.sub_platforms.length > 0
          ? spec.sub_platforms
          : [{ id: 'default', build: spec.build || buildCmd }];
      for (const sp of subs) {
        const subId = (sp && sp.id) || (typeof sp === 'string' ? sp : 'default');
        const cmd = (sp && sp.build) || spec.build || buildCmd;
        if (!cmd) {
          artifacts.push({
            client_target: target,
            sub_platform: subId,
            build_type: 'not_configured',
            command: '',
            artifact_path: '',
            status: target === 'backend' ? 'not_applicable' : 'failed',
            log_path: '',
          });
          if (target !== 'backend') anyFailed = true;
          continue;
        }
        const r = await runWithTimeout('sh', ['-c', cmd], { cwd, timeoutMs });
        if (r.timedOut) anyTimedOut = true;
        if (r.code !== 0 || r.timedOut) anyFailed = true;
        const artDir = path.join(projectRoot, config?.build?.artifacts_dir || 'dist', target, subId);
        artifacts.push({
          client_target: target,
          sub_platform: subId,
          build_type: 'cli',
          command: cmd,
          artifact_path: fs.existsSync(artDir) ? artDir : path.join(projectRoot, config?.build?.artifacts_dir || 'dist'),
          status: r.code === 0 && !r.timedOut ? 'completed' : 'failed',
          log_path: '',
        });
      }
    }
  } finally {
    if (hb) clearInterval(hb);
  }

  const passed = !anyFailed && !anyTimedOut;

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
      timed_out: anyTimedOut,
      timeout_reason: anyTimedOut ? 'build_command' : null,
    },
    validation: {
      ...doc.stages?.build?.validation,
      passed,
      summary: 'ai-code3/scripts/build.cjs',
    },
  });
  stagesIo.writeStagesSync(projectRoot, doc);

  if (!passed) {
    console.error(`failed_stage=build anyFailed=${anyFailed} timedOut=${anyTimedOut}`);
    return anyTimedOut ? 3 : 4;
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

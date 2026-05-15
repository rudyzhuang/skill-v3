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

  const tc = doc.stages?.typecheck;
  if (!tc || tc.status !== 'completed' || !tc.validation?.passed) {
    const msg = 'test blocked: typecheck must be completed with validation.passed';
    console.error(msg);
    if (!options.dryRun) writeTerminal(projectRoot, doc, 'test', 'blocked', { summary: msg });
    return 1;
  }

  const config = loadDevConfig(projectRoot);
  const maxAttempts = config?.build?.commands?.test_max_fix_attempts ?? 3;
  const timeoutMs = stageTimeoutS(config, 'test_s', 1800) * 1000;
  const cwd =
    (doc.stages?.typecheck?.inputs?.worktrees || [])[0]?.worktree_path || projectRoot;

  const testCmd =
    config?.build?.commands?.test ||
    (fs.existsSync(path.join(cwd, 'package.json')) ? 'npm test' : '');

  if (!testCmd) {
    const msg =
      'test blocked: set docs/config.dev.json build.commands.test or add package.json with npm test';
    console.error(msg);
    if (!options.dryRun) writeTerminal(projectRoot, doc, 'test', 'blocked', { summary: msg });
    return 1;
  }

  if (options.dryRun) {
    console.error(`[dry-run] test cmd=${testCmd} (not executed)`);
    return 0;
  }

  let lastCode = 1;
  let attempts = 0;
  const fixCmd = config?.build?.commands?.test_fix;
  const sessionId = options.sessionId || '';
  let hb;
  if (sessionId) {
    const { appendHeartbeat } = require('./lib/session-log.cjs');
    hb = setInterval(() => appendHeartbeat(projectRoot, sessionId, 'test', 'tick'), 30_000);
  }
  try {
  for (let i = 0; i < maxAttempts; i++) {
    attempts += 1;
    const r = await runWithTimeout('sh', ['-c', testCmd], { cwd, timeoutMs });
    lastCode = r.timedOut ? 3 : r.code;
    if (r.timedOut) break;
    if (r.code === 0) break;
    if (fixCmd && i < maxAttempts - 1) {
      const fr = await runWithTimeout('sh', ['-c', fixCmd], { cwd, timeoutMs });
      if (fr.timedOut) {
        lastCode = 3;
        break;
      }
    }
  }
  } finally {
    if (hb) clearInterval(hb);
  }

  const passed = lastCode === 0;
  const result = passed ? 'passed' : lastCode === 3 ? 'failed' : 'failed_max_attempts';

  const hash = summaryHash.computeUpstreamHashForStage(doc, 'test', projectRoot, options.featureIds);
  const wtList = doc.stages?.typecheck?.inputs?.worktrees || [];

  const now = new Date().toISOString();
  doc = stagesIo.updateStage(doc, 'test', {
    status: passed ? 'completed' : 'failed',
    started_at: doc.stages?.test?.started_at || now,
    completed_at: now,
    inputs: {
      ...doc.stages?.test?.inputs,
      summary_hash: hash,
      requires_stage: 'typecheck',
      worktrees: wtList,
    },
    outputs: {
      ...doc.stages?.test?.outputs,
      command: testCmd,
      attempts,
      result,
      log_path: '',
      failure_summary: passed ? '' : `exit ${lastCode}`,
      duration_ms: 0,
      timed_out: lastCode === 3,
      timeout_reason: lastCode === 3 ? 'test_command' : null,
    },
    validation: {
      ...doc.stages?.test?.validation,
      passed,
      summary: 'ai-code3/scripts/test.cjs',
    },
    rollback_to: passed
      ? null
      : {
          suggest_stage: 'codegen',
          reason: 'test failures after max fix attempts (see outputs.failure_summary)',
        },
  });
  stagesIo.writeStagesSync(projectRoot, doc);

  if (!passed) {
    console.error(`failed_stage=test result=${result}`);
    return lastCode === 3 ? 3 : 4;
  }
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

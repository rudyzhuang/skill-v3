'use strict';

const fs = require('fs');
const path = require('path');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { runWithTimeout } = require('./lib/run-with-timeout.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');
const featureStages = require('../../ai-auto3/scripts/lib/feature-stages.cjs');

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

function pickWorktreeCwd(doc, projectRoot) {
  const wts = doc.stages?.codegen?.outputs?.worktrees || [];
  for (const w of wts) {
    if (w.worktree_path && fs.existsSync(w.worktree_path)) return w.worktree_path;
  }
  return projectRoot;
}

/** §8.2：codegen 的 worktrees 路径须有效（非空且为目录）。 */
function assertWorktreesValid(doc, projectRoot) {
  const wts = doc.stages?.codegen?.outputs?.worktrees || [];
  if (wts.length === 0) {
    return 'typecheck blocked: codegen.outputs.worktrees[] is empty';
  }
  for (const w of wts) {
    const p = w.worktree_path;
    if (!p || typeof p !== 'string' || !p.trim()) {
      return 'typecheck blocked: worktree_path missing in codegen.outputs.worktrees[]';
    }
    const abs = path.isAbsolute(p) ? p : path.join(projectRoot, p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return `typecheck blocked: worktree_path not a directory: ${p}`;
    }
  }
  return null;
}

function hasMypyConfig(cwd) {
  return (
    fs.existsSync(path.join(cwd, 'mypy.ini')) ||
    fs.existsSync(path.join(cwd, '.mypy.ini')) ||
    fs.existsSync(path.join(cwd, 'pyproject.toml'))
  );
}

function hasPyrightConfig(cwd) {
  return fs.existsSync(path.join(cwd, 'pyrightconfig.json'));
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

  const cg = doc.stages?.codegen;
  if (!cg || cg.status !== 'completed' || !cg.validation?.passed) {
    const msg = 'typecheck blocked: codegen must be completed with validation.passed';
    console.error(msg);
    if (!options.dryRun) writeTerminal(projectRoot, doc, 'typecheck', 'blocked', { summary: msg });
    return 1;
  }

  const wtErr = assertWorktreesValid(doc, projectRoot);
  if (wtErr) {
    console.error(wtErr);
    if (!options.dryRun) writeTerminal(projectRoot, doc, 'typecheck', 'blocked', { summary: wtErr });
    return 1;
  }

  const cwd = pickWorktreeCwd(doc, projectRoot);
  const config = loadDevConfig(projectRoot);
  const timeoutMs = stageTimeoutS(config, 'typecheck_s', 600) * 1000;
  const graceMs = (config?.timeouts?.subcommand?.graceful_shutdown_s ?? 5) * 1000;

  if (options.dryRun) {
    console.error(`[dry-run] typecheck cwd=${cwd} (tools not executed)`);
    return 0;
  }

  const wtFeatureIds = (doc.stages?.codegen?.outputs?.worktrees || [])
    .map((w) => String(w?.feature_id || '').trim())
    .filter(Boolean);
  doc = featureStages.backfillFeatureStages(doc);
  const begun = featureStages.beginStageForFeatures(doc, {
    stageKey: 'typecheck',
    featureIds: wtFeatureIds.length ? wtFeatureIds : featureStages.collectPhaseFeatureIds(doc),
    skill: 'ai-code3',
    message: 'typecheck 静态检查开始',
  });
  doc = begun.doc;
  const tcIds = wtFeatureIds.length ? wtFeatureIds : featureStages.collectPhaseFeatureIds(doc);
  doc = featureStages.markFeaturesRunning(doc, 'typecheck', tcIds, { message: 'typecheck 执行中' });
  stagesIo.writeStagesSync(projectRoot, doc);
  featureStages.appendStageLog(projectRoot, {
    skill: 'ai-code3',
    stageKey: 'typecheck',
    message: `typecheck 处理中（${tcIds.length} 个 feature）`,
    detail: `cwd=${cwd}`,
  });

  const toolsOut = [];
  let ran = 0;
  let anyFailed = false;
  let anyTimedOut = false;

  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    ran += 1;
    const r = await runWithTimeout('npx', ['tsc', '--noEmit'], { cwd, timeoutMs, gracefulShutdownMs: graceMs });
    if (r.timedOut) anyTimedOut = true;
    toolsOut.push({
      name: 'tsc',
      status: r.code === 0 && !r.timedOut ? 'passed' : 'failed',
      command: 'npx tsc --noEmit',
      exit_code: r.timedOut ? null : r.code,
      errors: r.timedOut ? ['timed_out'] : [],
    });
    if (r.code !== 0 || r.timedOut) anyFailed = true;
  }

  const hasEslint =
    fs.existsSync(path.join(cwd, '.eslintrc.cjs')) ||
    fs.existsSync(path.join(cwd, '.eslintrc.js')) ||
    fs.existsSync(path.join(cwd, '.eslintrc.json')) ||
    fs.existsSync(path.join(cwd, 'eslint.config.js')) ||
    fs.existsSync(path.join(cwd, 'eslint.config.mjs'));

  if (hasEslint && fs.existsSync(path.join(cwd, 'package.json'))) {
    ran += 1;
    const r = await runWithTimeout('npx', ['eslint', '.', '--max-warnings', '0'], {
      cwd,
      timeoutMs,
      gracefulShutdownMs: graceMs,
    });
    if (r.timedOut) anyTimedOut = true;
    toolsOut.push({
      name: 'eslint',
      status: r.code === 0 && !r.timedOut ? 'passed' : 'failed',
      command: 'npx eslint . --max-warnings 0',
      exit_code: r.timedOut ? null : r.code,
      errors: r.timedOut ? ['timed_out'] : [],
    });
    if (r.code !== 0 || r.timedOut) anyFailed = true;
  }

  if (hasMypyConfig(cwd)) {
    ran += 1;
    const r = await runWithTimeout('python3', ['-m', 'mypy', '.'], { cwd, timeoutMs, gracefulShutdownMs: graceMs });
    if (r.timedOut) anyTimedOut = true;
    toolsOut.push({
      name: 'mypy',
      status: r.code === 0 && !r.timedOut ? 'passed' : 'failed',
      command: 'python3 -m mypy .',
      exit_code: r.timedOut ? null : r.code,
      errors: r.timedOut ? ['timed_out'] : [],
    });
    if (r.code !== 0 || r.timedOut) anyFailed = true;
  }

  if (hasPyrightConfig(cwd) && fs.existsSync(path.join(cwd, 'package.json'))) {
    ran += 1;
    const r = await runWithTimeout('npx', ['pyright', '.'], { cwd, timeoutMs, gracefulShutdownMs: graceMs });
    if (r.timedOut) anyTimedOut = true;
    toolsOut.push({
      name: 'pyright',
      status: r.code === 0 && !r.timedOut ? 'passed' : 'failed',
      command: 'npx pyright .',
      exit_code: r.timedOut ? null : r.code,
      errors: r.timedOut ? ['timed_out'] : [],
    });
    if (r.code !== 0 || r.timedOut) anyFailed = true;
  }

  const wtList = (doc.stages?.codegen?.outputs?.worktrees || []).map((w) => ({
    feature_id: w.feature_id,
    worktree_path: w.worktree_path,
  }));

  const skipReason =
    ran === 0 ? 'no_tsc_eslint_mypy_pyright_detected_in_worktree' : '';

  const passed = ran === 0 ? true : !anyFailed;
  let exitCode = 0;
  if (anyTimedOut) exitCode = 3;
  else if (ran > 0 && anyFailed) exitCode = 4;

  const hash = summaryHash.computeUpstreamHashForStage(doc, 'typecheck', projectRoot, options.featureIds);

  const now = new Date().toISOString();
  const defaultTools = doc.stages?.typecheck?.outputs?.tools || [];
  const toolsFinal =
    toolsOut.length > 0
      ? toolsOut
      : defaultTools.map((t) => ({
          ...t,
          status: 'skipped',
          command: '',
          exit_code: null,
          errors: [],
        }));

  if (passed) {
    doc = featureStages.markFeaturesCompleted(doc, 'typecheck', tcIds, { message: 'typecheck 通过' });
  } else {
    doc = featureStages.markFeaturesFailed(doc, 'typecheck', tcIds, {
      message: anyTimedOut ? 'typecheck 超时' : 'typecheck 工具报错',
    });
  }

  doc = stagesIo.updateStage(doc, 'typecheck', {
    status: ran === 0 ? 'completed' : anyFailed || anyTimedOut ? 'failed' : 'completed',
    started_at: doc.stages?.typecheck?.started_at || now,
    completed_at: now,
    inputs: {
      ...doc.stages?.typecheck?.inputs,
      summary_hash: hash,
      requires_stage: 'codegen',
      worktrees: wtList,
    },
    outputs: {
      ...doc.stages?.typecheck?.outputs,
      tools: toolsFinal,
      skip_reason: skipReason,
      duration_ms: 0,
      timed_out: anyTimedOut,
      timeout_reason: anyTimedOut ? 'typecheck_subcommand' : null,
    },
    validation: {
      ...doc.stages?.typecheck?.validation,
      passed,
      summary: 'ai-code3/scripts/typecheck.cjs',
    },
  });
  stagesIo.writeStagesSync(projectRoot, doc);

  if (exitCode !== 0) console.error('failed_stage=typecheck');
  return exitCode;
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

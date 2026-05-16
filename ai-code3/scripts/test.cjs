'use strict';

const fs = require('fs');
const path = require('path');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { runWithTimeout } = require('./lib/run-with-timeout.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');
const { invokeAiCode3Agent } = require('./lib/invoke-ai-code3-agent.cjs');
const { evaluateWorktreeTestCoverage } = require('./lib/test-level-gate.cjs');

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

function resolveTestSpecByFeatureId(doc, projectRoot) {
  const artifacts = doc.stages?.contract?.outputs?.artifacts || [];
  const byFeatureId = {};
  let defaultAbs = '';
  for (const art of artifacts) {
    const rel = art?.test_spec ? String(art.test_spec) : '';
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(projectRoot, rel);
    const fid = String(art?.feature_id || '').trim();
    if (fid) byFeatureId[fid] = abs;
    if (!defaultAbs) defaultAbs = abs;
  }
  return { byFeatureId, defaultAbs, artifactCount: artifacts.length };
}

/**
 * @param {object} doc
 * @param {string} projectRoot
 * @param {string[]} featureIdFilter
 * @returns {{ worktree_path: string, feature_id: string }[]}
 */
function resolveTestTargets(doc, projectRoot, featureIdFilter) {
  const cg = (doc.stages?.codegen?.outputs?.worktrees || []).filter((w) => w && w.worktree_path);
  let rows = cg.map((w) => {
    const raw = String(w.worktree_path);
    const worktree_path = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
    return {
      worktree_path,
      feature_id: String(w.feature_id || 'default'),
    };
  });
  if (featureIdFilter.length) {
    rows = rows.filter((r) => featureIdFilter.includes(r.feature_id));
  }
  if (rows.length === 0) {
    const tc0 = (doc.stages?.typecheck?.inputs?.worktrees || [])[0];
    const raw = tc0?.worktree_path ? String(tc0.worktree_path) : '';
    const p = raw
      ? path.isAbsolute(raw)
        ? path.resolve(raw)
        : path.resolve(projectRoot, raw)
      : projectRoot;
    rows = [{ worktree_path: p, feature_id: 'default' }];
  }
  return rows;
}

function skipTestFixAgent() {
  return (
    process.env.AI_CODE3_SKIP_AGENT === '1' ||
    process.env.AI_CODE3_SKIP_TEST_FIX_AGENT === '1' ||
    (!(process.env.AI_CODE3_AGENT_BIN || '').trim() && !(process.env.AI_CODEGEN_AGENT_BIN || '').trim())
  );
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
  const agentSubMs = Math.max(60_000, Math.floor(timeoutMs / 4));
  const gateModeRaw = String(config?.build?.test_level_gate?.mode || 'warn').toLowerCase();
  const levelGateMode = gateModeRaw === 'off' || gateModeRaw === 'warn' || gateModeRaw === 'enforce' ? gateModeRaw : 'warn';
  const levelGateFallback = Array.isArray(config?.build?.test_level_gate?.fallback_required_test_levels)
    ? config.build.test_level_gate.fallback_required_test_levels
    : [];
  const testSpecMap = resolveTestSpecByFeatureId(doc, projectRoot);

  const targets = resolveTestTargets(doc, projectRoot, options.featureIds || []);
  let testCmd = config?.build?.commands?.test || '';
  if (!testCmd) {
    const hasPkgInTargets =
      fs.existsSync(path.join(projectRoot, 'package.json')) ||
      targets.some((t) => fs.existsSync(path.join(t.worktree_path, 'package.json')));
    if (hasPkgInTargets) testCmd = 'npm test --if-present';
  }
  if (!testCmd) {
    const msg =
      'test blocked: set docs/config.dev.json build.commands.test or add package.json with npm test';
    console.error(msg);
    if (!options.dryRun) writeTerminal(projectRoot, doc, 'test', 'blocked', { summary: msg });
    return 1;
  }

  const fixCmd = config?.build?.commands?.test_fix;
  const noAgent = skipTestFixAgent();

  if (options.dryRun) {
    console.error(
      `[dry-run] test cmd=${testCmd} targets=${targets.map((t) => `${t.feature_id}:${t.worktree_path}`).join('; ')} test_fix_agent=${noAgent ? 'skipped' : 'on'}`
    );
    return 0;
  }

  const sessionId = options.sessionId || '';
  let hb;
  if (sessionId) {
    const { appendHeartbeat } = require('./lib/session-log.cjs');
    hb = setInterval(() => appendHeartbeat(projectRoot, sessionId, 'test', 'tick'), 30_000);
  }

  const perFeature = [];
  let overallTimedOut = false;
  let allPassed = true;

  try {
    for (const row of targets) {
      const cwd = row.worktree_path;
      if (!fs.existsSync(cwd)) {
        console.error(`failed_stage=test feature_id=${row.feature_id} missing worktree_path=${cwd}`);
        allPassed = false;
        perFeature.push({
          feature_id: row.feature_id,
          attempts: 0,
          result: 'failed',
          last_exit: 1,
        });
        break;
      }

      let lastCode = 1;
      let attempts = 0;
      let levelGateInfo = null;
      let failReason = '';

      for (let i = 0; i < maxAttempts; i++) {
        attempts += 1;
        const r = await runWithTimeout('sh', ['-c', testCmd], { cwd, timeoutMs });
        lastCode = r.timedOut ? 3 : r.code;
        if (r.timedOut) {
          overallTimedOut = true;
          break;
        }
        if (r.code === 0) {
          const testSpecAbs =
            testSpecMap.byFeatureId[row.feature_id] ||
            (testSpecMap.artifactCount === 1 ? testSpecMap.defaultAbs : '');
          const levelGate = evaluateWorktreeTestCoverage({
            projectRoot,
            worktreePath: cwd,
            testSpecAbs,
            fallbackRequiredLevels: levelGateFallback,
          });
          levelGateInfo = levelGate;
          if (levelGate.required_levels.length && levelGate.missing_levels.length) {
            const msg = `missing required test levels=${levelGate.missing_levels.join(',')}`;
            if (levelGateMode === 'enforce') {
              lastCode = 4;
              failReason = 'test_level_gate';
              break;
            }
            if (levelGateMode === 'warn') {
              console.error(
                `test_level_gate warning feature_id=${row.feature_id} ${msg} source=${levelGate.source}`
              );
            }
          }
          lastCode = 0;
          break;
        }
        if (i < maxAttempts - 1) {
          if (fixCmd) {
            const fr = await runWithTimeout('sh', ['-c', fixCmd], { cwd, timeoutMs });
            if (fr.timedOut) {
              lastCode = 3;
              overallTimedOut = true;
              break;
            }
          }
          if (!noAgent) {
            const ar = await invokeAiCode3Agent({
              worktreePath: cwd,
              projectRoot,
              phase: 'test_fix',
              featureId: row.feature_id,
              timeoutMs: agentSubMs,
              extraEnv: {},
            });
            if (!ar.ok && ar.code === 3) {
              lastCode = 3;
              overallTimedOut = true;
              break;
            }
          }
        }
      }

      const passed = lastCode === 0 && !overallTimedOut;
      perFeature.push({
        feature_id: row.feature_id,
        attempts,
        result: passed
          ? 'passed'
          : overallTimedOut || lastCode === 3 || failReason === 'test_level_gate'
            ? 'failed'
            : 'failed_max_attempts',
        last_exit: lastCode,
        fail_reason: failReason || null,
        test_level_gate: levelGateInfo || null,
      });
      if (!passed) {
        allPassed = false;
        break;
      }
    }
  } finally {
    if (hb) clearInterval(hb);
  }

  const lastRow = perFeature[perFeature.length - 1];
  const lastCode = lastRow?.last_exit ?? 1;
  const passed = allPassed;
  const result = passed
    ? 'passed'
    : overallTimedOut || lastCode === 3 || lastRow?.fail_reason === 'test_level_gate'
      ? 'failed'
      : 'failed_max_attempts';

  const hash = summaryHash.computeUpstreamHashForStage(doc, 'test', projectRoot, options.featureIds);
  const wtList = targets.map((t) => ({
    feature_id: t.feature_id,
    worktree_path: t.worktree_path,
    branch: '',
  }));

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
      attempts: perFeature.reduce((a, p) => a + p.attempts, 0),
      per_feature: perFeature,
      test_level_gate: {
        mode: levelGateMode,
        fallback_required_test_levels: levelGateFallback,
        test_spec: testSpecMap.defaultAbs || '',
        test_spec_by_feature: testSpecMap.byFeatureId,
      },
      result,
      log_path: '',
      failure_summary: passed ? '' : `per_feature=${JSON.stringify(perFeature)}`,
      duration_ms: 0,
      timed_out: overallTimedOut || lastCode === 3,
      timeout_reason: overallTimedOut || lastCode === 3 ? 'test_command' : null,
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
          reason: 'test failures after max fix attempts (see outputs.failure_summary / per_feature)',
        },
  });
  stagesIo.writeStagesSync(projectRoot, doc);

  if (!passed) {
    console.error(`failed_stage=test result=${result}`);
    return overallTimedOut || lastCode === 3 ? 3 : 4;
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

'use strict';

const fs = require('fs');
const path = require('path');
const { stagesPath } = require('./lib/paths.cjs');
const { updateStages, readStages } = require('./lib/stages-io.cjs');
const { collectUiScenarios } = require('./lib/parse-ui-scenarios.cjs');
const { executeScenarios, isStubMode } = require('./lib/execute-scenarios.cjs');
const { writeUiE2eReport } = require('./lib/ui-e2e-report.cjs');
const { sha256Stable, uiE2eSummaryInput } = require('./lib/summary-hash.cjs');
const { invokeE2eAgent } = require('./lib/invoke-e2e-agent.cjs');
const { runWithTimeout } = require('./lib/run-with-timeout.cjs');

function stageTimeoutS(config) {
  const v = config?.timeouts?.stages?.ui_e2e_s;
  return typeof v === 'number' && v > 0 ? v : 3600;
}

function uiE2eCompleted(stage, expectedHash, forceRerun) {
  if (!stage || forceRerun) return false;
  if (stage.status !== 'completed' || !stage.validation?.passed) return false;
  if (expectedHash && stage.inputs?.summary_hash && stage.inputs.summary_hash !== expectedHash) return false;
  return true;
}

async function runUiTestFix(projectRoot, config, failedResults, outputDir) {
  const bin =
    process.env.AI_E2E3_AGENT_BIN ||
    process.env.AI_CODE3_AGENT_BIN ||
    '';
  if (!bin.trim() || process.env.AI_E2E3_SKIP_FIX_AGENT === '1') {
    return { attempted: false, ok: false };
  }
  const summary = failedResults.map((r) => `${r.scenario_id}: ${r.error}`).join('\n');
  const prompt = [
    'You are ai-e2e3 ui_test_fix agent.',
    'Fix implementation source under src/ to address UI E2E failures.',
    'Do NOT modify docs/contracts.',
    'Failures:',
    summary,
  ].join('\n');
  const args = path.basename(bin).toLowerCase() === 'cursor-agent' ? ['--print', '--trust', prompt] : [prompt];
  const r = await runWithTimeout(bin, args, {
    cwd: projectRoot,
    timeoutMs: 600000,
    env: { ...process.env, AI_E2E3_PHASE: 'ui_test_fix', AI_E2E3_PROJECT: projectRoot },
  });
  return { attempted: true, ok: !r.timedOut && r.code === 0 };
}

/**
 * @returns {Promise<{ code: number, message?: string, failed_step?: string }>}
 */
async function runUiE2e(projectRoot, opts = {}) {
  const stPath = stagesPath(projectRoot);
  const config = opts.config;
  const dryRun = !!opts.dryRun;
  const forceRerun = !!opts.forceRerun;
  const sessionId = opts.sessionId || `sess-${Date.now()}`;
  const maxFix =
    config.ui_e2e?.commands?.ui_test_max_fix_attempts ??
    config.build?.commands?.test_max_fix_attempts ??
    3;

  const { scenarios, sources } = collectUiScenarios(projectRoot, config);
  const hashIn = uiE2eSummaryInput({ scenarios, sources, baseUrls: {} });
  const expectedHash = sha256Stable(hashIn);

  const doc0 = readStages(stPath);
  if (uiE2eCompleted(doc0.stages?.ui_e2e, expectedHash, forceRerun) && !dryRun) {
    return { code: 0, message: 'ui_e2e: skipped (already completed)' };
  }

  if (!scenarios.length) {
    if (opts.requireUiE2e) {
      return { code: 1, message: '无 ui_scenarios 但 --require-ui-e2e', failed_step: 'ui_e2e' };
    }
    if (!dryRun) {
      updateStages(stPath, (doc) => {
        doc.stages.ui_e2e = doc.stages.ui_e2e || {};
        doc.stages.ui_e2e.status = 'completed';
        doc.stages.ui_e2e.completed_at = new Date().toISOString();
        doc.stages.ui_e2e.inputs = {
          summary_hash: expectedHash,
          requires_stage: 'smoke',
          scenario_sources: sources,
        };
        doc.stages.ui_e2e.outputs = {
          scenarios_total: 0,
          scenarios_passed: 0,
          scenarios_failed: 0,
          results: [],
          report_path: '',
          fix_attempts: 0,
          skip_reason: 'no ui_scenarios in contracts',
          duration_ms: 0,
          timed_out: false,
          timeout_reason: null,
        };
        doc.stages.ui_e2e.validation = {
          passed: true,
          checked_at: new Date().toISOString(),
          summary: 'skipped: no scenarios',
          warnings: [],
        };
      });
    }
    return { code: 0, message: 'ui_e2e: skipped (no scenarios)' };
  }

  if (dryRun) {
    console.error(`[dry-run] ui_e2e scenarios=${scenarios.length} stub=${isStubMode(config)}`);
    return { code: 0 };
  }

  const t0 = Date.now();
  const outDir = path.join(projectRoot, '.agent-sessions', 'ui-e2e', sessionId);
  fs.mkdirSync(outDir, { recursive: true });

  let fixAttempts = 0;
  let results = [];
  const timeoutMs = stageTimeoutS(config) * 1000;

  while (fixAttempts <= maxFix) {
    const outputJson = path.join(outDir, `result-attempt-${fixAttempts}.json`);
    results = await executeScenarios({
      projectRoot,
      config,
      stagesDoc: readStages(stPath),
      scenarios,
      outputJsonPath: outputJson,
      agentTimeoutMs: Math.min(timeoutMs, 600000),
    });
    const failed = results.filter((r) => !r.passed);
    if (failed.length === 0) break;
    if (fixAttempts >= maxFix) break;
    const fix = await runUiTestFix(projectRoot, config, failed, outDir);
    if (!fix.attempted || !fix.ok) break;
    fixAttempts += 1;
  }

  const passed = results.filter((r) => r.passed).length;
  const failedN = results.length - passed;
  const allOk = failedN === 0;
  const reportPath = writeUiE2eReport(projectRoot, sessionId, results, {
    stub: isStubMode(config),
    total: results.length,
    passed,
    failed: failedN,
    fix_attempts: fixAttempts,
  });

  updateStages(stPath, (doc) => {
    doc.stages.ui_e2e = doc.stages.ui_e2e || {};
    doc.stages.ui_e2e.status = allOk ? 'completed' : 'failed';
    doc.stages.ui_e2e.completed_at = new Date().toISOString();
    doc.stages.ui_e2e.inputs = {
      summary_hash: expectedHash,
      requires_stage: 'smoke',
      scenario_sources: sources,
    };
    doc.stages.ui_e2e.outputs = {
      scenarios_total: results.length,
      scenarios_passed: passed,
      scenarios_failed: failedN,
      results,
      report_path: path.relative(projectRoot, reportPath),
      fix_attempts: fixAttempts,
      skip_reason: '',
      duration_ms: Date.now() - t0,
      timed_out: false,
      timeout_reason: null,
    };
    doc.stages.ui_e2e.validation = {
      passed: allOk,
      checked_at: new Date().toISOString(),
      summary: allOk ? 'ui_e2e passed' : `ui_e2e failed (${failedN}/${results.length})`,
      warnings: [],
    };
    doc.pipeline = doc.pipeline || {};
    doc.pipeline.last_completed_stage = allOk ? 'ui_e2e' : doc.pipeline.last_completed_stage;
    doc.pipeline.updated_at = new Date().toISOString();
    doc.pipeline.updated_by = 'ai-e2e3';
  });

  if (!allOk) {
    console.error('failed_step=ui_e2e');
    return { code: 4, message: `ui_e2e: ${failedN} scenario(s) failed`, failed_step: 'ui_e2e' };
  }
  return { code: 0, message: 'ui_e2e: passed' };
}

module.exports = { runUiE2e };

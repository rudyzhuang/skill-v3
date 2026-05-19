'use strict';

/**
 * pipeline-recovery 确定性自测（无 Agent）
 *   node ai-std4/scripts/self-test-pipeline-recovery.cjs
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const skillsRoot = process.env.CURSOR_SKILLS_ROOT
  ? path.resolve(process.env.CURSOR_SKILLS_ROOT)
  : path.resolve(__dirname, '../..');

const {
  shouldAttemptRecovery,
  assembleErrorBundle,
  validateRecovery,
  countRecoveryAttempts,
  stepToLogStages,
  readRecoveryConfig,
  scanLogTailForSignatures,
  collectCodegenWorkerExcerpts,
  clearStaleCodegenWorkers,
  shouldClearCodegenWorkers,
  touchesCodegenSkillPath,
  resetCodegenSdkFailures,
  shouldResetCodegenSdkFailures,
} = require('./libs/pipeline-recovery.cjs');

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`OK: ${msg}`);
  }
}

// 1. step → log stages
assert(
  JSON.stringify(stepToLogStages('design_phase')) === '["design","design-review"]',
  'design_phase log stages'
);
assert(
  stepToLogStages('prd-review')[0] === 'prd-review',
  'prd-review log stage'
);

// 2. shouldAttemptRecovery
const stages = {
  pipeline: { recovery_history: [] },
  stages: {},
};
delete process.env.CURSOR_API_KEY;
const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-recovery-'));
fs.mkdirSync(path.join(tmpProject, 'docs'), { recursive: true });
fs.writeFileSync(
  path.join(tmpProject, 'docs', 'config.dev.json'),
  JSON.stringify({ pipeline: { recovery: { enabled: true } } }),
  'utf8'
);

let r = shouldAttemptRecovery({ step: 'prd-review', exitCode: 4, projectRoot: tmpProject, stages, runId: 't' });
assert(r.ok === false && r.reason === 'no_api_key', 'no api key → skip');

process.env.CURSOR_API_KEY = 'test-key';
r = shouldAttemptRecovery({ step: 'report', exitCode: 4, projectRoot: tmpProject, stages, runId: 't' });
assert(r.ok === false && r.reason === 'step_excluded', 'report excluded');

r = shouldAttemptRecovery({ step: 'deploy', exitCode: 9, projectRoot: tmpProject, stages, runId: 't' });
assert(r.ok === false && r.reason === 'exit_code_9', 'exit 9 not recoverable');

r = shouldAttemptRecovery({ step: 'prd-review', exitCode: 4, projectRoot: tmpProject, stages, runId: 't' });
assert(r.ok === true, 'exit 4 recoverable with agent');

stages.pipeline.recovery_history = [
  { stage: 'prd-review', run_id: 't', exit_code: 4, attempt: 1 },
  { stage: 'prd-review', run_id: 't', exit_code: 4, attempt: 2 },
];
assert(countRecoveryAttempts(stages, 'prd-review', 't', 4) === 2, 'history count per exit_code');
r = shouldAttemptRecovery({ step: 'prd-review', exitCode: 4, projectRoot: tmpProject, stages, runId: 't' });
assert(r.ok === false && r.reason === 'max_attempts_reached', 'max attempts same exit_code');

stages.pipeline.recovery_history.push(
  { stage: 'build_phase', run_id: 't', exit_code: 3, attempt: 1 },
  { stage: 'build_phase', run_id: 't', exit_code: 3, attempt: 2 },
);
assert(countRecoveryAttempts(stages, 'build_phase', 't', 3) === 2, 'build_phase exit 3 attempts');
r = shouldAttemptRecovery({ step: 'build_phase', exitCode: 4, projectRoot: tmpProject, stages, runId: 't' });
assert(r.ok === true, 'exit 4 recoverable after exit 3 attempts exhausted');

// 3. error signature scan
const sig = scanLogTailForSignatures({
  codegen: ['[ERROR] Cannot find module \'@cursor/sdk\''],
});
assert(sig.signature_ids.includes('sdk_module_not_found'), 'scan sdk signature');

// 4. worker excerpts + clear
const workerDir = path.join(tmpProject, '.pipeline', 'workers', 'codegen');
fs.mkdirSync(workerDir, { recursive: true });
const workerPath = path.join(workerDir, 'worker-TEST-001-1.tmp.cjs');
fs.writeFileSync(workerPath, "const x = require('@cursor/sdk');\n", 'utf8');
const excerpts = collectCodegenWorkerExcerpts(tmpProject, 8000);
assert(excerpts.length >= 1 && excerpts[0].hint, 'worker excerpt hints stale template');
const cleared = clearStaleCodegenWorkers(tmpProject, null);
assert(cleared.removed.includes('worker-TEST-001-1.tmp.cjs'), 'clear stale tmp workers');

// 5. assemble bundle (enriched)
const bundle = assembleErrorBundle({
  projectRoot: tmpProject,
  skillsRoot,
  step:        'build_phase',
  exitCode:    4,
  runId:       'test-run',
  attempt:     1,
  stages:      {
    stages: {
      codegen: {
        status: 'failed',
        features: { 'AUTH-001': { status: 'failed', error: 'sdk' } },
        outputs: { failed_features: ['AUTH-001'] },
      },
    },
  },
});
assert(bundle.failed_stage === 'build_phase' && bundle.recovery === null, 'bundle shape');
assert(Array.isArray(bundle.recovery_hints) && bundle.recovery_hints.length > 0, 'bundle recovery_hints');
assert(Array.isArray(bundle.failed_features) && bundle.failed_features.length >= 1, 'bundle failed_features');
assert(Array.isArray(bundle.error_signatures.signature_ids), 'bundle error_signatures');

// 6. shouldClearCodegenWorkers
const cfg = readRecoveryConfig(tmpProject);
assert(
  shouldClearCodegenWorkers({
    recovery: { decision: 'fix', repair_target: 'skill', category: 'script_bug', files_changed: ['ai-std4/scripts/stages/codegen.cjs'] },
    step: 'build_phase',
    cfg,
  }),
  'clear workers on skill codegen fix'
);
assert(touchesCodegenSkillPath(['ai-std4/scripts/stages/codegen.cjs']), 'touchesCodegenSkillPath');
assert(touchesCodegenSkillPath(['ai-std4/scripts/run-pipeline.cjs']), 'touches run-pipeline orchestration');

// 6b. reset codegen SDK failures
const stagesSdk = {
  stages: {
    codegen: {
      status: 'failed',
      features: {
        'AUTH-001': { status: 'failed', error: "Cannot find module '@cursor/sdk'", attempts_used: 2 },
        'AUTH-002': { status: 'blocked', error: 'dependency_failed:AUTH-001', attempts_used: 0 },
      },
      outputs: { failed_features: ['AUTH-001'], decision: 'needs_fix' },
    },
  },
};
const resetResult = resetCodegenSdkFailures(tmpProject, stagesSdk, null);
assert(resetResult.reset.includes('AUTH-001') && resetResult.reset.includes('AUTH-002'), 'reset sdk failed + blocked deps');
assert(stagesSdk.stages.codegen.features['AUTH-001'].status === 'pending', 'failed → pending');
assert(stagesSdk.stages.codegen.status === 'running', 'codegen stage running after reset');
assert(
  shouldResetCodegenSdkFailures({
    recovery: { decision: 'fix', category: 'script_bug', evidence: ["Cannot find module '@cursor/sdk'"] },
    step: 'build_phase',
    bundle: { error_signatures: { signature_ids: ['sdk_module_not_found'] }, failed_features: [] },
    cfg: { clearStaleCodegenWorkers: true },
  }),
  'shouldResetCodegenSdkFailures'
);

// 7. Ajv
const sample = {
  decision:      'retry_only',
  repair_target: 'none',
  category:      'transient',
  reason:        '瞬态错误，重试即可',
  evidence:      [],
};
const { valid, errors } = validateRecovery(sample, skillsRoot);
assert(valid, `ajv valid retry_only (${JSON.stringify(errors)})`);

const bad = { decision: 'fix', repair_target: 'skill', category: 'unknown' };
assert(!validateRecovery(bad, skillsRoot).valid, 'ajv rejects missing reason');

// 8. config defaults
const cfg2 = readRecoveryConfig(tmpProject);
assert(cfg2.enabled === true && cfg2.recoverableExitCodes.includes(4), 'config defaults');
assert(cfg2.runSelfTestAfterSkillFix === true && cfg2.clearStaleCodegenWorkers === true, 'config recovery flags');

delete process.env.CURSOR_API_KEY;
fs.rmSync(tmpProject, { recursive: true, force: true });

console.log(failed === 0 ? '\nAll self-tests passed.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

'use strict';

/**
 * pipeline-recovery 确定性自测（无 Agent）
 *   node ai-std4/scripts/self-test-pipeline-recovery.cjs
 */

const path = require('path');
const fs   = require('fs');

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
const tmpProject = fs.mkdtempSync(path.join(require('os').tmpdir(), 'std4-recovery-'));
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
  { stage: 'prd-review', run_id: 't', attempt: 1 },
  { stage: 'prd-review', run_id: 't', attempt: 2 },
];
assert(countRecoveryAttempts(stages, 'prd-review', 't') === 2, 'history count');
r = shouldAttemptRecovery({ step: 'prd-review', exitCode: 4, projectRoot: tmpProject, stages, runId: 't' });
assert(r.ok === false && r.reason === 'max_attempts_reached', 'max attempts');

delete process.env.CURSOR_API_KEY;

// 3. assemble bundle
const bundle = assembleErrorBundle({
  projectRoot: tmpProject,
  skillsRoot,
  step:        'prd-review',
  exitCode:    4,
  runId:       'test-run',
  attempt:     1,
  stages:      { stages: { prd_review: { status: 'failed' } } },
});
assert(bundle.failed_stage === 'prd-review' && bundle.recovery === null, 'bundle shape');

// 4. Ajv
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

// 5. config defaults
const cfg = readRecoveryConfig(tmpProject);
assert(cfg.enabled === true && cfg.recoverableExitCodes.includes(4), 'config defaults');

fs.rmSync(tmpProject, { recursive: true, force: true });

console.log(failed === 0 ? '\nAll self-tests passed.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

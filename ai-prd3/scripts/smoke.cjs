#!/usr/bin/env node
'use strict';

/**
 * ai-prd3 冒烟：临时目录跑 bootstrap → validate → write → prd-review；
 * 附录 B 扫描；bootstrap 在 prd 完成后无 --force 须失败。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join(ROOT, 'scripts', 'run.cjs');
const SELF_TEST = path.join(ROOT, 'scripts', 'self-test-secret-scan.cjs');

function run(args, cwd) {
  const r = spawnSync(process.execPath, [RUN, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, AI_PRD3_NO_TIMEOUT: '1' },
  });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function main() {
  require(SELF_TEST);

  const { validatePrdReviewMergePayload } = require('./lib/prd-review-payload.cjs');
  assert.strictEqual(validatePrdReviewMergePayload({}).ok, false);
  assert.strictEqual(validatePrdReviewMergePayload({ outputs: { decision: 'passed' } }).ok, true);

  const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ai-prd3-smoke-'));

  let r = run(['bootstrap', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, `bootstrap ${r.stderr}`);

  r = run(['validate-prd', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 1, '缺派生文件时应 validate 失败');

  for (const slug of ['website', 'backend']) {
    const dir = path.join(TMP, 'docs', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'prd.md'),
      '# prd\n\nThis paragraph is long enough for derived validation minimum length.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'feature_list.md'),
      [
        '## Features',
        '',
        '| Feature ID | Area | Name | Status | Priority | Phase | Related Targets | Acceptance Summary |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| FEAT-SMOKE-001 | core | Smoke | draft | must | mvp |  | ok |',
        '',
        '## Feature Details',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  r = run(['validate-prd', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);

  r = run(['write-prd', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);

  const stages1 = JSON.parse(fs.readFileSync(path.join(TMP, '.pipeline', 'stages.json'), 'utf8'));
  assert.strictEqual(stages1.stages.prd.status, 'completed');
  assert.strictEqual(stages1.stages.prd.inputs.summary_hash.length, 64);
  const rf = stages1.stages.prd.validation.required_files;
  assert.ok(Array.isArray(rf));
  assert.ok(rf.every((x) => x.exists === true && x.valid === true), 'required_files 应全部存在');

  r = run(['bootstrap', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 1, 'prd 已完成时 bootstrap 无 --force 应失败');

  r = run(['bootstrap', `--project=${TMP}`, '--force'], ROOT);
  assert.strictEqual(r.status, 0, 'bootstrap --force 应成功');

  r = run(['validate-prd', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, 'force 后应能再次 validate-prd');
  r = run(['write-prd', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, 'force 后应能再次 write-prd');

  const reviewPath = path.join(TMP, '.pipeline', 'review-out.json');
  fs.writeFileSync(
    reviewPath,
    JSON.stringify({
      review: {
        summary: 'smoke',
        phase_plan: [
          {
            phase: 'mvp',
            feature_ids: ['FEAT-SMOKE-001'],
            goal: 'g',
            exit_criteria: ['c'],
          },
        ],
      },
      outputs: { decision: 'passed' },
      blocking_issues: [],
      conditions: [],
    }),
    'utf8',
  );

  r = run(['write-prd-review', `--project=${TMP}`, `--json=${reviewPath}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['validate-prd-review', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);

  const stages2 = JSON.parse(fs.readFileSync(path.join(TMP, '.pipeline', 'stages.json'), 'utf8'));
  assert.strictEqual(stages2.stages.prd_review.status, 'completed');
  assert.strictEqual(stages2.stages.prd_review.outputs.can_enter_design, true);
  assert.strictEqual(stages2.stages.prd_review.inputs.summary_hash.length, 64);

  const scan = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'prd-validate-config.cjs'), `--project=${TMP}`],
    { encoding: 'utf8', cwd: ROOT },
  );
  assert.strictEqual(scan.status, 0, '默认 config 应通过');

  const devReal = path.join(TMP, 'docs', 'config.dev.json');
  const backup = fs.readFileSync(devReal, 'utf8');
  const jBad = JSON.parse(backup);
  jBad.api_key = 'x';
  fs.writeFileSync(devReal, JSON.stringify(jBad, null, 2), 'utf8');
  const bad = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'prd-validate-config.cjs'), `--project=${TMP}`],
    { encoding: 'utf8', cwd: ROOT },
  );
  fs.writeFileSync(devReal, backup, 'utf8');
  assert.strictEqual(bad.status, 1, '含 api_key 的 config 须扫描失败');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('smoke: all passed');
}

main();

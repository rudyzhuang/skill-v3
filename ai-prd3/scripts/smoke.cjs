#!/usr/bin/env node
'use strict';

/**
 * ai-prd3 冒烟：临时目录跑 bootstrap → validate → write → prd-review；
 * 附录 B；prd3.md §12 关键负面用例；JSON Schema（AJV）合并校验。
 * 连续执行两轮（main 末尾）以满足「连续两轮评审」门闸。
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

function featureListBody(slug) {
  return [
    '# Feature List',
    '',
    '## Metadata',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| client_target | ${slug} |`,
    '',
    '## Status Values',
    '',
    '- `draft`',
    '',
    '## Features',
    '',
    '| Feature ID | Area | Name | Status | Priority | Phase | Related Targets | Acceptance Summary |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| FEAT-SMOKE-001 | core | Smoke | draft | must | mvp |  | ok |',
    '',
    '## Feature Details',
    '',
    '### FEAT-SMOKE-001: Smoke',
    '',
    '- Area: core',
    '',
  ].join('\n');
}

function runOneSmokeRound(roundLabel) {
  const { validatePrdReviewMergePayload } = require('./lib/prd-review-payload.cjs');
  assert.strictEqual(validatePrdReviewMergePayload({}, ROOT).ok, false);
  assert.strictEqual(validatePrdReviewMergePayload({ outputs: { decision: 'passed' } }, ROOT).ok, false);
  const validReview = {
    review: {
      summary: 'ok',
      phase_plan: [
        {
          phase: 'mvp',
          feature_ids: ['FEAT-SMOKE-001'],
          goal: 'goal',
          exit_criteria: ['c1'],
        },
      ],
    },
    outputs: { decision: 'passed' },
    blocking_issues: [],
    conditions: [],
  };
  assert.strictEqual(validatePrdReviewMergePayload(validReview, ROOT).ok, true);

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
    fs.writeFileSync(path.join(dir, 'feature_list.md'), featureListBody(slug), 'utf8');
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

  const badSchemaPath = path.join(TMP, '.pipeline', 'review-bad-schema.json');
  fs.writeFileSync(badSchemaPath, JSON.stringify({ outputs: { decision: 'passed' } }), 'utf8');
  r = run(['write-prd-review', `--project=${TMP}`, `--json=${badSchemaPath}`], ROOT);
  assert.strictEqual(r.status, 1, '不合 schema 的 JSON 应拒绝合并');

  const condPath = path.join(TMP, '.pipeline', 'review-conditional.json');
  fs.writeFileSync(
    condPath,
    JSON.stringify({
      review: {
        summary: 'cond',
        phase_plan: [
          {
            phase: 'mvp',
            feature_ids: ['FEAT-SMOKE-001'],
            goal: 'g',
            exit_criteria: ['e'],
          },
        ],
      },
      outputs: { decision: 'conditional_passed' },
      blocking_issues: [],
      conditions: [{ id: 'c1', text: 'need work' }],
    }),
    'utf8',
  );
  r = run(['write-prd-review', `--project=${TMP}`, `--json=${condPath}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['validate-prd-review', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 1, 'conditional_passed 终检须失败');
  const stagesCond = JSON.parse(fs.readFileSync(path.join(TMP, '.pipeline', 'stages.json'), 'utf8'));
  assert.strictEqual(stagesCond.stages.prd_review.status, 'failed');

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

  r = run(['finalize-prd-review', `--project=${TMP}`, `--json=${reviewPath}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);

  const implReport = path.join(TMP, '.pipeline', 'reports', 'prd-implementation-summary.md');
  assert.ok(fs.existsSync(implReport), '终检通过应生成实施节奏摘要');
  const implBody = fs.readFileSync(implReport, 'utf8');
  assert.ok(implBody.includes('AI 评审门闸结果'), implBody);
  assert.ok(implBody.includes('分几期做'), implBody);
  assert.ok(implBody.includes('第一期做完'), implBody);

  r = run(['report', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('分几期做'), 'report 子命令应在 stdout 输出摘要');

  const stages2 = JSON.parse(fs.readFileSync(path.join(TMP, '.pipeline', 'stages.json'), 'utf8'));
  assert.strictEqual(stages2.stages.prd_review.status, 'completed');
  assert.strictEqual(stages2.stages.prd_review.outputs.can_enter_design, true);
  assert.strictEqual(stages2.stages.prd_review.inputs.summary_hash.length, 64);

  r = run(['bootstrap', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 1, 'prd 已完成时 bootstrap 无 --force 应失败');

  r = run(['bootstrap', `--project=${TMP}`, '--force'], ROOT);
  assert.strictEqual(r.status, 0, 'bootstrap --force 应成功');

  r = run(['validate-prd', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, 'force 后应能再次 validate-prd');
  r = run(['write-prd', `--project=${TMP}`], ROOT);
  assert.strictEqual(r.status, 0, 'force 后应能再次 write-prd');

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

  const TMP2 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ai-prd3-smoke-'));
  r = run(['bootstrap', `--project=${TMP2}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr);
  let spec = fs.readFileSync(path.join(TMP2, 'docs', 'prd-spec.md'), 'utf8');
  spec = spec.replace(/^##\s+端\s*\(Client Targets\)\s*$/m, '## Bad Client Targets Heading');
  fs.writeFileSync(path.join(TMP2, 'docs', 'prd-spec.md'), spec, 'utf8');
  r = run(['validate-prd', `--project=${TMP2}`], ROOT);
  assert.strictEqual(r.status, 1, '缺少 §6.1 端标题时应 validate 失败');
  fs.rmSync(TMP2, { recursive: true, force: true });

  const TMP3 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ai-prd3-smoke-'));
  r = run(['bootstrap', `--project=${TMP3}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr);
  spec = fs.readFileSync(path.join(TMP3, 'docs', 'prd-spec.md'), 'utf8');
  spec = spec.replace(/`website`/m, '`not_a_valid_target`');
  fs.writeFileSync(path.join(TMP3, 'docs', 'prd-spec.md'), spec, 'utf8');
  r = run(['validate-prd', `--project=${TMP3}`], ROOT);
  assert.strictEqual(r.status, 1, '非法 client_target slug 时应失败');
  fs.rmSync(TMP3, { recursive: true, force: true });

  const TMP4 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ai-prd3-smoke-'));
  r = run(['bootstrap', `--project=${TMP4}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const slug of ['website', 'backend']) {
    const dir = path.join(TMP4, 'docs', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'prd.md'),
      '# prd\n\nThis paragraph is long enough for derived validation minimum length.\n',
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'feature_list.md'), featureListBody(slug), 'utf8');
  }
  r = run(['write-prd', `--project=${TMP4}`], ROOT);
  assert.strictEqual(r.status, 0, r.stderr);
  spec = fs.readFileSync(path.join(TMP4, 'docs', 'prd-spec.md'), 'utf8');
  fs.writeFileSync(path.join(TMP4, 'docs', 'prd-spec.md'), `${spec}\n`, 'utf8');
  r = run(['validate-prd', `--project=${TMP4}`], ROOT);
  assert.strictEqual(r.status, 1, 'prd-spec 漂移后 validate-prd 须失败（prd_spec_drift）');
  fs.rmSync(TMP4, { recursive: true, force: true });

  console.log(`smoke: all passed (${roundLabel})`);
}

function main() {
  require(SELF_TEST);
  runOneSmokeRound('round-1');
  runOneSmokeRound('round-2');
}

main();

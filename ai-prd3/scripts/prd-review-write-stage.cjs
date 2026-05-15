'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, requireProject, stagesPath, skillDirFrom } = require('./lib/paths.cjs');
const { deepMerge } = require('./lib/merge-stages.cjs');

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  if (!args.json) {
    console.error('缺少 --json=<prd-review-output.json>');
    process.exit(1);
  }
  const jsonPath = path.isAbsolute(args.json) ? args.json : path.join(root, args.json);
  if (!fs.existsSync(jsonPath)) {
    console.error('找不到 JSON 文件:', jsonPath);
    process.exit(1);
  }

  const stagesFile = stagesPath(root);
  const stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  const prd = stages.stages?.prd;
  if (prd?.status !== 'completed' || !prd?.validation?.passed) {
    console.error('前置门闸：须先完成 prd（stages.prd.status=completed 且 validation.passed=true）');
    process.exit(1);
  }
  const pr = stages.stages?.prd_review;
  if (pr?.status === 'completed' && pr?.validation?.passed && !args.force) {
    console.error('prd_review 已完成：覆盖须加 --force');
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const skillDir = skillDirFrom(__filename);
  const { validatePrdReviewMergePayload } = require('./lib/prd-review-payload.cjs');
  const pv = validatePrdReviewMergePayload(payload, skillDir);
  if (!pv.ok) {
    console.error(JSON.stringify({ ok: false, errors: pv.errors }, null, 2));
    process.exit(1);
  }
  const now = new Date().toISOString();
  const base = stages.stages.prd_review || {};
  const patch = {};
  if (payload.review) patch.review = deepMerge(base.review || {}, payload.review);
  if (payload.outputs) patch.outputs = deepMerge(base.outputs || {}, payload.outputs);
  if (payload.blocking_issues) patch.blocking_issues = payload.blocking_issues;
  if (payload.conditions) patch.conditions = payload.conditions;

  stages.stages.prd_review = deepMerge(base, patch);
  stages.stages.prd_review.status = 'running';
  stages.stages.prd_review.validation = stages.stages.prd_review.validation || {};
  stages.stages.prd_review.validation.passed = false;
  stages.stages.prd_review.inputs = stages.stages.prd_review.inputs || {};
  stages.stages.prd_review.inputs.summary_hash = '';
  stages.stages.prd_review.inputs.feature_lists = (stages.client_targets?.declared || []).map(
    (s) => `docs/${s}/feature_list.md`,
  );

  stages.pipeline = stages.pipeline || {};
  stages.pipeline.updated_at = now;
  stages.pipeline.updated_by = 'ai-prd3';

  fs.writeFileSync(stagesFile, `${JSON.stringify(stages, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, merged_from: jsonPath }, null, 2));
}

main();

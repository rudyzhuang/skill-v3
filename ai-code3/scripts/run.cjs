'use strict';

const path = require('path');
const { parseCommonArgs, normalizeStageKey, filterOrder } = require('./lib/cli-args.cjs');
const { shouldSkipStage } = require('./lib/summary-hash.cjs');

const stageFile = {
  codegen: 'codegen.cjs',
  typecheck: 'typecheck.cjs',
  test: 'test.cjs',
  code_review: 'code-review.cjs',
  merge_push: 'merge-push.cjs',
  build: 'build.cjs',
};

async function runStage(key, ctx) {
  const file = stageFile[key];
  return require(path.join(__dirname, file)).run(ctx);
}

async function main() {
  const options = parseCommonArgs(process.argv);
  if (!options.project) {
    console.error('missing --project=<absolute path to business project root>');
    process.exit(1);
  }
  if (!path.isAbsolute(options.project)) {
    console.error('--project must be an absolute path');
    process.exit(1);
  }

  const pre = await require('./preflight.cjs').run({ projectRoot: options.project, options });
  if (pre !== 0) {
    console.error('failed_stage=preflight');
    process.exit(pre);
  }

  const sub = options.subcommand;
  if (sub === 'preflight') {
    process.exit(0);
  }

  const fromK = normalizeStageKey(options.fromStage);
  const toK = normalizeStageKey(options.toStage);
  const order = sub === 'all' ? filterOrder(fromK, toK) : [normalizeStageKey(sub.replace(/-/g, '_'))];

  if (order.some((k) => !k)) {
    console.error(`unknown stage or subcommand: ${sub}`);
    process.exit(1);
  }

  const stagesIo = require('./lib/stages-io.cjs');
  let doc = stagesIo.readStagesSync(options.project);

  const ctx = { projectRoot: options.project, options };

  for (const stageKey of order) {
    if (shouldSkipStage(doc, stageKey, options.project, options.featureIds, options.forceRerun)) {
      console.error(`skip stage=${stageKey} (completed+passed+summary_hash matches upstream)`);
      continue;
    }
    const code = await runStage(stageKey, ctx);
    if (code !== 0) {
      console.error(`failed_stage=${stageKey}`);
      process.exit(code);
    }
    doc = stagesIo.readStagesSync(options.project);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

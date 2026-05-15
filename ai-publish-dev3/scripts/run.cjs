'use strict';

const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
const { runPreflight } = require('./preflight.cjs');
const { runDeploy } = require('./deploy.cjs');
const { runSmoke } = require('./smoke.cjs');

async function main() {
  const args = parseRunArgs(process.argv, { environment: 'dev' });
  const root = requireProject(args.project);

  const pf = runPreflight(root, { requireDeploy: args.requireDeploy });
  if (!pf.ok) {
    console.error('failed_step=deploy');
    console.error(pf.message);
    process.exit(1);
  }
  const config = pf.config;
  if (args.requireDeploy && !(config.deploy && config.deploy.enabled)) {
    console.error('failed_step=deploy');
    console.error('显式 --require-deploy 但 deploy.enabled=false → 退出 1（见 publish3.md §5.1）');
    process.exit(1);
  }

  const startFromSmoke = args.fromStage === 'smoke';

  if (!startFromSmoke) {
    if (config.deploy && config.deploy.enabled && !args.dryRun && !args.invokedByAutorun && !args.explicitConfirm) {
      console.error('failed_step=deploy');
      console.error(
        '手工 dev deploy 为 destructive（input-spec §7.2）：须传入 --explicit-confirm，表示已在对话/评审中确认后再执行；或使用 --dry-run。autorun 调用请勿传本开关，应使用 --invoked-by-autorun + pipeline.autorun.allow_destructive_deploy（publish3.md §5.1.1 / §5.2）。'
      );
      process.exit(1);
    }

    if (config.deploy && config.deploy.enabled && args.invokedByAutorun) {
      const allow =
        config.pipeline && config.pipeline.autorun && config.pipeline.autorun.allow_destructive_deploy === true;
      if (!allow) {
        console.error('failed_step=deploy');
        console.error(
          'autorun 路径禁止 deploy：需要 docs/config.dev.json.pipeline.autorun.allow_destructive_deploy === true（publish3.md §5.1.1）'
        );
        process.exit(1);
      }
    }

    const d = runDeploy(root, {
      dryRun: args.dryRun,
      sessionId: args.sessionId,
      forceRerun: args.forceRerun,
    });
    if (d.message) console.error(d.message);
    if (d.code !== 0) {
      if (d.failed_step) console.error(`failed_step=${d.failed_step}`);
      process.exit(d.code);
    }
  }

  const deploySubstepSkipped = !(config.deploy && config.deploy.enabled);
  const s = await runSmoke(root, {
    dryRun: args.dryRun,
    requireSmoke: args.requireSmoke,
    deploySubstepSkipped,
    forceRerun: args.forceRerun,
  });
  if (s.message) console.error(s.message);
  if (s.code !== 0) {
    if (s.failed_step) console.error(`failed_step=${s.failed_step}`);
    process.exit(s.code);
  }

  console.error('ai-publish-dev3: run 完成。');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

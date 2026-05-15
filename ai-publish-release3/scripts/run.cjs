'use strict';

const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
const { runPreflight } = require('./preflight.cjs');
const { runRelease } = require('./release.cjs');
const { runDeploy } = require('./deploy.cjs');
const { runSmoke } = require('./smoke.cjs');

function main() {
  const args = parseRunArgs(process.argv, { environment: 'release' });
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
    console.error('显式 --require-deploy 但 deploy.enabled=false → 退出 1');
    process.exit(1);
  }

  const startFromSmoke = args.fromStage === 'smoke';

  if (!startFromSmoke) {
    const rel = runRelease(root, { dryRun: args.dryRun });
    if (rel.message) console.error(rel.message);
    if (rel.code !== 0) {
      if (rel.failed_step) console.error(`failed_step=${rel.failed_step}`);
      process.exit(rel.code);
    }

    const d = runDeploy(root, {
      dryRun: args.dryRun,
      sessionId: args.sessionId,
      confirmDeploy: args.confirmDeploy,
    });
    if (d.message) console.error(d.message);
    if (d.code !== 0) {
      if (d.failed_step) console.error(`failed_step=${d.failed_step}`);
      process.exit(d.code);
    }
  }

  const deploySubstepSkipped = !(config.deploy && config.deploy.enabled);
  const s = runSmoke(root, {
    dryRun: args.dryRun,
    requireSmoke: args.requireSmoke,
    deploySubstepSkipped,
  });
  if (s.message) console.error(s.message);
  if (s.code !== 0) {
    if (s.failed_step) console.error(`failed_step=${s.failed_step}`);
    process.exit(s.code);
  }

  console.error('ai-publish-release3: 本骨架 run 完成（release/deploy/smoke 完整实现待补）。');
  process.exit(0);
}

main();

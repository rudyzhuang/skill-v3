'use strict';

const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
const { runPreflight } = require('./preflight.cjs');
const { runUiE2e } = require('./ui-e2e.cjs');

async function main() {
  const args = parseRunArgs(process.argv);
  const root = requireProject(args.project);
  const sessionId = args.sessionId || `sess-${Date.now()}`;

  const pf = runPreflight(root, { requireUiE2e: args.requireUiE2e });
  if (!pf.ok) {
    console.error('failed_step=ui_e2e');
    console.error(pf.message);
    process.exit(1);
  }

  if (pf.skip) {
    if (args.requireUiE2e) {
      console.error('failed_step=ui_e2e');
      console.error(pf.skipReason || 'ui_e2e disabled');
      process.exit(1);
    }
    console.error(`ai-e2e3: skip (${pf.skipReason})`);
    process.exit(0);
  }

  const r = await runUiE2e(root, {
    config: pf.config,
    dryRun: args.dryRun,
    forceRerun: args.forceRerun,
    sessionId,
    requireUiE2e: args.requireUiE2e,
  });
  if (r.message) console.error(r.message);
  if (r.code !== 0) {
    if (r.failed_step) console.error(`failed_step=${r.failed_step}`);
    process.exit(r.code);
  }
  console.error('ai-e2e3: run 完成。');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * 删除 **`.pipeline/worktrees/v3-fc-*`** 注册的 git worktree（destructive）。
 * 须 **`AI_CODE3_CLEAN_CONFIRM=yes`**。
 */
async function run(ctx) {
  const { projectRoot } = ctx;
  if (process.env.AI_CODE3_CLEAN_CONFIRM !== 'yes') {
    console.error('clean blocked: set AI_CODE3_CLEAN_CONFIRM=yes (destructive)');
    return 1;
  }
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    console.error('--project must be an absolute path');
    return 1;
  }
  const base = path.join(projectRoot, '.pipeline', 'worktrees');
  if (!fs.existsSync(base)) return 0;
  const entries = fs.readdirSync(base, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!ent.name.startsWith('v3-fc-')) continue;
    const wt = path.join(base, ent.name);
    const r = spawnSync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', wt], {
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      console.error(`worktree remove failed for ${wt}: ${r.stderr || r.status}`);
      return 1;
    }
  }
  return 0;
}

module.exports = { run };

if (require.main === module) {
  const { parseCommonArgs } = require('./lib/cli-args.cjs');
  const o = parseCommonArgs(process.argv);
  if (!o.project) {
    console.error('missing --project=<absolute>');
    process.exit(1);
  }
  run({ projectRoot: o.project, options: o }).then((c) => process.exit(c));
}

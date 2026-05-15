'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {string} projectRoot
 * @param {{ dryRun?: boolean }} opts
 * @returns {{ code: number, failed_step?: string, message?: string }}
 */
function runRelease(projectRoot, opts = {}) {
  const cfgPath = path.join(projectRoot, 'docs', 'config.release.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const rel = config.release || {};
  if (!rel.enabled) {
    return { code: 0, message: 'release 子步骤 skipped (release.enabled=false)' };
  }
  if (opts.dryRun) {
    return { code: 0, message: 'dry-run: 跳过 release 子步骤（version/tag/gh release 等）' };
  }
  return {
    code: 1,
    failed_step: 'release',
    message:
      '本仓库骨架未实现 release.cjs（version、changelog、git tag、gh release、publish_assets）；见 docs/spec/publish3.md §5.3.1。',
  };
}

if (require.main === module) {
  const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
  const args = parseRunArgs(process.argv, { environment: 'release' });
  const root = requireProject(args.project);
  const out = runRelease(root, { dryRun: args.dryRun });
  if (out.message) console.error(out.message);
  process.exit(out.code);
}

module.exports = { runRelease };

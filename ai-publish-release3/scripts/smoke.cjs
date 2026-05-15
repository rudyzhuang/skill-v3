'use strict';

const fs = require('fs');
const path = require('path');
const { stagesPath } = require('./lib/paths.cjs');

/**
 * @param {string} projectRoot
 * @param {{ dryRun?: boolean, requireSmoke?: boolean, deploySubstepSkipped?: boolean }} opts
 * @returns {{ code: number, failed_step?: string, message?: string }}
 */
function runSmoke(projectRoot, opts = {}) {
  const cfgPath = path.join(projectRoot, 'docs', 'config.release.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const smoke = config.smoke || {};
  const deployEnabled = !!(config.deploy && config.deploy.enabled);

  if (!smoke.enabled) {
    if (opts.requireSmoke) {
      return { code: 1, failed_step: 'smoke', message: 'smoke.enabled=false 但指定了 --require-smoke' };
    }
    return { code: 0, message: 'smoke skipped (smoke.enabled=false)' };
  }

  const checks = smoke.checks || [];
  if (checks.length === 0) {
    if (opts.requireSmoke) {
      return { code: 1, failed_step: 'smoke', message: '无 smoke.checks / x-smoke 合并结果，但指定了 --require-smoke' };
    }
    return { code: 0, message: 'smoke skipped (无配置检查项；契约 x-smoke 合并待实现)' };
  }

  const stages = JSON.parse(fs.readFileSync(stagesPath(projectRoot), 'utf8'));
  const dep = stages.stages && stages.stages.deploy;
  const deployGateOk = dep && dep.status === 'completed' && dep.validation && dep.validation.passed === true;
  if (!deployGateOk) {
    if (opts.deploySubstepSkipped || !deployEnabled) {
      if (opts.requireSmoke) {
        return {
          code: 1,
          failed_step: 'smoke',
          message: '--require-smoke 但 stages.deploy 未就绪',
        };
      }
      return {
        code: 0,
        message: 'smoke skipped: stages.deploy 未就绪（deploy.enabled=false 或上游未部署）',
      };
    }
    return { code: 1, failed_step: 'smoke', message: 'smoke 前置: stages.deploy 须已完成且 validation.passed=true' };
  }

  if (opts.dryRun) {
    return { code: 0, message: 'dry-run: 跳过真实 HTTP smoke' };
  }

  return {
    code: 1,
    failed_step: 'smoke',
    message: '本仓库骨架未实现 http-smoke / x-smoke 解析（见 docs/spec/publish3.md §8）。',
  };
}

if (require.main === module) {
  const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
  const args = parseRunArgs(process.argv, { environment: 'release' });
  const root = requireProject(args.project);
  const out = runSmoke(root, { dryRun: args.dryRun, requireSmoke: args.requireSmoke });
  if (out.message) console.error(out.message);
  process.exit(out.code);
}

module.exports = { runSmoke };

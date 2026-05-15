'use strict';

const fs = require('fs');
const path = require('path');

const LOCK_SCOPE = 'deploy-release';

function lockDir(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'locks');
}

function lockPath(projectRoot) {
  return path.join(lockDir(projectRoot), `${LOCK_SCOPE}.json`);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} projectRoot
 * @param {{ dryRun?: boolean, sessionId?: string|null, confirmDeploy?: boolean }} opts
 * @returns {{ code: number, failed_step?: string, message?: string }}
 */
function runDeploy(projectRoot, opts = {}) {
  const cfgPath = path.join(projectRoot, 'docs', 'config.release.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!config.deploy || !config.deploy.enabled) {
    return { code: 0, message: 'deploy skipped (deploy.enabled=false)' };
  }

  if (!opts.dryRun && !opts.confirmDeploy) {
    return {
      code: 1,
      failed_step: 'deploy',
      message: 'release deploy 须显式 --confirm-deploy（publish3.md §5.2，含 approval_required=false 情形）',
    };
  }

  if (opts.dryRun) {
    return { code: 0, message: 'dry-run: 跳过真实 deploy' };
  }

  const ld = lockDir(projectRoot);
  if (!fs.existsSync(ld)) fs.mkdirSync(ld, { recursive: true });
  const lp = lockPath(projectRoot);
  if (fs.existsSync(lp)) {
    try {
      const body = JSON.parse(fs.readFileSync(lp, 'utf8'));
      if (body.pid && isPidAlive(body.pid)) {
        return { code: 1, failed_step: 'deploy', message: `PID 锁冲突: ${LOCK_SCOPE} (pid=${body.pid})` };
      }
    } catch {
      /* stale */
    }
  }
  fs.writeFileSync(
    lp,
    JSON.stringify(
      {
        pid: process.pid,
        session_id: opts.sessionId || null,
        started_at: new Date().toISOString(),
        skill: 'ai-publish-release3',
      },
      null,
      2
    ),
    'utf8'
  );

  return {
    code: 1,
    failed_step: 'deploy',
    message:
      '本仓库骨架未实现 release provider 与 stages.deploy 写回；请补全 providers 与 stages-io（见 docs/spec/publish3.md）。',
  };
}

if (require.main === module) {
  const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
  const args = parseRunArgs(process.argv, { environment: 'release' });
  const root = requireProject(args.project);
  const out = runDeploy(root, { dryRun: args.dryRun, sessionId: args.sessionId, confirmDeploy: args.confirmDeploy });
  if (out.message) console.error(out.message);
  process.exit(out.code);
}

module.exports = { runDeploy, LOCK_SCOPE };

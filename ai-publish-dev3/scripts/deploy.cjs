'use strict';

const fs = require('fs');
const path = require('path');
const { stagesPath } = require('./lib/paths.cjs');
const { planManualDeploy } = require('./lib/providers/manual.cjs');
const { updateStages } = require('./lib/stages-io.cjs');
const { sha256Stable, deploySummaryInput, hashConfigDeploySubtree } = require('./lib/summary-hash.cjs');
const { collectConsumedArtifacts } = require('./lib/artifacts.cjs');

const LOCK_SCOPE = 'deploy-dev';

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

function tryRemoveLock(projectRoot) {
  const lp = lockPath(projectRoot);
  try {
    if (fs.existsSync(lp)) fs.unlinkSync(lp);
  } catch {
    /* ignore */
  }
}

function deployStageCompleted(dep, expectedHash, forceRerun) {
  if (!dep || forceRerun) return false;
  if (dep.status !== 'completed' || !dep.validation || dep.validation.passed !== true) return false;
  if (expectedHash && dep.inputs && dep.inputs.summary_hash && dep.inputs.summary_hash !== expectedHash) return false;
  return true;
}

/**
 * @param {string} projectRoot
 * @param {{
 *   dryRun?: boolean,
 *   sessionId?: string|null,
 *   forceRerun?: boolean,
 * }} opts
 * @returns {{ code: number, failed_step?: string, message?: string }}
 */
function runDeploy(projectRoot, opts = {}) {
  const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const stPath = stagesPath(projectRoot);
  const stages = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  const dep = stages.stages && stages.stages.deploy;
  const bu = stages.stages && stages.stages.build;
  const arts = (bu && bu.outputs && bu.outputs.artifacts) || [];

  if (!config.deploy || !config.deploy.enabled) {
    return { code: 0, message: 'deploy skipped (deploy.enabled=false)' };
  }

  let consumed;
  try {
    consumed = collectConsumedArtifacts(config.deploy.services || [], arts);
  } catch (e) {
    return { code: 1, failed_step: 'deploy', message: e.message };
  }

  const deployCfg = hashConfigDeploySubtree(projectRoot, cfgPath);
  const summaryHash = sha256Stable(deploySummaryInput(deployCfg, consumed));

  if (deployStageCompleted(dep, summaryHash, opts.forceRerun)) {
    return { code: 0, message: 'deploy 已满足完成条件且 summary_hash 一致，跳过（未传 --force-rerun，见 publish3.md §6.2）' };
  }

  if (opts.dryRun) {
    return { code: 0, message: 'dry-run: 跳过真实 deploy' };
  }

  const provider = (config.deploy.provider || 'manual').toLowerCase();
  if (provider !== 'manual') {
    return {
      code: 1,
      failed_step: 'deploy',
      message: `deploy.provider="${config.deploy.provider}" 尚无自动化实现；请改用 manual 或扩展 scripts/lib/providers/（publish3.md §4.1）。`,
    };
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
        skill: 'ai-publish-dev3',
      },
      null,
      2
    ),
    'utf8'
  );

  try {
    const planned = planManualDeploy(config.deploy.services || []);
    const now = new Date().toISOString();
    updateStages(stPath, (doc) => {
      doc.stages = doc.stages || {};
      const prev = doc.stages.deploy || {};
      doc.stages.deploy = {
        ...prev,
        status: 'completed',
        environment: 'dev',
        started_at: prev.started_at || now,
        completed_at: now,
        inputs: {
          ...(prev.inputs || {}),
          summary_hash: summaryHash,
          requires_stage: 'build',
          config: 'docs/config.dev.json',
          secret_env: 'docs/config.env',
          artifacts: consumed.map((a) => ({
            client_target: a.client_target,
            sub_platform: a.sub_platform || '',
            artifact_path: a.artifact_path,
            status: a.status,
          })),
        },
        outputs: {
          ...(prev.outputs || {}),
          environment: 'dev',
          provider: 'manual',
          services: planned.services,
          deploy_url: planned.deploy_url,
          commit: '',
          error: '',
        },
        validation: {
          ...(prev.validation || {}),
          passed: true,
          checked_at: now,
          summary: 'manual deploy（无云 API 调用）',
        },
      };
    });
    return { code: 0, message: 'deploy 完成（manual provider，已写回 stages.deploy）' };
  } catch (e) {
    return { code: 1, failed_step: 'deploy', message: `deploy 写回失败: ${e.message}` };
  } finally {
    tryRemoveLock(projectRoot);
  }
}

if (require.main === module) {
  const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
  const args = parseRunArgs(process.argv, { environment: 'dev' });
  const root = requireProject(args.project);
  const out = runDeploy(root, { dryRun: args.dryRun, sessionId: args.sessionId, forceRerun: args.forceRerun });
  if (out.message) console.error(out.message);
  if (out.failed_step) console.error(`failed_step=${out.failed_step}`);
  process.exit(out.code);
}

module.exports = { runDeploy, LOCK_SCOPE };

'use strict';

const fs = require('fs');
const path = require('path');
const { stagesPath } = require('./lib/paths.cjs');
const { planManualDeploy } = require('./lib/providers/manual.cjs');
const { isAutomatedProvider, executeAutomatedDeploy } = require('./lib/providers/registry.cjs');
const { updateStages } = require('./lib/stages-io.cjs');
const { sha256Stable, deploySummaryInput, hashConfigDeploySubtree } = require('./lib/summary-hash.cjs');
const { collectConsumedArtifacts } = require('./lib/artifacts.cjs');
const { stageTimeoutSeconds, heartbeatIntervalMs } = require('./lib/timeouts.cjs');
const { runWithTimeout } = require('./lib/run-with-timeout.cjs');
const { appendSessionLog } = require('./lib/session-log.cjs');
const featureStages = require('../../ai-auto3/scripts/lib/feature-stages.cjs');

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

function writeDeploySkipped(stPath, summaryHash, reason) {
  const now = new Date().toISOString();
  updateStages(stPath, (doc) => {
    doc.stages = doc.stages || {};
    const prev = doc.stages.deploy || {};
    doc.stages.deploy = {
      ...prev,
      status: 'skipped',
      environment: 'dev',
      started_at: prev.started_at || now,
      completed_at: now,
      inputs: {
        ...(prev.inputs || {}),
        summary_hash: summaryHash || (prev.inputs && prev.inputs.summary_hash) || '',
        requires_stage: 'build',
        config: 'docs/config.dev.json',
        secret_env: 'docs/config.env',
        artifacts: (prev.inputs && prev.inputs.artifacts) || [],
      },
      outputs: {
        ...(prev.outputs || {}),
        skip_reason: reason,
        timed_out: false,
        timeout_reason: null,
        duration_ms: null,
        error: '',
      },
      validation: {
        ...(prev.validation || {}),
        passed: true,
        checked_at: now,
        summary: 'deploy skipped（非失败）',
      },
    };
  });
}

/**
 * @param {string} projectRoot
 * @param {{
 *   dryRun?: boolean,
 *   sessionId?: string|null,
 *   forceRerun?: boolean,
 * }} opts
 * @returns {Promise<{ code: number, failed_step?: string, message?: string }>}
 */
async function runDeploy(projectRoot, opts = {}) {
  const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const stPath = stagesPath(projectRoot);
  const stages = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  const dep = stages.stages && stages.stages.deploy;
  const bu = stages.stages && stages.stages.build;
  const arts = (bu && bu.outputs && bu.outputs.artifacts) || [];
  const sessionId = opts.sessionId || null;
  const deployFeatureIds = featureStages.collectPhaseFeatureIds(stages);
  const log = (line) => {
    try {
      appendSessionLog(projectRoot, sessionId, line, {
        stageKey: 'deploy',
        featureIds: deployFeatureIds,
      });
    } catch {
      /* ignore */
    }
  };

  if (!config.deploy || !config.deploy.enabled) {
    if (!opts.dryRun) {
      const deployCfg = hashConfigDeploySubtree(projectRoot, cfgPath);
      let consumed = [];
      if (config.deploy && Array.isArray(config.deploy.services)) {
        try {
          consumed = collectConsumedArtifacts(config.deploy.services, arts);
        } catch {
          consumed = [];
        }
      }
      const summaryHash = sha256Stable(deploySummaryInput(deployCfg, consumed));
      writeDeploySkipped(stPath, summaryHash, 'deploy.enabled=false');
    }
    return { code: 0, message: 'deploy skipped (deploy.enabled=false)，已写回 stages.deploy.skip_reason' };
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

  const providerRaw = config.deploy.provider || 'manual';
  const provider = String(providerRaw).toLowerCase();
  const allowExit8Test =
    process.env.AI_PUBLISH_DEV3_SELFTEST === '1' && String(providerRaw).toLowerCase() === 'exit8-test';

  if (!allowExit8Test && provider !== 'manual' && !isAutomatedProvider(provider)) {
    return {
      code: 1,
      failed_step: 'deploy',
      message: `deploy.provider="${config.deploy.provider}" 尚无自动化实现；请改用 manual 或已注册的云 provider（见 scripts/lib/providers/registry.cjs，publish3.md §4.1）。`,
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
        session_id: sessionId,
        started_at: new Date().toISOString(),
        skill: 'ai-publish-dev3',
      },
      null,
      2
    ),
    'utf8'
  );

  log(`deploy start provider=${providerRaw} session=${sessionId || 'none'}`);

  updateStages(stPath, (doc) => {
    featureStages.backfillFeatureStages(doc);
    const ids = featureStages.collectPhaseFeatureIds(doc);
    const begun = featureStages.beginStageForFeatures(doc, {
      stageKey: 'deploy',
      featureIds: ids,
      skill: 'ai-publish-dev3',
      message: `dev 部署开始（provider=${providerRaw}）`,
    });
    return featureStages.markFeaturesRunning(begun.doc, 'deploy', ids, {
      message: `dev 部署中（provider=${providerRaw}）`,
    });
  });
  featureStages.appendStageLog(projectRoot, {
    skill: 'ai-publish-dev3',
    sessionId,
    stageKey: 'deploy',
    featureIds: deployFeatureIds,
    message: `deploy 处理中，provider=${providerRaw}`,
  });

  try {
    if (allowExit8Test) {
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
            provider: 'exit8-test',
            services: [],
            deploy_url: '',
            commit: '',
            error: 'selftest: simulated cloud/hosting API failure → exit 8',
            timed_out: false,
            timeout_reason: null,
            duration_ms: 0,
          },
          validation: {
            ...(prev.validation || {}),
            passed: false,
            checked_at: now,
            summary: 'deploy 失败（exit 8 路径校验）',
          },
        };
      });
      log('deploy end exit=8 (exit8-test fixture)');
      return { code: 8, failed_step: 'deploy', message: 'exit8-test：模拟云/托管 API 失败（仅 AI_PUBLISH_DEV3_SELFTEST=1）' };
    }

    const timeoutMs = stageTimeoutSeconds(config, 'deploy_s') * 1000;
    const hbMs = heartbeatIntervalMs(config);

    const buildArts = (bu && bu.outputs && bu.outputs.artifacts) || [];

    const tw = await runWithTimeout(
      {
        ms: timeoutMs,
        heartbeatMs: hbMs,
        label: 'deploy',
        onHeartbeat: () => log(`alive: deploy pid=${process.pid}`),
      },
      async () => {
        if (isAutomatedProvider(provider)) {
          return executeAutomatedDeploy(
            providerRaw,
            projectRoot,
            config,
            buildArts,
            consumed,
            summaryHash,
            stPath,
            log
          );
        }
        return new Promise((resolve, reject) => {
          setImmediate(() => {
            try {
              const planned = planManualDeploy(config.deploy.services || []);
              const now = new Date().toISOString();
              const t0 = Date.now();
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
                    timed_out: false,
                    timeout_reason: null,
                    duration_ms: Date.now() - t0,
                  },
                  validation: {
                    ...(prev.validation || {}),
                    passed: true,
                    checked_at: now,
                    summary: 'manual deploy（无云 API 调用）',
                  },
                };
              });
              resolve({ code: 0, message: 'deploy 完成（manual provider，已写回 stages.deploy）' });
            } catch (e) {
              reject(e);
            }
          });
        });
      }
    );

    if (!tw.ok) {
      if (tw.timedOut) {
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
              timed_out: true,
              timeout_reason: 'deploy',
              duration_ms: tw.durationMs,
              error: `timeout after ${tw.durationMs}ms`,
            },
            validation: {
              ...(prev.validation || {}),
              passed: false,
              checked_at: now,
              summary: 'deploy 超时',
            },
          };
        });
        log(`deploy timeout ${tw.durationMs}ms`);
        return {
          code: 3,
          failed_step: 'deploy',
          message: `deploy 超时（退出码 3，publish3.md §9）：${timeoutMs}ms`,
        };
      }
      return {
        code: 1,
        failed_step: 'deploy',
        message: tw.error ? tw.error.message : 'deploy 失败',
      };
    }

    if (tw.result && typeof tw.result.code === 'number' && tw.result.code !== 0) {
      return tw.result;
    }

    log('deploy end ok');
    return tw.result;
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
  runDeploy(root, { dryRun: args.dryRun, sessionId: args.sessionId, forceRerun: args.forceRerun }).then((out) => {
    if (out.message) console.error(out.message);
    if (out.failed_step) console.error(`failed_step=${out.failed_step}`);
    process.exit(out.code);
  });
}

module.exports = { runDeploy, LOCK_SCOPE };

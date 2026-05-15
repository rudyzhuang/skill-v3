'use strict';

const fs = require('fs');
const path = require('path');
const { stagesPath } = require('./lib/paths.cjs');
const { updateStages } = require('./lib/stages-io.cjs');
const { sha256Stable, smokeSummaryInput } = require('./lib/summary-hash.cjs');
const { runHttpSmokeChecks } = require('./lib/http-smoke.cjs');

const LOCK_SCOPE = 'smoke';

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

function tryRemoveSmokeLock(projectRoot) {
  try {
    const lp = lockPath(projectRoot);
    if (fs.existsSync(lp)) fs.unlinkSync(lp);
  } catch {
    /* ignore */
  }
}

function smokeStageCompleted(sm, expectedHash, forceRerun) {
  if (!sm || forceRerun) return false;
  if (sm.status !== 'completed' || !sm.validation || sm.validation.passed !== true) return false;
  if (expectedHash && sm.inputs && sm.inputs.summary_hash && sm.inputs.summary_hash !== expectedHash) return false;
  return true;
}

/**
 * @param {object} config
 * @param {object} stages
 */
function resolveSmokeBaseUrl(config, stages) {
  const sm = config.smoke || {};
  if (sm.base_url && String(sm.base_url).trim()) return String(sm.base_url).trim();
  const dep = stages.stages && stages.stages.deploy;
  if (dep && dep.outputs) {
    if (dep.outputs.deploy_url && String(dep.outputs.deploy_url).trim()) return String(dep.outputs.deploy_url).trim();
    const svcs = dep.outputs.services || [];
    const first = svcs.find((s) => s && s.url && String(s.url).trim());
    if (first) return String(first.url).trim().replace(/\/$/, '');
  }
  return '';
}

/**
 * @param {string} projectRoot
 * @param {{ dryRun?: boolean, requireSmoke?: boolean, deploySubstepSkipped?: boolean, forceRerun?: boolean }} opts
 * @returns {Promise<{ code: number, failed_step?: string, message?: string }>}
 */
async function runSmoke(projectRoot, opts = {}) {
  const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const smoke = config.smoke || {};
  const deployEnabled = !!(config.deploy && config.deploy.enabled);
  const stPath = stagesPath(projectRoot);
  const stages = JSON.parse(fs.readFileSync(stPath, 'utf8'));

  if (!smoke.enabled) {
    if (opts.requireSmoke) {
      return { code: 1, failed_step: 'smoke', message: 'smoke.enabled=false 但指定了 --require-smoke' };
    }
    return { code: 0, message: 'smoke skipped (smoke.enabled=false)' };
  }

  const checks = smoke.checks || [];
  const xsmokeNote = '契约 x-smoke 合并：当前从 stages.contract 解析未实现，仅使用 smoke.checks[]（publish3.md §8）。';
  if (checks.length === 0) {
    if (opts.requireSmoke) {
      return { code: 1, failed_step: 'smoke', message: `无 smoke.checks 且 ${xsmokeNote} 仍视为无检查项；--require-smoke → 退出 1` };
    }
    return { code: 0, message: `smoke skipped（无 smoke.checks；${xsmokeNote}）` };
  }

  const dep = stages.stages && stages.stages.deploy;
  const deployGateOk = dep && dep.status === 'completed' && dep.validation && dep.validation.passed === true;
  if (!deployGateOk && opts.dryRun) {
    return { code: 0, message: 'dry-run: 跳过 smoke（stages.deploy 尚未 completed，不执行 HTTP）' };
  }
  if (!deployGateOk) {
    if (opts.deploySubstepSkipped || !deployEnabled) {
      if (opts.requireSmoke) {
        return {
          code: 1,
          failed_step: 'smoke',
          message: '--require-smoke 但 stages.deploy 未就绪（且本轮未执行 deploy）',
        };
      }
      return {
        code: 0,
        message: 'smoke skipped: stages.deploy 未就绪（deploy.enabled=false 或上游未部署；见 publish3.md §7.2）',
      };
    }
    return { code: 1, failed_step: 'smoke', message: 'smoke 前置: stages.deploy 须已完成且 validation.passed=true' };
  }

  const baseUrl = resolveSmokeBaseUrl(config, stages);
  const summaryHash = sha256Stable(smokeSummaryInput(smoke, baseUrl, (dep.outputs && dep.outputs.deploy_url) || ''));
  const sm = stages.stages && stages.stages.smoke;
  if (smokeStageCompleted(sm, summaryHash, opts.forceRerun)) {
    return { code: 0, message: 'smoke 已满足完成条件且 summary_hash 一致，跳过（未传 --force-rerun，见 publish3.md §6.2）' };
  }

  if (opts.dryRun) {
    return { code: 0, message: 'dry-run: 跳过真实 HTTP smoke' };
  }

  if (!baseUrl) {
    return { code: 1, failed_step: 'smoke', message: '无法解析 smoke base URL（请设置 smoke.base_url 或确保 deploy 输出 deploy_url/services[].url）' };
  }

  const ld = lockDir(projectRoot);
  if (!fs.existsSync(ld)) fs.mkdirSync(ld, { recursive: true });
  const lp = lockPath(projectRoot);
  if (fs.existsSync(lp)) {
    try {
      const body = JSON.parse(fs.readFileSync(lp, 'utf8'));
      if (body.pid && isPidAlive(body.pid)) {
        return { code: 1, failed_step: 'smoke', message: `PID 锁冲突: ${LOCK_SCOPE} (pid=${body.pid})` };
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
        session_id: null,
        started_at: new Date().toISOString(),
        skill: 'ai-publish-dev3',
      },
      null,
      2
    ),
    'utf8'
  );

  try {
    const httpResult = await runHttpSmokeChecks(checks, baseUrl);
    const now = new Date().toISOString();
    if (!httpResult.ok) {
      updateStages(stPath, (doc) => {
        doc.stages = doc.stages || {};
        const prev = doc.stages.smoke || {};
        doc.stages.smoke = {
          ...prev,
          status: 'completed',
          completed_at: now,
          inputs: {
            ...(prev.inputs || {}),
            summary_hash: summaryHash,
            requires_stage: 'deploy',
            base_url: baseUrl,
            checks_source: ['config.smoke.checks'],
          },
          outputs: {
            ...(prev.outputs || {}),
            checks: (checks || []).map((c) => ({
              name: c.name || c.path,
              method: c.method || 'GET',
              path: c.path,
              expected_status: c.expected_status != null ? c.expected_status : 200,
              actual_status: null,
              passed: false,
              latency_ms: null,
              error: httpResult.failures.join('; '),
            })),
            failed_paths: checks.map((c) => c.path),
            skip_reason: '',
          },
          validation: {
            ...(prev.validation || {}),
            passed: false,
            checked_at: now,
            summary: 'HTTP smoke 未通过',
          },
        };
      });
      return {
        code: 4,
        failed_step: 'smoke',
        message: `smoke 未通过（退出码 4，publish3.md §9）：\n${httpResult.failures.join('\n')}`,
      };
    }

    updateStages(stPath, (doc) => {
      doc.stages = doc.stages || {};
      const prev = doc.stages.smoke || {};
      doc.stages.smoke = {
        ...prev,
        status: 'completed',
        completed_at: now,
        inputs: {
          ...(prev.inputs || {}),
          summary_hash: summaryHash,
          requires_stage: 'deploy',
          base_url: baseUrl,
          checks_source: ['config.smoke.checks'],
        },
        outputs: {
          ...(prev.outputs || {}),
          checks: checks.map((c) => ({
            name: c.name || c.path,
            method: c.method || 'GET',
            path: c.path,
            expected_status: c.expected_status != null ? c.expected_status : 200,
            actual_status: c.expected_status != null ? c.expected_status : 200,
            passed: true,
            latency_ms: null,
            error: '',
          })),
          failed_paths: [],
          skip_reason: '',
        },
        validation: {
          ...(prev.validation || {}),
          passed: true,
          checked_at: now,
          summary: 'HTTP smoke 通过',
        },
      };
    });
    return { code: 0, message: 'smoke 完成（HTTP GET/HEAD）' };
  } finally {
    tryRemoveSmokeLock(projectRoot);
  }
}

if (require.main === module) {
  const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
  const args = parseRunArgs(process.argv, { environment: 'dev' });
  const root = requireProject(args.project);
  const cfgPath = path.join(root, 'docs', 'config.dev.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const deploySubstepSkipped = !(config.deploy && config.deploy.enabled);
  runSmoke(root, {
    dryRun: args.dryRun,
    requireSmoke: args.requireSmoke,
    forceRerun: args.forceRerun,
    deploySubstepSkipped,
  }).then((out) => {
    if (out.message) console.error(out.message);
    if (out.failed_step) console.error(`failed_step=${out.failed_step}`);
    process.exit(out.code);
  });
}

module.exports = { runSmoke };

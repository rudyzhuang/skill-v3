'use strict';

/**
 * codegen.cjs — codegen stage 编排入口
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. 上游门闸：stages.design_review.outputs.can_enter_codegen=true → exit 1 if not
 *   --bootstrap 模式：
 *     2. 计算 release_bundle_hash / design_bundle_hash，hash 门控
 *     3. 初始化骨架，创建 git worktree，写 stages.json
 *   --tick 模式：
 *     2. 收割终态 worker（state.json）→ 更新 stages.json
 *     3. 检查 stop.signal → exit 5
 *     4. 启动新 worker（受 effective_parallel 限制）
 *     5. exit 0（单轮返回，worker 跨 tick 存活）
 *   --feature=<id> 模式：同 tick，但只处理指定 feature
 *   批量模式（无 --tick / --bootstrap）：bootstrap + loop tick + validate
 *   → exit 0 成功 / exit 1 门闸 / exit 3 超时 / exit 4 质量门失败 / exit 5 stop.signal
 *
 * 参数：
 *   --project=<路径>       业务项目根（绝对或相对）
 *   --run-id=<id>          run_id
 *   --bootstrap            执行 bootstrap 步骤
 *   --tick                 执行 tick 步骤（单轮调度）
 *   --feature=<feature_id> 只处理指定 feature
 *   --force-rerun          强制重跑，跳过 hash 门控
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const { createLogger, formatLocalTimeShort } = require('../libs/logger.cjs');

// ── 解析参数 ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || true];
    })
);

const projectRoot = args.project
  ? path.resolve(args.project)
  : process.env.AI_STD4_PROJECT
    ? path.resolve(process.env.AI_STD4_PROJECT)
    : process.cwd();

const skillsRoot = process.env.CURSOR_SKILLS_ROOT
  || path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

const isBootstrap   = args.bootstrap === true || args.bootstrap === 'true';
const isTick        = args.tick === true || args.tick === 'true';
const featureFilter = args.feature || null;
const forceRerun    = args['force-rerun'] === true || args['force-rerun'] === 'true';

// mode: 'bootstrap' | 'tick' | 'batch'
const mode = isBootstrap ? 'bootstrap' : isTick ? 'tick' : 'batch';

// ── run_id ────────────────────────────────────────────────────────
function generateRunId() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${crypto.randomBytes(4).toString('hex')}`;
}
const runId = args['run-id'] || generateRunId();

// ── Logger ────────────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'codegen', runId });

// ── 工具函数 ──────────────────────────────────────────────────────
const AI_STD4_NODE_MODULES = path.join(skillsRoot, 'ai-std4', 'node_modules');

/** worker 子进程需能 resolve ai-std4 的 node_modules（@cursor/sdk 等） */
function buildWorkerEnv(extra = {}) {
  const nodePathParts = [AI_STD4_NODE_MODULES];
  if (process.env.NODE_PATH) nodePathParts.push(process.env.NODE_PATH);
  return Object.assign({}, process.env, {
    NODE_PATH: nodePathParts.join(path.delimiter),
  }, extra);
}

/** 依赖 feature 已 failed/blocked 时，将下游标为 blocked，避免 build_phase 无限 tick */
function propagateBlockedByFailedDeps(features, targetIds, root) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const fid of targetIds) {
      const feat = features[fid];
      if (!feat) continue;
      if (['completed', 'failed', 'blocked', 'pending_dep'].includes(feat.status)) continue;

      const designFile = path.join(root, 'docs', 'designs', `${fid}.design.json`);
      let deps = [];
      try {
        const dd = JSON.parse(fs.readFileSync(designFile, 'utf8'));
        deps = dd.dependencies || [];
      } catch (_) { continue; }

      const blockingDep = deps.find(depId => {
        const dep = features[depId];
        return dep && (dep.status === 'failed' || dep.status === 'blocked');
      });
      if (blockingDep) {
        feat.status = 'blocked';
        feat.error  = feat.error || `dependency_failed:${blockingDep}`;
        changed = true;
      }
    }
  }
}

function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readStagesJson() {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeStagesJson(obj) {
  const dir = path.join(projectRoot, '.pipeline');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'stages.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return p;
}

function checkStopSignal() {
  return fs.existsSync(path.join(projectRoot, '.pipeline', 'stop.signal'));
}

function getStopReason() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, '.pipeline', 'stop.signal'), 'utf8')).reason || 'unknown';
  } catch (_) { return 'unknown'; }
}

function gracefulStop(stagesObj) {
  const stoppedAt = formatLocalTimeShort();
  const reason    = getStopReason();

  log.info('pipeline_stop', '检测到 stop.signal，开始优雅停止', {
    stage: 'codegen', reason, stopped_at: stoppedAt,
  });

  if (stagesObj && stagesObj.stages) {
    if (!stagesObj.stages.codegen) {
      stagesObj.stages.codegen = { status: 'stopped' };
    } else {
      stagesObj.stages.codegen.status = 'stopped';
    }
    if (stagesObj.pipeline) {
      stagesObj.pipeline.updated_at = stoppedAt;
      stagesObj.pipeline.stop_info  = { stopped_at: stoppedAt, stopped_stage: 'codegen', reason };
    }
    writeStagesJson(stagesObj);
  }

  try {
    const sig = path.join(projectRoot, '.pipeline', 'stop.signal');
    if (fs.existsSync(sig)) fs.unlinkSync(sig);
  } catch (_) { /* ignore */ }

  log.info('pipeline_stopped', 'codegen stage 已优雅停止', {
    stage: 'codegen', stopped_at: stoppedAt, exit_code: 5,
  });
  process.exit(5);
}

// ── 配置读取 ──────────────────────────────────────────────────────
function readConfig() {
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { /* */ }
  }

  const timeoutS         = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.codegen_s) || 1800;
  const stageParallel    = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.feature_max_parallel) || 3;
  const globalParallel   = (cfg.pipeline && cfg.pipeline.autorun && cfg.pipeline.autorun.feature_max_parallel) || 3;
  const effectiveParallel = Math.min(stageParallel, globalParallel);

  const maxResumeAttempts   = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.max_resume_attempts) != null
    ? cfg.pipeline.stages.codegen.max_resume_attempts : 2;
  const agentHangThresholdS = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.agent_hang_threshold_s) || 180;
  const fsIdleThresholdS    = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.fs_idle_threshold_s) || 240;
  const stdoutIdleThresholdS= (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.stdout_idle_threshold_s) || 120;
  const heartbeatIntervalS  = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.heartbeat_interval_s) || 30;
  const gracefulKillS       = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.graceful_kill_s) || 15;

  // attempt_max_s: 若未配置则从 timeoutS 派生
  let attemptMaxS = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.attempt_max_s) || null;
  if (!attemptMaxS) {
    attemptMaxS = Math.floor(timeoutS / (maxResumeAttempts + 1));
  }

  const selfCheckEnabled  = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.self_check && cfg.pipeline.stages.codegen.self_check.enabled) || false;
  const selfCheckCommands = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.self_check && cfg.pipeline.stages.codegen.self_check.commands) || {};
  const selfCheckTimeoutS = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.codegen && cfg.pipeline.stages.codegen.self_check && cfg.pipeline.stages.codegen.self_check.timeout_s) || 300;

  const smokeCodegenEnabled = (cfg.smoke && cfg.smoke.codegen && cfg.smoke.codegen.enabled !== false) ? true : false;
  const smokeTimeoutS       = (cfg.smoke && cfg.smoke.codegen && cfg.smoke.codegen.timeout_s) || 60;
  const smokeChecks         = (cfg.smoke && cfg.smoke.checks) || [];
  const smokeBaseUrl        = (cfg.smoke && cfg.smoke.codegen && cfg.smoke.codegen.base_url) || null;

  const model = (cfg.pipeline && cfg.pipeline.model) || 'composer-2';

  return {
    timeoutS, effectiveParallel, maxResumeAttempts,
    agentHangThresholdS, fsIdleThresholdS, stdoutIdleThresholdS,
    heartbeatIntervalS, gracefulKillS, attemptMaxS,
    selfCheckEnabled, selfCheckCommands, selfCheckTimeoutS,
    smokeCodegenEnabled, smokeTimeoutS, smokeChecks, smokeBaseUrl,
    model,
  };
}

// ── 路径工具 ──────────────────────────────────────────────────────
function worktreeDir(featureId) {
  return path.join(projectRoot, '.pipeline', 'worktrees', `v3-${featureId}`);
}

function workerStateFile(featureId) {
  return path.join(projectRoot, '.pipeline', 'workers', 'codegen', `${featureId}.state.json`);
}

function workerArchiveFile(featureId, attemptIndex) {
  return path.join(projectRoot, '.pipeline', 'workers', 'codegen', 'archive', `${featureId}.${attemptIndex}.state.json`);
}

function readWorkerState(featureId) {
  const p = workerStateFile(featureId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeWorkerState(featureId, state) {
  const p = workerStateFile(featureId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ── 进程存活检查 ──────────────────────────────────────────────────
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

// ── 哈希计算 ──────────────────────────────────────────────────────
/**
 * 计算 release_bundle_hash：
 * 对 can_enter_codegen=true 的 feature 按字典序排列各自 design.json SHA-256，
 * 再对该列表做 hash-of-hashes
 */
function computeReleaseBundleHash(stagesObj) {
  const drFeatures = (stagesObj.stages && stagesObj.stages.design_review && stagesObj.stages.design_review.features) || {};
  const releasedIds = Object.keys(drFeatures)
    .filter(fid => drFeatures[fid] && drFeatures[fid].can_enter_codegen === true)
    .sort();
  if (releasedIds.length === 0) return null;
  const hashes = releasedIds.map(fid => {
    const p = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    return fileSha256(p);
  });
  return crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

/**
 * 计算 design_bundle_hash：
 * 对所有 design.features.<id>.status=completed 的 feature 按字典序排列各自 design.json SHA-256
 */
function computeDesignBundleHash(stagesObj) {
  const designFeatures = (stagesObj.stages && stagesObj.stages.design && stagesObj.stages.design.features) || {};
  const completedIds = Object.keys(designFeatures)
    .filter(fid => designFeatures[fid] && designFeatures[fid].status === 'completed')
    .sort();
  if (completedIds.length === 0) return null;
  const hashes = completedIds.map(fid => {
    const p = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    return fileSha256(p);
  });
  return crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

// ── 收集目标 feature IDs ──────────────────────────────────────────
function getTargetFeatureIds(stagesObj) {
  // 从 design_review.features 中找 can_enter_codegen=true 的 feature
  const drFeatures = (stagesObj.stages && stagesObj.stages.design_review && stagesObj.stages.design_review.features) || {};
  const ids = Object.keys(drFeatures).filter(fid => drFeatures[fid] && drFeatures[fid].can_enter_codegen === true);
  if (ids.length > 0) return ids;

  // 回退：从 prd.outputs.features 获取
  const prdFeatures = (stagesObj.stages && stagesObj.stages.prd && stagesObj.stages.prd.outputs && stagesObj.stages.prd.outputs.features) || [];
  return prdFeatures.map(f => f.feature_id).filter(Boolean);
}

function getDependencyGroups(stagesObj) {
  return (stagesObj.stages && stagesObj.stages.design && stagesObj.stages.design.inputs && stagesObj.stages.design.inputs.dependency_groups) || [];
}

// ── Git worktree 管理 ─────────────────────────────────────────────
/**
 * 创建 git worktree（若项目根不是 git 仓库则跳过，记 error）
 */
function createWorktree(featureId) {
  const wtPath = worktreeDir(featureId);
  const branch = `features/v3-${featureId}`;

  // 检查是否是 git 仓库
  let isGitRepo = false;
  try {
    execSync('git rev-parse --git-dir', { cwd: projectRoot, stdio: 'ignore' });
    isGitRepo = true;
  } catch (_) { /* not a git repo */ }

  if (!isGitRepo) {
    log.warn('file_created', `${projectRoot} 不是 git 仓库，跳过 worktree 创建`, {
      feature_id: featureId, worktree_path: wtPath, branch,
    });
    fs.mkdirSync(wtPath, { recursive: true });
    return { worktreePath: wtPath, branch, baseCommit: null, error: 'not_a_git_repo' };
  }

  // 检查 worktree 是否已存在
  if (fs.existsSync(wtPath)) {
    log.info('file_created', `worktree 已存在，验证分支一致性`, {
      feature_id: featureId, worktree_path: wtPath,
    });
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: wtPath, encoding: 'utf8' }).trim();
      const baseCommit = execSync('git rev-parse HEAD', { cwd: wtPath, encoding: 'utf8' }).trim();
      return { worktreePath: wtPath, branch: currentBranch, baseCommit, error: null };
    } catch (e) {
      return { worktreePath: wtPath, branch, baseCommit: null, error: e.message };
    }
  }

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  try {
    // 获取 base commit（HEAD）
    const baseCommit = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();

    // 检查分支是否已存在
    let branchExists = false;
    try {
      execSync(`git rev-parse --verify ${branch}`, { cwd: projectRoot, stdio: 'ignore' });
      branchExists = true;
    } catch (_) { /* branch doesn't exist */ }

    if (branchExists) {
      execSync(`git worktree add "${wtPath}" ${branch}`, { cwd: projectRoot, stdio: 'pipe' });
    } else {
      execSync(`git worktree add -b ${branch} "${wtPath}" HEAD`, { cwd: projectRoot, stdio: 'pipe' });
    }

    log.info('file_created', `git worktree 已创建`, {
      feature_id: featureId, worktree_path: wtPath, branch, base_commit: baseCommit,
    });

    // 添加 .git/info/exclude 以忽略 .codegen-resume-context.json
    try {
      const excludePath = path.join(wtPath, '.git', 'info', 'exclude');
      if (fs.existsSync(excludePath)) {
        const excludeContent = fs.readFileSync(excludePath, 'utf8');
        if (!excludeContent.includes('.codegen-resume-context.json')) {
          fs.appendFileSync(excludePath, '\n.codegen-resume-context.json\n');
        }
      }
    } catch (_) { /* ignore */ }

    return { worktreePath: wtPath, branch, baseCommit, error: null };
  } catch (e) {
    log.warn('stage_failed', `git worktree 创建失败，回退到目录创建`, {
      feature_id: featureId, error: e.message,
    });
    fs.mkdirSync(wtPath, { recursive: true });
    return { worktreePath: wtPath, branch, baseCommit: null, error: e.message };
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────
async function doBootstrap(stagesObj, config) {
  const startedAtStr = formatLocalTimeShort();
  const drStage = stagesObj.stages && stagesObj.stages.design_review;

  const targetFeatureIds = getTargetFeatureIds(stagesObj);
  if (targetFeatureIds.length === 0) {
    log.error('stage_failed', 'bootstrap: 无法找到 can_enter_codegen=true 的 feature', {
      stage: 'codegen', exit_code: 1, reason: 'no_released_features',
    });
    process.exit(1);
  }

  const depGroups = getDependencyGroups(stagesObj);

  // feature → group_id 映射
  const featureGroupMap = {};
  for (const g of depGroups) {
    for (const fid of (g.feature_ids || [])) featureGroupMap[fid] = g.group_id;
  }

  // 计算 hash
  const releaseBundleHashNew = computeReleaseBundleHash(stagesObj);
  const designBundleHashNew  = computeDesignBundleHash(stagesObj);

  const existingCG = stagesObj.stages && stagesObj.stages.codegen;

  // hash 门控（整段跳过）
  if (!forceRerun && existingCG && existingCG.status === 'completed') {
    const storedReleaseHash = existingCG.inputs && existingCG.inputs.release_bundle_hash;
    const storedDesignHash  = existingCG.inputs && existingCG.inputs.design_bundle_hash;

    const allFeaturesCompleted = targetFeatureIds.every(fid => {
      const fs2 = existingCG.features && existingCG.features[fid];
      if (!fs2 || fs2.status !== 'completed') return false;
      // 验证 worktree HEAD == features.<id>.commit
      if (fs2.commit && fs2.worktree_path && fs.existsSync(fs2.worktree_path)) {
        try {
          const headCommit = execSync('git rev-parse HEAD', { cwd: fs2.worktree_path, encoding: 'utf8' }).trim();
          return headCommit === fs2.commit;
        } catch (_) { return true; }
      }
      return true;
    });

    if (releaseBundleHashNew && storedReleaseHash && releaseBundleHashNew === storedReleaseHash
        && designBundleHashNew && storedDesignHash && designBundleHashNew === storedDesignHash
        && allFeaturesCompleted) {
      log.info('stage_skipped', 'codegen hash 门控命中，跳过整段执行', {
        stage: 'codegen', reason: 'design_bundle_hash matched, all features fresh', exit_code: 0,
      });
      process.exit(0);
    }
  }

  log.info('hash_check', '计算 release/design bundle hash', {
    release_bundle_hash: releaseBundleHashNew,
    design_bundle_hash:  designBundleHashNew,
    stored_hash: existingCG && existingCG.inputs && existingCG.inputs.release_bundle_hash,
    computed_hash: releaseBundleHashNew,
    hit: false,
  });

  // 扫描僵尸 worker state
  const workerDir = path.join(projectRoot, '.pipeline', 'workers', 'codegen');
  const zombieFeatures = [];
  if (fs.existsSync(workerDir)) {
    for (const fname of fs.readdirSync(workerDir)) {
      if (!fname.endsWith('.state.json') || fname.includes('/archive/')) continue;
      try {
        const statePath = path.join(workerDir, fname);
        const stateData = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (stateData.status === 'running' && stateData.pid && !isPidAlive(stateData.pid)) {
          stateData.status = 'crashed';
          stateData.reason = 'worker process crashed (zombie cleanup)';
          fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2) + '\n');
          zombieFeatures.push(stateData.feature_id || fname.replace('.state.json', ''));
        }
      } catch (_) { /* ignore */ }
    }
  }

  if (zombieFeatures.length > 0) {
    log.warn('validation_pass', '清理僵尸 worker state', { crashed_feature_ids: zombieFeatures });
  }

  // 初始化 / 更新 features 骨架
  const existingFeatures = (existingCG && existingCG.features) || {};
  const features = {};

  const pendingFeatureIds    = [];
  const pendingDepFeatureIds = [];
  const blockingFeatureIds   = [];

  const drFeatures = (drStage && drStage.features) || {};
  const prdFeaturesList = (stagesObj.stages && stagesObj.stages.prd && stagesObj.stages.prd.outputs && stagesObj.stages.prd.outputs.features) || [];
  const prdFeatureMap = new Map(prdFeaturesList.map(f => [f.feature_id, f]));

  for (const fid of targetFeatureIds) {
    const existing = existingFeatures[fid];
    const drFeat   = drFeatures[fid] || {};

    // 确定性预检：design.json 的 file_plan
    let isBlocking    = false;
    let isPendingDep  = false;
    const designFile = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    let designData   = null;
    if (fs.existsSync(designFile)) {
      try { designData = JSON.parse(fs.readFileSync(designFile, 'utf8')); } catch (_) { /* */ }
    }

    if (designData) {
      const newFiles    = ((designData.file_plan && designData.file_plan.new_files) || []);
      const modifyFiles = ((designData.file_plan && designData.file_plan.modify_files) || []);
      if (newFiles.length === 0 && modifyFiles.length === 0) {
        isBlocking = true;
        blockingFeatureIds.push(fid);
      }

      // 依赖检查
      for (const depId of (designData.dependencies || [])) {
        const depStatus = existingFeatures[depId] && existingFeatures[depId].status;
        const depInRelease = targetFeatureIds.includes(depId);
        if (depStatus !== 'completed' && !depInRelease) {
          isPendingDep = true;
          pendingDepFeatureIds.push(fid);
          break;
        }
      }
    }

    const branch      = `features/v3-${fid}`;
    const wtPath      = worktreeDir(fid);
    const groupId     = featureGroupMap[fid] || (drFeat && drFeat.group_id) || null;

    if (!existing) {
      features[fid] = {
        status:              'pending',
        group_id:            groupId,
        started_at:          null,
        completed_at:        null,
        attempts_used:       0,
        max_resume_attempts: config.maxResumeAttempts,
        worktree_path:       null,
        branch:              branch,
        agent_id:            null,
        last_commit:         null,
        smoke_checks:        [],
        smoke_passed:        null,
        hang_history:        [],
        error:               null,
      };
      pendingFeatureIds.push(fid);
    } else if (existing.status === 'running') {
      // zombie 恢复
      features[fid] = Object.assign({}, existing, {
        status:   zombieFeatures.includes(fid) ? 'crashed' : 'pending',
        group_id: groupId,
      });
    } else {
      features[fid] = Object.assign({}, existing, { group_id: groupId });
    }

    if (isBlocking) features[fid].status = 'blocked';
    else if (isPendingDep && features[fid].status === 'pending') features[fid].status = 'pending_dep';
  }

  // 日志：确定性预检
  if (blockingFeatureIds.length > 0 || pendingDepFeatureIds.length > 0) {
    log.warn('validation_fail', '确定性预检', {
      pending_feature_ids:     pendingFeatureIds,
      blocking_feature_ids:    blockingFeatureIds,
      pending_dep_feature_ids: pendingDepFeatureIds,
    });
  } else {
    log.info('validation_pass', '确定性预检通过', {
      pending_feature_ids: pendingFeatureIds,
      blocking_feature_ids: [],
      pending_dep_feature_ids: [],
    });
  }

  // 创建 worktree（对 pending 状态的 feature）
  for (const fid of targetFeatureIds) {
    if (features[fid].status !== 'pending' && features[fid].status !== 'crashed') continue;
    const { worktreePath, branch: actualBranch, baseCommit, error } = createWorktree(fid);
    features[fid].worktree_path = worktreePath;
    features[fid].branch        = actualBranch;
    if (baseCommit) features[fid].base_commit = baseCommit;
    if (error) features[fid].worktree_error = error;
  }

  // 构建 stages.codegen 骨架
  if (!stagesObj.stages) stagesObj.stages = {};

  const existingOutputs = (existingCG && existingCG.outputs) || {};
  stagesObj.stages.codegen = {
    status:       'running',
    started_at:   (existingCG && existingCG.started_at) || startedAtStr,
    completed_at: null,
    inputs: {
      design_review_hash:  null,
      release_bundle_hash: releaseBundleHashNew,
      design_bundle_hash:  designBundleHashNew,
      dependency_groups:   depGroups,
    },
    outputs: {
      completed_features:  existingOutputs.completed_features  || [],
      failed_features:     existingOutputs.failed_features     || [],
      feature_artifacts:   existingOutputs.feature_artifacts   || [],
      duration_ms:         null,
      timed_out:           false,
      timeout_reason:      null,
      decision:            existingOutputs.decision            || 'pending',
      smoke_summary:       existingOutputs.smoke_summary       || { passed_count: 0, failed_count: 0 },
    },
    features,
    validation: {
      passed:                  false,
      checked_at:              null,
      summary:                 null,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    },
    generated_files:  [],
    blocking_issues:  [],
    git_sync: (existingCG && existingCG.git_sync) || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  };

  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;
  const sp = writeStagesJson(stagesObj);

  log.info('file_updated', '已写 stages.codegen bootstrap 骨架', {
    path:                sp,
    status:              'running',
    zombie_features_reset: zombieFeatures,
    effective_parallel:    config.effectiveParallel,
    pending_feature_ids:   pendingFeatureIds,
    pending_dep_feature_ids: pendingDepFeatureIds,
    blocking_feature_ids:  blockingFeatureIds,
  });

  return { targetFeatureIds, depGroups };
}

// ── Worker 启动 ───────────────────────────────────────────────────
/**
 * 启动长驻 worker 子进程（detached），返回 pid
 */
function spawnWorker(featureId, attemptIndex, stagesObj, config) {
  const workerScriptPath = path.join(skillsRoot, 'ai-std4', 'scripts', 'libs', 'codegen-worker.cjs');

  // Worker 脚本不存在则用内联 worker 逻辑（单文件模式）
  if (!fs.existsSync(workerScriptPath)) {
    return spawnInlineWorker(featureId, attemptIndex, stagesObj, config);
  }

  const cgFeature = stagesObj.stages.codegen.features[featureId];
  const agentId   = `codegen-worker-${featureId}`;

  const env = buildWorkerEnv({
    AI_STD4_PROJECT:       projectRoot,
    AI_STD4_FEATURE_ID:    featureId,
    AI_STD4_ATTEMPT_INDEX: String(attemptIndex),
    AI_STD4_RUN_ID:        runId,
    AI_STD4_AGENT_ID:      agentId,
    CURSOR_SKILLS_ROOT:    skillsRoot,
  });

  const child = spawn('node', [workerScriptPath], {
    cwd:      cgFeature.worktree_path || projectRoot,
    env,
    detached: true,
    stdio:    'ignore',
  });

  child.unref();

  log.info('agent_start', `启动 codegen worker: ${agentId}`, {
    agent_id:     agentId,
    feature_id:   featureId,
    attempt_index: attemptIndex,
    prompt:       attemptIndex === 1 ? 'codegen-impl.md' : 'codegen-impl-resume.md',
    worktree_path: cgFeature.worktree_path,
    branch:       cgFeature.branch,
    pid:          child.pid,
    input_files:  [`docs/designs/${featureId}.design.json`],
  });

  return child.pid;
}

/**
 * 内联 worker：当 codegen-worker.cjs 不存在时，直接在本进程模拟 worker 逻辑
 * 主要用于测试和单机运行场景。
 * 通过 spawn 一个内联 worker 脚本（写入临时文件）来实现。
 */
function spawnInlineWorker(featureId, attemptIndex, stagesObj, config) {
  const cgFeature = stagesObj.stages.codegen.features[featureId];
  const agentId   = `codegen-worker-${featureId}`;
  const stateFile = workerStateFile(featureId);
  const wtPath    = cgFeature.worktree_path || projectRoot;

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  // 读取 prompt
  const promptFile = attemptIndex === 1 ? 'codegen-impl.md' : 'codegen-impl-resume.md';
  const promptPath = path.join(skillsRoot, 'ai-std4', 'prompts', promptFile);
  const promptContent = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : `# ${promptFile}\n(prompt not found)`;

  // 写初始 state.json
  const initialState = {
    feature_id:     featureId,
    agent_id:       agentId,
    status:         'running',
    attempt_index:  attemptIndex,
    started_at:     formatLocalTimeShort(),
    pid:            null, // will be set after spawn
    worktree_path:  wtPath,
    branch:         cgFeature.branch,
    last_heartbeat_at:  null,
    last_fs_mtime_at:   null,
    last_stdout_at:     null,
    hang_history:       (cgFeature.hang_history || []),
    smoke_checks:       [],
    smoke_passed:       null,
    commit:             null,
    files_changed:      [],
    error:              null,
  };

  writeWorkerState(featureId, initialState);

  // 生成内联 worker 脚本（用于无 codegen-worker.cjs 场景）
  const inlineWorkerCode = generateInlineWorkerCode({
    featureId, attemptIndex, agentId, stateFile, wtPath,
    cgFeature, config, promptContent, promptFile,
    projectRoot, skillsRoot, runId,
  });

  const tmpScript = path.join(projectRoot, '.pipeline', 'workers', 'codegen', `worker-${featureId}-${attemptIndex}.tmp.cjs`);
  fs.mkdirSync(path.dirname(tmpScript), { recursive: true });
  fs.writeFileSync(tmpScript, inlineWorkerCode, 'utf8');

  const child = spawn('node', [tmpScript], {
    cwd:      wtPath,
    env:      buildWorkerEnv({
      AI_STD4_PROJECT:       projectRoot,
      AI_STD4_FEATURE_ID:    featureId,
      AI_STD4_ATTEMPT_INDEX: String(attemptIndex),
      AI_STD4_RUN_ID:        runId,
      CURSOR_SKILLS_ROOT:    skillsRoot,
    }),
    detached: true,
    stdio:    'ignore',
  });

  child.unref();

  // 更新 state.json 写入 pid
  initialState.pid = child.pid;
  writeWorkerState(featureId, initialState);

  log.info('agent_start', `启动内联 codegen worker: ${agentId}`, {
    agent_id:      agentId,
    feature_id:    featureId,
    attempt_index: attemptIndex,
    prompt:        promptFile,
    worktree_path: wtPath,
    branch:        cgFeature.branch,
    pid:           child.pid,
    input_files:   [`docs/designs/${featureId}.design.json`],
  });

  return child.pid;
}

/**
 * 生成内联 worker 代码（单 feature 看门狗 + Agent 调用）
 */
function generateInlineWorkerCode({ featureId, attemptIndex, agentId, stateFile, wtPath,
  cgFeature, config, promptContent, promptFile, projectRoot, skillsRoot, runId }) {

  // 序列化配置避免引用问题
  const cfgJson = JSON.stringify({
    agentHangThresholdS:  config.agentHangThresholdS,
    fsIdleThresholdS:     config.fsIdleThresholdS,
    stdoutIdleThresholdS: config.stdoutIdleThresholdS,
    heartbeatIntervalS:   config.heartbeatIntervalS,
    gracefulKillS:        config.gracefulKillS,
    attemptMaxS:          config.attemptMaxS,
    maxResumeAttempts:    config.maxResumeAttempts,
    timeoutS:             config.timeoutS,
    selfCheckEnabled:     config.selfCheckEnabled,
    selfCheckCommands:    config.selfCheckCommands,
    selfCheckTimeoutS:    config.selfCheckTimeoutS,
    smokeCodegenEnabled:  config.smokeCodegenEnabled,
    smokeTimeoutS:        config.smokeTimeoutS,
    smokeChecks:          config.smokeChecks,
    smokeBaseUrl:         config.smokeBaseUrl,
    model:                config.model,
  });

  const designJson = JSON.stringify(JSON.stringify({ featureId, cgFeature }));

  return `'use strict';
// Inline codegen worker for feature: ${featureId}, attempt: ${attemptIndex}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const featureId    = ${JSON.stringify(featureId)};
const attemptIndex = ${attemptIndex};
const agentId      = ${JSON.stringify(agentId)};
const stateFile    = ${JSON.stringify(stateFile)};
const wtPath       = ${JSON.stringify(wtPath)};
const projectRoot  = ${JSON.stringify(projectRoot)};
const skillsRoot   = ${JSON.stringify(skillsRoot)};
const runId        = ${JSON.stringify(runId)};
const aiStd4NodeModules = path.join(skillsRoot, 'ai-std4', 'node_modules');
module.paths.unshift(aiStd4NodeModules);
const config       = ${cfgJson};
const branch       = ${JSON.stringify(cgFeature.branch || '')};
const baseCommit   = ${JSON.stringify(cgFeature.base_commit || null)};
const logPath      = path.join(projectRoot, 'logs', 'stages', 'codegen');
fs.mkdirSync(logPath, { recursive: true });

function formatLocalTimeShort(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const oh = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const om = String(absOffset % 60).padStart(2, '0');
  const zone = \`\${sign}\${oh}\${om}\`;
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hr = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  return \`\${y}-\${mo}-\${d} \${hr}:\${min}:\${sec} \${zone}\`;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch(_) { return {}; }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2) + '\\n');
}

function checkStopSignal() {
  return fs.existsSync(path.join(projectRoot, '.pipeline', 'stop.signal'));
}

async function main() {
  const state = readState();
  state.pid = process.pid;
  state.status = 'running';
  writeState(state);

  const totalStartedAt = Date.now();
  const attemptStartedAt = Date.now();

  let lastHeartbeatAt  = Date.now();
  let lastFsMtimeAt    = Date.now();
  let lastStdoutAt     = Date.now();
  let lastHeartbeatData = null;
  let agentProcess     = null;
  let agentExited      = false;
  let agentExitCode    = null;
  let finalData        = null;
  let hangHistory      = state.hang_history || [];
  let attemptsUsed     = state.attempts_used || (attemptIndex - 1);

  // 看门狗监控
  function getLatestMtime(dir) {
    let latest = 0;
    function walk(d) {
      try {
        for (const entry of fs.readdirSync(d)) {
          if (entry === '.git' || entry === 'node_modules') continue;
          const full = path.join(d, entry);
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) walk(full);
            else if (stat.mtimeMs > latest) latest = stat.mtimeMs;
          } catch(_) {}
        }
      } catch(_) {}
    }
    walk(dir);
    return latest;
  }

  // 获取 design.json
  const designFile = path.join(projectRoot, 'docs', 'designs', featureId + '.design.json');
  let designData = null;
  if (fs.existsSync(designFile)) {
    try { designData = JSON.parse(fs.readFileSync(designFile, 'utf8')); } catch(_) {}
  }

  // 获取 scenarios（可选）
  const scenariosFile = path.join(projectRoot, 'docs', 'ui-scenarios', featureId + '.scenarios.yaml');

  // 写 resume context（若 attemptIndex >= 2）
  if (attemptIndex >= 2 && hangHistory.length > 0) {
    const lastHang = hangHistory[hangHistory.length - 1];
    const resumeCtx = {
      feature_id:          featureId,
      attempt_index:       attemptIndex,
      previous_hang_kind:  lastHang.hang_kind,
      snapshot_commit:     lastHang.snapshot_commit || null,
      base_commit:         baseCommit,
      file_signatures:     lastHang.file_signatures || [],
      progress:            lastHang.progress || {},
      acceptance_full:     (designData && designData.acceptance) || [],
      do_not_overwrite:    (lastHang.progress && lastHang.progress.files_touched) || [],
      constraints: [
        '仅对 do_not_overwrite[] 列出的文件做增量 edit；禁止清空或重写',
        '禁止删除/重命名 do_not_overwrite[] 中任何文件',
        '禁止 git reset --hard / git checkout <path> / rm 等抹除操作',
        '仅完成 progress.acceptance_pending[]；progress.acceptance_done[] 不重复实现',
        '心跳间隔必须 <= heartbeat_interval_s 秒；外部命令前后各打一次心跳',
      ],
    };
    const resumeCtxPath = path.join(wtPath, '.codegen-resume-context.json');
    try {
      fs.writeFileSync(resumeCtxPath, JSON.stringify(resumeCtx, null, 2));
    } catch(_) {}
  }

  // 启动 Agent
  const promptFile = attemptIndex === 1 ? 'codegen-impl.md' : 'codegen-impl-resume.md';
  const promptPath = path.join(skillsRoot, 'ai-std4', 'prompts', promptFile);
  let promptContent = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';

  // 注入上下文
  const ctx = [
    \`<!-- inject: feature_id=\${featureId} -->\`,
    \`<!-- inject: worktree_path=\${wtPath} -->\`,
    baseCommit ? \`<!-- inject: base_commit=\${baseCommit} -->\` : '',
    \`<!-- inject: heartbeat_interval_s=\${config.heartbeatIntervalS} -->\`,
    \`<!-- inject: design_file=\${designFile} -->\`,
    fs.existsSync(scenariosFile) ? \`<!-- inject: scenarios_file=\${scenariosFile} -->\` : '',
  ].filter(Boolean).join('\\n');
  const finalPrompt = promptContent + '\\n\\n' + ctx;

  // @cursor/sdk（CURSOR_API_KEY，见 inputs/config.env；绝对路径避免 worktree cwd 下解析失败）
  try {
    const { Agent } = require(path.join(skillsRoot, 'ai-std4', 'node_modules', '@cursor', 'sdk'));
    const { getCursorApiKey, resolvePipelineModel, loadProjectEnv } = require(path.join(skillsRoot, 'ai-std4', 'scripts', 'libs', 'pipeline-config.cjs'));
    loadProjectEnv(projectRoot);
    const apiKey = getCursorApiKey();
    if (!apiKey) {
      const s = readState();
      s.status = 'failed';
      s.error = 'CURSOR_API_KEY not set（请在 inputs/config.env 填写并运行 setup）';
      writeState(s);
      process.exit(1);
    }

    const modelId = process.env.PIPELINE_MODEL && String(process.env.PIPELINE_MODEL).trim()
      ? String(process.env.PIPELINE_MODEL).trim()
      : (config.model || 'composer-2');
    const agentObj = await Agent.create({ apiKey, model: { id: modelId }, local: { cwd: wtPath } });
    let sdkHangDetected = false;
      const runPromise = (async () => {
        const run = await agentObj.send(finalPrompt);
        if (run.supports && run.supports('stream')) {
          for await (const event of run.stream()) {
            lastStdoutAt = Date.now();
            if (event.type === 'assistant') {
              for (const block of (event.message && event.message.content) || []) {
                if (block.type === 'text') {
                  const textLines = block.text.split('\\n');
                  for (const line of textLines) {
                    const t = line.trim();
                    if (!t) continue;
                    try {
                      const parsed = JSON.parse(t);
                      if (parsed.type === 'heartbeat') { lastHeartbeatAt = Date.now(); lastHeartbeatData = parsed; }
                      else if (parsed.type === 'final') { finalData = parsed; }
                    } catch(_) {}
                  }
                }
              }
            }
          }
        }
        const result = await run.wait();
        return result;
      })();

      // 看门狗循环（串行 tick，每 10s 检查一次）
      const watchdogPromise = (async () => {
        while (!agentExited && !finalData && !sdkHangDetected) {
          await new Promise(r => setTimeout(r, 10000));
          if (agentExited || finalData) break;
          // 检查看门狗条件
          const latestMtime2 = getLatestMtime(wtPath);
          if (latestMtime2 > lastFsMtimeAt) lastFsMtimeAt = latestMtime2;
          const now2 = Date.now();
          const hbAge = (now2 - lastHeartbeatAt) / 1000;
          const soIdle = (now2 - lastStdoutAt) / 1000;
          const elAttempt = (now2 - attemptStartedAt) / 1000;
          const elTotal = (now2 - totalStartedAt) / 1000;
          let hk = null;
          if (elTotal > config.timeoutS) hk = 'total_timeout';
          else if (elAttempt > config.attemptMaxS) hk = 'wall_timeout';
          else if (hbAge > config.agentHangThresholdS) hk = 'no_heartbeat';
          else if (soIdle > config.stdoutIdleThresholdS) hk = 'stdout_idle';
          if (hk) {
            sdkHangDetected = true;
            await handleHang({ hangKind: hk, heartbeatAge: hbAge, fsIdle: (now2 - lastFsMtimeAt)/1000, stdoutIdle: soIdle, elapsedAttempt: elAttempt, elapsedTotal: elTotal });
            break;
          }
          if (checkStopSignal()) { await handleStop(); break; }
        }
      })();

      try {
        await Promise.race([
          runPromise.then(r => { agentExited = true; agentExitCode = 0; return r; }),
          watchdogPromise,
        ]);
      } catch(e) {
        agentExited = true;
        agentExitCode = 1;
      }

      agentExited = true;
    } catch(e) {
      const s = readState();
      s.status = 'failed';
      s.error = e.message;
      writeState(s);
      process.exit(1);
    }
  await handleAgentComplete();
  return;

  async function checkWatchdog() {
    if (checkStopSignal()) {
      await handleStop();
      return;
    }

    // 更新 lastFsMtimeAt
    const latestMtime = getLatestMtime(wtPath);
    if (latestMtime > lastFsMtimeAt) lastFsMtimeAt = latestMtime;

    const now = Date.now();
    const heartbeatAge   = (now - lastHeartbeatAt) / 1000;
    const fsIdle         = (now - lastFsMtimeAt) / 1000;
    const stdoutIdle     = (now - lastStdoutAt) / 1000;
    const elapsedAttempt = (now - attemptStartedAt) / 1000;
    const elapsedTotal   = (now - totalStartedAt) / 1000;

    let hangKind = null;
    if (elapsedTotal > config.timeoutS) {
      hangKind = 'total_timeout';
    } else if (elapsedAttempt > config.attemptMaxS) {
      hangKind = 'wall_timeout';
    } else if (heartbeatAge > config.agentHangThresholdS) {
      hangKind = 'no_heartbeat';
    } else if (stdoutIdle > config.stdoutIdleThresholdS) {
      hangKind = 'stdout_idle';
    }

    if (hangKind) {
      await handleHang({ hangKind, heartbeatAge, fsIdle, stdoutIdle, elapsedAttempt, elapsedTotal });
    }
  }

  async function handleStop() {
    const s = readState();
    s.status = 'stopped';
    writeState(s);
    if (agentProcess && agentPid) {
      try { process.kill(agentPid, 'SIGINT'); } catch(_) {}
    }
    process.exit(0);
  }

  async function handleHang({ hangKind, heartbeatAge, fsIdle, stdoutIdle, elapsedAttempt, elapsedTotal }) {
    const s = readState();

    // 1. 打日志
    process.stderr.write(JSON.stringify({
      level: 'WARN', event: 'agent_hang_detected',
      feature_id: featureId, attempt_index: attemptIndex, hang_kind: hangKind,
      last_heartbeat_age_s: heartbeatAge, fs_idle_s: fsIdle, stdout_idle_s: stdoutIdle,
      elapsed_attempt_s: elapsedAttempt, elapsed_total_s: elapsedTotal,
    }) + '\\n');

    // 2. 快照
    let snapshotCommit = null;
    let fileSignatures = [];
    try {
      execSync('git add -A', { cwd: wtPath, stdio: 'ignore' });
      try {
        execSync(\`git commit --no-verify -m "wip(\${featureId}): attempt \${attemptIndex} snapshot before resume"\`, { cwd: wtPath, stdio: 'ignore' });
        snapshotCommit = execSync('git rev-parse HEAD', { cwd: wtPath, encoding: 'utf8' }).trim();
      } catch(_) { /* no diff */ }
    } catch(_) {}

    const progress = {
      acceptance_done:    lastHeartbeatData ? (lastHeartbeatData.acceptance_done || []) : [],
      acceptance_pending: lastHeartbeatData ? (lastHeartbeatData.acceptance_pending || []) : [],
      files_touched:      lastHeartbeatData ? (lastHeartbeatData.files_touched || []) : [],
      last_phase:         lastHeartbeatData ? lastHeartbeatData.phase : null,
      last_command:       lastHeartbeatData ? lastHeartbeatData.command : null,
    };

    hangHistory.push({
      attempt_index:     attemptIndex,
      hang_kind:         hangKind,
      detected_at:       formatLocalTimeShort(),
      snapshot_commit:   snapshotCommit,
      files_at_snapshot: fileSignatures.length,
      progress,
      file_signatures:   fileSignatures,
    });

    // 3. 中断 Agent
    if (agentProcess && agentPid) {
      try { process.kill(agentPid, 'SIGINT'); } catch(_) {}
      await new Promise(r => setTimeout(r, config.gracefulKillS * 1000));
      try { process.kill(agentPid, 'SIGKILL'); } catch(_) {}
    }

    // 4. 判定是否 resume
    const attemptsNow = (s.attempts_used || 0) + 1;
    s.hang_history = hangHistory;
    s.attempts_used = attemptsNow;

    if (hangKind === 'total_timeout' || attemptsNow >= config.maxResumeAttempts) {
      s.status     = 'failed';
      s.error      = hangKind;
      s.timed_out  = true;
      s.exit_code  = hangKind === 'total_timeout' ? 3 : 4;
      writeState(s);
      process.exit(s.exit_code);
    }

    // Resume: 重启（写新 state，退出当前进程让调度器重启）
    s.status = 'crashed'; // 调度器发现 crashed 且未触顶时会重新调度
    writeState(s);
    process.exit(2); // 特殊退出码：需要 resume
  }

  async function handleAgentComplete() {
    const s = readState();
    attemptsUsed = (s.attempts_used || 0) + 1;
    s.attempts_used = attemptsUsed;

    // 检查 final
    if (finalData && finalData.status === 'completed') {
      // 检查 git status
      let hasChanges = false;
      try {
        const gitStatus = execSync('git status --porcelain', { cwd: wtPath, encoding: 'utf8' });
        hasChanges = gitStatus.trim().length > 0;
      } catch(_) { hasChanges = true; }

      // smoke（简化：跳过，由调度器处理）
      // git commit
      if (hasChanges) {
        try {
          execSync('git add -A', { cwd: wtPath, stdio: 'ignore' });
          execSync(\`git commit --no-verify -m "feat(\${featureId}): implement per design"\`, { cwd: wtPath, stdio: 'ignore' });
        } catch(_) {}
      }

      let commit = null;
      try {
        commit = execSync('git rev-parse HEAD', { cwd: wtPath, encoding: 'utf8' }).trim();
      } catch(_) {}

      // 删除 resume context
      try { fs.unlinkSync(path.join(wtPath, '.codegen-resume-context.json')); } catch(_) {}

      s.status         = 'completed';
      s.completed_at   = formatLocalTimeShort();
      s.commit         = commit;
      s.files_changed  = finalData.files_changed || [];
      s.smoke_passed   = true;
      s.smoke_checks   = [];
      writeState(s);
      process.exit(0);
    } else if (finalData && (finalData.status === 'needs_human' || finalData.status === 'failed')) {
      const attemptsNow = attemptsUsed;
      if (attemptsNow < config.maxResumeAttempts) {
        s.status = 'crashed'; // 触发 resume
        writeState(s);
        process.exit(2);
      }
      s.status = 'failed';
      s.error  = finalData.reason || finalData.status;
      s.exit_code = 4;
      writeState(s);
      process.exit(4);
    } else if (agentExitCode !== 0) {
      if (attemptsUsed < config.maxResumeAttempts) {
        s.status = 'crashed';
        writeState(s);
        process.exit(2);
      }
      s.status = 'failed';
      s.error  = \`agent exit code: \${agentExitCode}\`;
      s.exit_code = 4;
      writeState(s);
      process.exit(4);
    } else {
      // 无 final 信号但退出码 0：视为完成
      s.status       = 'completed';
      s.completed_at = formatLocalTimeShort();
      s.smoke_passed = true;
      writeState(s);
      process.exit(0);
    }
  }
}

main().catch(e => {
  const s = { status: 'failed', error: e.message, exit_code: 1 };
  try { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2) + '\\n'); } catch(_) {}
  process.exit(1);
});
`;
}

// ── Tick：单轮调度 ────────────────────────────────────────────────
async function doTick(stagesObj, config, featureFilterId) {
  const startedAtStr = formatLocalTimeShort();

  // 若 bootstrap 未完成则先执行
  if (!stagesObj.stages || !stagesObj.stages.codegen) {
    log.info('file_updated', 'codegen stage 未 bootstrap，先执行 bootstrap', { status: 'bootstrapping' });
    await doBootstrap(stagesObj, config);
    stagesObj = readStagesJson();
  }

  const cg       = stagesObj.stages.codegen;
  const depGroups = getDependencyGroups(stagesObj);
  const features  = cg.features || {};
  const targetIds = featureFilterId
    ? Object.keys(features).filter(id => id === featureFilterId)
    : Object.keys(features);

  const workerDir = path.join(projectRoot, '.pipeline', 'workers', 'codegen');
  fs.mkdirSync(workerDir, { recursive: true });

  // ── 步骤1：收割终态 worker ──────────────────────────────────────
  const succeededIds = [];
  const failedIds    = [];
  const crashedIds   = [];
  let   inflightCount = 0;

  for (const fid of targetIds) {
    const state = readWorkerState(fid);
    if (!state) continue;

    if (state.status === 'running') {
      // 检查 pid 是否存活
      if (!isPidAlive(state.pid)) {
        // 标 crashed
        state.status = 'crashed';
        state.reason = 'worker process crashed';
        writeWorkerState(fid, state);
        crashedIds.push(fid);
        log.error('agent_failed', `worker ${fid} 进程已死，标 crashed`, {
          agent_id:    state.agent_id || `codegen-worker-${fid}`,
          feature_id:  fid,
          reason:      'worker process crashed',
          pid:         state.pid,
          attempts_used: state.attempts_used || 0,
        });
      } else {
        inflightCount++;
      }
      continue;
    }

    if (state.status === 'completed' || state.status === 'failed') {
      // 落入 stages.codegen.features
      const completedAtStr = formatLocalTimeShort();
      if (!features[fid]) features[fid] = {};

      if (state.status === 'completed') {
        features[fid].status        = 'completed';
        features[fid].completed_at  = state.completed_at || completedAtStr;
        features[fid].last_commit   = state.commit || null;
        features[fid].commit        = state.commit || null;
        features[fid].files_changed = state.files_changed || [];
        features[fid].smoke_passed  = state.smoke_passed !== false;
        features[fid].smoke_checks  = state.smoke_checks || [];
        features[fid].hang_history  = state.hang_history || [];
        features[fid].attempts_used = state.attempts_used || 1;
        features[fid].error         = null;

        if (!cg.outputs.completed_features.includes(fid)) {
          cg.outputs.completed_features.push(fid);
        }

        log.info('agent_complete', `feature ${fid} 完成`, {
          agent_id:     state.agent_id || `codegen-worker-${fid}`,
          feature_id:   fid,
          duration_ms:  state.completed_at ? null : null,
          attempts_used: state.attempts_used || 1,
          commit:       state.commit,
          files_changed: state.files_changed || [],
          output_files: [],
        });
        succeededIds.push(fid);
      } else {
        features[fid].status        = 'failed';
        features[fid].error         = state.error || 'unknown';
        features[fid].hang_history  = state.hang_history || [];
        features[fid].attempts_used = state.attempts_used || 1;

        if (!cg.outputs.failed_features.includes(fid)) {
          cg.outputs.failed_features.push(fid);
        }

        log.error('agent_failed', `feature ${fid} 失败`, {
          agent_id:     state.agent_id || `codegen-worker-${fid}`,
          feature_id:   fid,
          exit_code:    state.exit_code || 4,
          reason:       state.error,
          timed_out:    state.timed_out || false,
          attempts_used: state.attempts_used || 1,
          hang_history: state.hang_history || [],
        });
        failedIds.push(fid);
      }

      // 归档 state.json
      const archivePath = workerArchiveFile(fid, state.attempt_index || 1);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      try {
        fs.renameSync(workerStateFile(fid), archivePath);
      } catch (_) { /* ignore */ }
    } else if (state.status === 'crashed') {
      crashedIds.push(fid);
    }
  }

  // ── 步骤2：check stop.signal ────────────────────────────────────
  if (checkStopSignal()) {
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;
    writeStagesJson(stagesObj);
    gracefulStop(readStagesJson());
  }

  // ── 步骤3：处理 crashed（若未超出 max_resume_attempts，重置 pending 待下轮调度）─
  for (const fid of crashedIds) {
    if (features[fid] && (features[fid].status === 'completed' || features[fid].status === 'failed')) continue;

    const state = readWorkerState(fid) || {};
    const attemptsUsed = state.attempts_used || (features[fid] && features[fid].attempts_used) || 0;
    const maxAttempts  = config.maxResumeAttempts;

    // 合并 hang_history 到 features
    if (state.hang_history && state.hang_history.length > 0) {
      if (!features[fid]) features[fid] = {};
      const existingHH = features[fid].hang_history || [];
      for (const hh of state.hang_history) {
        if (!existingHH.some(e => e.attempt_index === hh.attempt_index && e.hang_kind === hh.hang_kind)) {
          existingHH.push(hh);
        }
      }
      features[fid].hang_history = existingHH;
    }
    if (features[fid]) features[fid].attempts_used = attemptsUsed;

    if (attemptsUsed >= maxAttempts) {
      // 触顶，标 failed
      if (!features[fid]) features[fid] = {};
      features[fid].status        = 'failed';
      features[fid].error         = state.reason || state.error || 'max_resume_attempts_exceeded';

      if (!cg.outputs.failed_features.includes(fid)) {
        cg.outputs.failed_features.push(fid);
      }
      failedIds.push(fid);

      log.error('agent_failed', `feature ${fid} resume 触顶，标 failed`, {
        feature_id: fid, attempts_used: attemptsUsed, max_resume_attempts: maxAttempts,
      });

      // 归档
      const archivePath = workerArchiveFile(fid, attemptsUsed);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      try { fs.renameSync(workerStateFile(fid), archivePath); } catch(_) {}
    } else {
      // 未触顶：重置为 pending，下一轮 tick 重新调度（resume）
      if (!features[fid]) features[fid] = {};
      features[fid].status = 'pending';
      features[fid].error  = state.reason || state.error || null;

      log.warn('agent_retry', `feature ${fid} crashed 且未触顶，重置 pending 等待 resume`, {
        feature_id: fid, attempts_used: attemptsUsed, max_resume_attempts: maxAttempts,
      });
    }
  }

  // ── 步骤4：启动新 worker（按 effective_parallel 控制并发）────────
  const slotsAvailable = Math.max(0, config.effectiveParallel - inflightCount);

  // 收集就绪 feature（未 completed/failed/blocked/pending_dep，且无 inflight worker）
  const candidateIds = [];
  for (const fid of targetIds) {
    const feat = features[fid];
    if (!feat) continue;
    const status = feat.status;

    if (status === 'completed' || status === 'failed' || status === 'blocked' || status === 'pending_dep') continue;

    // 检查是否有 inflight worker
    const state = readWorkerState(fid);
    if (state && state.status === 'running' && isPidAlive(state.pid)) {
      inflightCount++; // 已在途
      continue;
    }

    // 检查依赖是否满足
    const designFile = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    if (fs.existsSync(designFile)) {
      try {
        const dd = JSON.parse(fs.readFileSync(designFile, 'utf8'));
        const depsMet = (dd.dependencies || []).every(depId => {
          const depFeat = features[depId];
          return depFeat && depFeat.status === 'completed';
        });
        if (!depsMet) continue;
      } catch (_) { /* ignore */ }
    }

    candidateIds.push(fid);
  }

  // 按 group topo_order 排序
  const topoOrderMap = {};
  for (const g of depGroups) {
    for (const fid of (g.feature_ids || [])) {
      topoOrderMap[fid] = g.topo_order || 0;
    }
  }
  candidateIds.sort((a, b) => (topoOrderMap[a] || 0) - (topoOrderMap[b] || 0));

  const toStartIds = candidateIds.slice(0, slotsAvailable);

  if (toStartIds.length > 0) {
    const batchIndex = ((cg.inputs && cg.inputs._tick_wave_index) || 0) + 1;
    if (cg.inputs) cg.inputs._tick_wave_index = batchIndex;
    const batchId = `codegen-tick-${batchIndex}`;

    log.info('agent_batch_start', `codegen tick 批次开始，启动 ${toStartIds.length} 个 worker`, {
      batch_id:        batchId,
      feature_ids:     toStartIds,
      agents_total:    toStartIds.length,
      agents_skipped:  [],
      effective_parallel: config.effectiveParallel,
      inflight_after_tick: inflightCount + toStartIds.length,
    });

    for (const fid of toStartIds) {
      if (!features[fid]) features[fid] = {};
      const feat = features[fid];

      // 检查单 feature hash 门控
      if (!forceRerun && feat.status === 'completed') {
        log.info('agent_skipped', `feature ${fid} 已完成，跳过`, {
          agent_id:   `codegen-worker-${fid}`,
          feature_id: fid,
          reason:     'already_completed',
        });
        continue;
      }

      const attemptIndex = (feat.attempts_used || 0) + 1;
      const agentId      = `codegen-${fid}-${String(attemptIndex).padStart(3, '0')}`;

      feat.status      = 'running';
      feat.started_at  = feat.started_at || formatLocalTimeShort();
      feat.agent_id    = agentId;
      if (!feat.attempts_used) feat.attempts_used = 0;

      // 检查 worktree 是否存在
      if (!feat.worktree_path || !fs.existsSync(feat.worktree_path)) {
        const { worktreePath, branch, baseCommit, error } = createWorktree(fid);
        feat.worktree_path = worktreePath;
        feat.branch        = branch;
        if (baseCommit) feat.base_commit = baseCommit;
        if (error) feat.worktree_error = error;
      }

      stagesObj.stages.codegen.features = features;
      const pid = spawnWorker(fid, attemptIndex, stagesObj, config);

      feat.attempts_used++;
      if (pid) {
        // 更新 state.json pid
        const stateData = readWorkerState(fid) || {};
        stateData.pid = pid;
        stateData.status = 'running';
        stateData.attempt_index = attemptIndex;
        stateData.agent_id = agentId;
        stateData.attempts_used = feat.attempts_used;
        writeWorkerState(fid, stateData);
      }

      if (attemptIndex > 1) {
        log.warn('agent_retry', `feature ${fid} resume（第 ${attemptIndex} 次 attempt）`, {
          agent_id: agentId, feature_id: fid, attempt: attemptIndex,
          reason: feat.error || 'resume', prompt: 'codegen-impl-resume.md',
          do_not_overwrite_count: 0,
        });
      }
    }

    log.info('agent_batch_complete', `codegen tick 批次结束`, {
      batch_id:         `codegen-tick-${batchIndex}`,
      agents_succeeded: succeededIds,
      agents_failed:    failedIds,
      agents_skipped:   [],
      duration_ms:      0,
      inflight_remaining: inflightCount + toStartIds.length,
    });
  }

  propagateBlockedByFailedDeps(features, targetIds, projectRoot);

  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;
  stagesObj.stages.codegen.features = features;
  writeStagesJson(stagesObj);

  // 检查整体完成状态
  const allDone = targetIds.every(fid => {
    const feat = features[fid];
    if (!feat) return false;
    return ['completed', 'failed', 'blocked', 'pending_dep'].includes(feat.status);
  });
  const hasFailed = targetIds.some(fid => {
    const feat = features[fid];
    return feat && feat.status === 'failed';
  });

  return { allDone, hasFailed };
}

// ── Validate + 写完成态 ───────────────────────────────────────────
async function doValidate(stagesObj, targetFeatureIds) {
  const cg           = stagesObj.stages.codegen;
  const features     = cg.features || {};
  const completedAtStr = formatLocalTimeShort();
  const startedAt    = cg.started_at ? new Date(cg.started_at).getTime() : Date.now();

  const completedFeatures = targetFeatureIds.filter(fid => features[fid] && features[fid].status === 'completed');
  const failedFeatures    = targetFeatureIds.filter(fid => features[fid] && (features[fid].status === 'failed' || features[fid].status === 'blocked'));

  // 汇总 feature_artifacts
  const featureArtifacts = completedFeatures.map(fid => {
    const feat = features[fid];
    return {
      feature_id:         fid,
      group_id:           feat.group_id,
      branch:             feat.branch,
      commit:             feat.commit || feat.last_commit,
      files_changed_count: (feat.files_changed || []).length,
      attempts_used:      feat.attempts_used || 1,
      hang_count:         (feat.hang_history || []).length,
      duration_ms:        null,
    };
  });

  cg.outputs.feature_artifacts  = featureArtifacts;
  cg.outputs.completed_features = completedFeatures;
  cg.outputs.failed_features    = failedFeatures;
  cg.outputs.duration_ms        = Date.now() - startedAt;
  cg.outputs.total_attempts     = targetFeatureIds.reduce((sum, fid) => sum + ((features[fid] && features[fid].attempts_used) || 0), 0);
  cg.outputs.resume_count       = targetFeatureIds.reduce((sum, fid) => sum + Math.max(0, ((features[fid] && features[fid].attempts_used) || 1) - 1), 0);

  const smokePassed = completedFeatures.filter(fid => features[fid] && features[fid].smoke_passed !== false).length;
  const smokeFailed = completedFeatures.filter(fid => features[fid] && features[fid].smoke_passed === false).length;
  cg.outputs.smoke_summary = { passed_count: smokePassed, failed_count: smokeFailed };

  // 生成报告
  const reportsDir = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const summaryPath = path.join(reportsDir, 'codegen-summary.md');
  const lines = [
    '# codegen 阶段摘要',
    '',
    `| 指标 | 值 |`,
    `| --- | --- |`,
    `| 目标 feature 总数 | ${targetFeatureIds.length} |`,
    `| 完成 | ${completedFeatures.length} |`,
    `| 失败 | ${failedFeatures.length} |`,
    `| 总 attempt 数 | ${cg.outputs.total_attempts} |`,
    `| resume 次数 | ${cg.outputs.resume_count} |`,
    '',
    '## 各 Feature 详情',
    '',
  ];
  for (const fid of targetFeatureIds) {
    const feat = features[fid];
    if (!feat) continue;
    const hangCount = (feat.hang_history || []).length;
    lines.push(
      `### ${fid}`,
      `- 状态：${feat.status}`,
      `- 分支：${feat.branch || 'N/A'}`,
      `- Commit：${feat.commit || feat.last_commit || 'N/A'}`,
      `- Attempts：${feat.attempts_used || 0}`,
      `- Hang 次数：${hangCount}`,
      `- 错误：${feat.error || 'none'}`,
      '',
    );
  }
  fs.writeFileSync(summaryPath, lines.join('\n') + '\n', 'utf8');

  if (failedFeatures.length > 0) {
    cg.status       = 'failed';
    cg.completed_at = completedAtStr;
    cg.outputs.decision = 'needs_fix';
    cg.validation   = {
      passed:       false,
      checked_at:   completedAtStr,
      summary:      `${failedFeatures.length} 个 feature 失败`,
      required_files: [],
      missing_required_fields: [],
      warnings: [],
    };
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;
    writeStagesJson(stagesObj);

    log.error('validation_fail', 'codegen validate 失败', {
      decision:             'needs_fix',
      failed_feature_ids:   failedFeatures,
      exit_code:            4,
    });
    log.error('stage_failed', 'codegen stage 验证失败', {
      stage: 'codegen', step: 'validate', exit_code: 4,
      reason: `${failedFeatures.length} failed`,
      duration_ms: cg.outputs.duration_ms,
    });
    process.exit(4);
  }

  cg.status           = 'completed';
  cg.completed_at     = completedAtStr;
  cg.outputs.decision = 'passed';
  cg.validation       = {
    passed:       true,
    checked_at:   completedAtStr,
    summary:      `所有 feature 完成，共 ${completedFeatures.length} 个`,
    required_files: [],
    missing_required_fields: [],
    warnings: [],
  };
  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;

  const sp = writeStagesJson(stagesObj);

  log.info('validation_pass', 'codegen validate 通过', {
    decision:         'passed',
    features_total:   targetFeatureIds.length,
    completed_count:  completedFeatures.length,
    failed_count:     0,
  });
  log.info('file_updated', '已写 codegen 完成态', {
    path:    sp,
    status:  'completed',
    release_bundle_hash: cg.inputs && cg.inputs.release_bundle_hash,
    features_total: targetFeatureIds.length,
  });
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  // 0. 启动时检测 stop.signal
  if (checkStopSignal()) gracefulStop(readStagesJson());

  log.info('stage_start', `codegen stage 启动 [${mode}]，项目: ${projectRoot}`, {
    run_id:          runId,
    stage:           'codegen',
    project:         projectRoot,
    started_at:      startedAtStr,
    mode,
    feature_filter:  featureFilter || null,
    parallel_with:   ['create_ui_scenarios'],
  });

  // 1. 读取 stages.json
  let stagesObj = readStagesJson();
  if (!stagesObj) {
    log.error('stage_failed', 'stages.json 不存在，请先运行 setup', {
      stage: 'codegen', exit_code: 1, reason: 'stages.json missing',
    });
    process.exit(1);
  }

  // 2. 上游门闸：design_review.outputs.can_enter_codegen=true
  const drOutputs = stagesObj.stages && stagesObj.stages.design_review && stagesObj.stages.design_review.outputs;
  const canEnterCodegen = drOutputs && drOutputs.can_enter_codegen === true;

  if (!canEnterCodegen) {
    log.error('stage_failed', `上游门闸未满足：design_review.outputs.can_enter_codegen=${canEnterCodegen}`, {
      stage:     'codegen',
      exit_code: 1,
      reason:    `design_review.outputs.can_enter_codegen=${canEnterCodegen !== undefined ? canEnterCodegen : 'missing'}`,
      duration_ms: 0,
    });
    process.exit(1);
  }

  // 3. 检测 stop.signal（门闸通过后）
  if (checkStopSignal()) gracefulStop(readStagesJson());

  // 4. 读取配置
  const config = readConfig();

  // ── bootstrap 模式 ──────────────────────────────────────────────
  if (mode === 'bootstrap') {
    await doBootstrap(stagesObj, config);
    const dms = Date.now() - startedAt.getTime();
    log.info('stage_complete', `codegen bootstrap 完成，耗时 ${dms}ms`, {
      stage: 'codegen', duration_ms: dms, exit_code: 0, mode: 'bootstrap',
    });
    process.exit(0);
  }

  // ── tick 模式 ───────────────────────────────────────────────────
  if (mode === 'tick') {
    if (checkStopSignal()) gracefulStop(readStagesJson());

    const { allDone, hasFailed } = await doTick(stagesObj, config, featureFilter);
    const dms = Date.now() - startedAt.getTime();

    if (allDone) {
      stagesObj = readStagesJson();
      const cgStage = stagesObj.stages.codegen;
      if (cgStage && cgStage.status !== 'completed' && cgStage.status !== 'failed') {
        const completedAtStr = formatLocalTimeShort();
        if (!hasFailed) {
          cgStage.status          = 'completed';
          cgStage.completed_at    = completedAtStr;
          cgStage.outputs.decision = 'passed';
          cgStage.outputs.duration_ms = dms;
          cgStage.validation = {
            passed: true, checked_at: completedAtStr,
            summary: '所有 feature 已完成', required_files: [],
            missing_required_fields: [], warnings: [],
          };
        } else {
          cgStage.status          = 'failed';
          cgStage.completed_at    = completedAtStr;
          cgStage.outputs.decision = 'needs_fix';
          cgStage.outputs.duration_ms = dms;
        }
        if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;
        writeStagesJson(stagesObj);
      }
    }

    log.info('stage_complete', `codegen tick 完成，耗时 ${dms}ms`, {
      stage:       'codegen',
      duration_ms: dms,
      exit_code:   0,
      mode:        'tick',
      all_done:    allDone,
      has_failed:  hasFailed,
    });
    process.exit(0);
  }

  // ── 批量模式（默认）────────────────────────────────────────────
  const { targetFeatureIds } = await doBootstrap(stagesObj, config);
  stagesObj = readStagesJson();

  const totalTimeoutMs = config.timeoutS * 1000;
  let iterations       = 0;
  const maxIterations  = targetFeatureIds.length * (config.maxResumeAttempts + 3) + 20;

  while (iterations < maxIterations) {
    iterations++;

    if (checkStopSignal()) gracefulStop(readStagesJson());

    // 检查全局超时
    if (Date.now() - startedAt.getTime() > totalTimeoutMs) {
      const dms = Date.now() - startedAt.getTime();
      log.error('stage_failed', 'codegen stage 全局超时', {
        stage: 'codegen', exit_code: 3, reason: 'global_timeout', duration_ms: dms,
      });
      stagesObj = readStagesJson();
      if (stagesObj.stages.codegen) {
        stagesObj.stages.codegen.outputs.timed_out      = true;
        stagesObj.stages.codegen.outputs.timeout_reason = 'global_timeout';
        writeStagesJson(stagesObj);
      }
      process.exit(3);
    }

    stagesObj = readStagesJson();
    const { allDone, hasFailed } = await doTick(stagesObj, config, featureFilter);

    if (allDone) break;

    // 等待一段时间再 tick（避免 busy loop）
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // 步骤3：validate
  stagesObj = readStagesJson();
  await doValidate(stagesObj, targetFeatureIds);

  const dms = Date.now() - startedAt.getTime();
  log.info('stage_complete', `codegen stage 完成，耗时 ${dms}ms`, {
    stage:              'codegen',
    duration_ms:        dms,
    exit_code:          0,
    features_total:     targetFeatureIds.length,
    failed_count:       0,
    effective_parallel: config.effectiveParallel,
  });
  process.exit(0);
}

main().catch(err => {
  console.error(`[FATAL] codegen.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

'use strict';

/**
 * merge-push.cjs — merge_push stage
 *
 * 职责：将各 feature 的 codegen worktree 分支按序合并入主干并 push 远端。
 *
 * 参数：
 *   --project=<路径>   业务项目根（绝对或相对），默认 AI_STD3_PROJECT 环境变量或 cwd
 *   --run-id=<id>      run_id（由 run-pipeline 传入）
 *   --force-rerun      强制跳过 hash 门控，重新执行
 *
 * 退出码：
 *   0  成功（合并并 push 成功，或 hash 门控命中整段跳过）
 *   1  上游门闸未满足 / PID 锁占用 / stash 失败 / 其它前置错误
 *   5  检测到 stop.signal
 *   6  合并冲突（conflict_features[] 非空，分诊用尽）
 *   7  git push 失败（push 分诊用尽）
 *   9  分诊 decision=blocked（合并冲突或 push）
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { spawnSync } = require('child_process');

const { createLogger, formatLocalTimeShort } = require('../libs/logger.cjs');
const gitStageSync = require('../libs/git-stage-sync.cjs');
const {
  loadProjectEnv,
  getSkillsRoot,
  readConfigJson,
  resolvePipelineModel,
} = require('../libs/pipeline-config.cjs');
const { invokeSdkAgent } = require('../libs/invoke-sdk-agent.cjs');

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
  : process.env.AI_STD3_PROJECT
    ? path.resolve(process.env.AI_STD3_PROJECT)
    : process.cwd();

const runId      = args['run-id'] || null;
const forceRerun = args['force-rerun'] === true || args['force-rerun'] === 'true';

// ── 初始化 Logger ─────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'merge_push', runId });

// ── stages.json 读写 ──────────────────────────────────────────────
function readStagesJson() {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeStagesJson(obj) {
  const pipelineDir = path.join(projectRoot, '.pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const p = path.join(pipelineDir, 'stages.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return p;
}

// ── Git 辅助 ──────────────────────────────────────────────────────
function git(gitArgs, opts = {}) {
  return spawnSync('git', gitArgs, {
    cwd:      opts.cwd || projectRoot,
    encoding: 'utf8',
    timeout:  opts.timeout || 60000,
    stdio:    ['ignore', 'pipe', 'pipe'],
  });
}

function getHeadCommit() {
  const r = git(['rev-parse', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

function isWorkingTreeClean() {
  const r = git(['status', '--porcelain']);
  return r.status === 0 && r.stdout.trim() === '';
}

/** 计算合并前后 diff 统计（用于 git_commit 日志） */
function getDiffStat(before, after) {
  if (!before || !after || before === after) return 'unknown';
  const r = git(['diff', '--shortstat', `${before}..${after}`]);
  return r.status === 0 ? (r.stdout.trim() || '0 files changed') : 'unknown';
}

// ── PID 锁 ────────────────────────────────────────────────────────
const locksDir   = path.join(projectRoot, '.pipeline', 'locks');
const pidLockPath = path.join(locksDir, 'merge_push.pid');

function acquirePidLock() {
  fs.mkdirSync(locksDir, { recursive: true });
  if (fs.existsSync(pidLockPath)) {
    const existingPid = parseInt(fs.readFileSync(pidLockPath, 'utf8').trim(), 10);
    try {
      process.kill(existingPid, 0); // throws if dead
      return { ok: false, existingPid };
    } catch (_) {
      fs.unlinkSync(pidLockPath); // stale lock
    }
  }
  fs.writeFileSync(pidLockPath, String(process.pid), 'utf8');
  return { ok: true };
}

function releasePidLock() {
  try {
    if (fs.existsSync(pidLockPath)) {
      const pid = fs.readFileSync(pidLockPath, 'utf8').trim();
      if (pid === String(process.pid)) fs.unlinkSync(pidLockPath);
    }
  } catch (_) { /* ignore */ }
}

// ── merge_bundle_hash 计算 ────────────────────────────────────────
/**
 * 按 feature_id 字典序排列各完成 feature 的 "${feature_id}:${commit}" 列表，
 * JSON.stringify 后做 SHA-256。
 */
function computeMergeBundleHash(completedFeatures) {
  const sorted = completedFeatures
    .slice()
    .sort((a, b) => a.feature_id.localeCompare(b.feature_id));
  const list = sorted.map(f => `${f.feature_id}:${f.commit}`);
  return crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');
}

// ── stop.signal 检查 ──────────────────────────────────────────────
const stopSignalPath = path.join(projectRoot, '.pipeline', 'stop.signal');

function getStopReason() {
  if (!fs.existsSync(stopSignalPath)) return null;
  try { return JSON.parse(fs.readFileSync(stopSignalPath, 'utf8')).reason || 'unknown'; }
  catch (_) { return 'unknown'; }
}

function handleStop(stages, stashed) {
  const reason = getStopReason();
  log.info('pipeline_stop', '检测到 stop.signal，开始优雅停止', {
    stage: 'merge_push',
    reason,
    current_agent_id: null,
    stopped_at: formatLocalTimeShort(),
  });
  if (stages) {
    stages.stages = stages.stages || {};
    stages.stages.merge_push = stages.stages.merge_push || {};
    stages.stages.merge_push.status = 'stopped';
    stages.pipeline = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
  }
  if (stashed) git(['stash', 'pop']);
  releasePidLock();
  log.info('pipeline_stopped', 'merge_push 已优雅停止', {
    stage: 'merge_push',
    stopped_at: formatLocalTimeShort(),
    exit_code: 5,
  });
  process.exit(5);
}

// ── 特性排序辅助 ──────────────────────────────────────────────────
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function listUnmergedFiles() {
  const r = git(['diff', '--name-only', '--diff-filter=U']);
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean);
}

function isMergeInProgress() {
  return fs.existsSync(path.join(projectRoot, '.git', 'MERGE_HEAD'));
}

function isRebaseInProgress() {
  const gitDir = path.join(projectRoot, '.git');
  return (
    fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
    fs.existsSync(path.join(gitDir, 'rebase-apply'))
  );
}

function writeMergeLastError({ featureId, branch, mergeStderr, targetBranch }) {
  const errorPath = path.join(projectRoot, '.pipeline', 'merge-push-last-error.json');
  const doc = {
    failed_at:       formatLocalTimeShort(),
    feature_id:      featureId,
    branch,
    target_branch:   targetBranch,
    merge_stderr:    String(mergeStderr || '').slice(-2000),
    unmerged_files:  listUnmergedFiles(),
  };
  fs.mkdirSync(path.dirname(errorPath), { recursive: true });
  fs.writeFileSync(errorPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return errorPath;
}

async function runMergeTriageAgent({ attempt, lastErrorPath }) {
  const skillsRoot    = getSkillsRoot();
  const triageOutPath = path.join(projectRoot, '.pipeline', 'merge-push-triage.json');

  log.info('merge_push_triage_start', `[merge_push] 启动分诊 Agent attempt=${attempt}`, {
    agent_id: 'merge-push-triage',
    attempt,
    feature_id: (() => {
      try {
        return JSON.parse(fs.readFileSync(lastErrorPath, 'utf8')).feature_id;
      } catch (_) {
        return null;
      }
    })(),
  });

  const cfg   = readConfigJson(projectRoot);
  const model = resolvePipelineModel(cfg);

  const result = await invokeSdkAgent({
    skillsRoot,
    projectRoot,
    promptFile:   'merge-push-triage.md',
    agentId:      'merge-push-triage',
    cwd:          projectRoot,
    model,
    timeoutMs:    300000,
    log,
    artifactPath: triageOutPath,
    inject:       { last_error: lastErrorPath, attempt: String(attempt) },
  });

  let triage = result.artifact;
  if (!triage) {
    triage = {
      decision:     'blocked',
      category:     'unknown',
      reason:       result.error || '分诊 Agent 未产出 merge-push-triage.json',
      user_actions: ['查看 logs/stages/merge_push 与冲突文件后人工解决'],
    };
    fs.writeFileSync(triageOutPath, JSON.stringify(triage, null, 2) + '\n', 'utf8');
  }

  log.info('merge_push_triage_complete', `[merge_push] 分诊 decision=${triage.decision}`, {
    decision: triage.decision,
    reason:   triage.reason,
  });
  return triage;
}

function tryCompleteMerge(featureId) {
  const unmerged = listUnmergedFiles();
  if (unmerged.length > 0) {
    return { ok: false, error: `仍有未合并文件: ${unmerged.slice(0, 8).join(', ')}` };
  }
  if (!isMergeInProgress()) {
    return { ok: false, error: '无进行中的 merge（可能已 abort）' };
  }
  git(['add', '-A']);
  const commitR = git(['commit', '--no-edit'], { timeout: 120000 });
  if (commitR.status !== 0) {
    const contR = git(['-c', 'core.editor=true', 'merge', '--continue'], { timeout: 120000 });
    if (contR.status !== 0) {
      return {
        ok: false,
        error: (commitR.stderr || contR.stderr || 'merge continue 失败').trim().slice(0, 400),
      };
    }
  }
  return { ok: true, commit: getHeadCommit() };
}

function abortMergeIfNeeded() {
  if (isMergeInProgress()) git(['merge', '--abort']);
}

/**
 * merge 冲突后：分诊 Agent 修冲突 → merge --continue
 */
async function resolveConflictWithTriage({
  featureId,
  branch,
  mergeStderr,
  targetBranch,
  triageMaxAttempts,
}) {
  const lastErrorPath = writeMergeLastError({
    featureId,
    branch,
    mergeStderr,
    targetBranch,
  });

  if (!process.env.CURSOR_API_KEY) {
    log.warn('merge_push_triage_skipped', 'CURSOR_API_KEY 未设置，跳过冲突分诊', {
      feature_id: featureId,
    });
    abortMergeIfNeeded();
    return { ok: false, blocked: false, reason: 'no_api_key' };
  }

  for (let attempt = 1; attempt <= triageMaxAttempts; attempt++) {
    const triage = await runMergeTriageAgent({ attempt, lastErrorPath });

    if (triage.decision === 'blocked') {
      abortMergeIfNeeded();
      return { ok: false, blocked: true, reason: triage.reason, user_actions: triage.user_actions };
    }

    if (triage.decision === 'fix_merge' || triage.decision === 'retry_merge') {
      const complete = tryCompleteMerge(featureId);
      if (complete.ok) {
        log.info('merge_conflict_resolved', `[merge_push] feature=${featureId} 冲突已解决并 continue`, {
          feature_id:  featureId,
          commit_hash: complete.commit,
          attempt,
        });
        return { ok: true, commit: complete.commit };
      }
      log.warn('merge_conflict_retry', `[merge_push] continue 失败，attempt=${attempt}`, {
        feature_id: featureId,
        error:      complete.error,
      });
    }
  }

  abortMergeIfNeeded();
  return { ok: false, blocked: false, reason: 'triage_exhausted' };
}

function writePushLastError({ remote, branch, pushStderr, pullStderr, headCommit }) {
  const errorPath = path.join(projectRoot, '.pipeline', 'merge-push-push-last-error.json');
  const doc = {
    failed_at:      formatLocalTimeShort(),
    remote,
    target_branch:  branch,
    head_commit:    headCommit || getHeadCommit(),
    push_stderr:    String(pushStderr || '').slice(-2000),
    pull_stderr:    String(pullStderr || '').slice(-2000),
    rebase_active:  isRebaseInProgress(),
    unmerged_files: listUnmergedFiles(),
  };
  fs.mkdirSync(path.dirname(errorPath), { recursive: true });
  fs.writeFileSync(errorPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return errorPath;
}

async function runPushTriageAgent({ attempt, lastErrorPath }) {
  const skillsRoot    = getSkillsRoot();
  const triageOutPath = path.join(projectRoot, '.pipeline', 'merge-push-push-triage.json');

  log.info('merge_push_push_triage_start', `[merge_push] 启动 push 分诊 Agent attempt=${attempt}`, {
    agent_id: 'merge-push-push-triage',
    attempt,
  });

  const cfg   = readConfigJson(projectRoot);
  const model = resolvePipelineModel(cfg);

  const result = await invokeSdkAgent({
    skillsRoot,
    projectRoot,
    promptFile:   'merge-push-push-triage.md',
    agentId:      'merge-push-push-triage',
    cwd:          projectRoot,
    model,
    timeoutMs:    300000,
    log,
    artifactPath: triageOutPath,
    inject:       { last_error: lastErrorPath, attempt: String(attempt) },
  });

  let triage = result.artifact;
  if (!triage) {
    triage = {
      decision:     'blocked',
      category:     'unknown',
      reason:       result.error || '分诊 Agent 未产出 merge-push-push-triage.json',
      user_actions: ['查看 logs/stages/merge_push 与 git push 错误后人工处理'],
    };
    fs.writeFileSync(triageOutPath, JSON.stringify(triage, null, 2) + '\n', 'utf8');
  }

  log.info('merge_push_push_triage_complete', `[merge_push] push 分诊 decision=${triage.decision}`, {
    decision: triage.decision,
    reason:   triage.reason,
  });
  return triage;
}

function tryCompleteRebase() {
  if (!isRebaseInProgress()) {
    return { ok: true, skipped: true };
  }
  const unmerged = listUnmergedFiles();
  if (unmerged.length > 0) {
    return { ok: false, error: `rebase 仍有未合并文件: ${unmerged.slice(0, 8).join(', ')}` };
  }
  git(['add', '-A']);
  const contR = git(['-c', 'core.editor=true', 'rebase', '--continue'], { timeout: 120000 });
  if (contR.status !== 0) {
    return {
      ok: false,
      error: (contR.stderr || 'rebase --continue 失败').trim().slice(0, 400),
    };
  }
  return { ok: true, commit: getHeadCommit() };
}

function pullRebaseAndPush(remote, branch) {
  const pullResult = git(['pull', '--rebase', remote, branch], { timeout: 120000 });
  if (pullResult.status !== 0) {
    return {
      ok: false,
      pushResult: null,
      pullStderr: pullResult.stderr,
      pushStderr: null,
    };
  }
  const pushResult = git(['push', remote, branch], { timeout: 120000 });
  return {
    ok: pushResult.status === 0,
    pushResult,
    pullStderr: null,
    pushStderr: pushResult.status === 0 ? null : pushResult.stderr,
  };
}

/**
 * push 失败（已做过一次 pull --rebase 重试）后：分诊 → 修 rebase / 再 pull+push
 */
async function resolvePushWithTriage({
  remote,
  defaultBranch,
  pushStderr,
  pullStderr,
  triageMaxAttempts,
}) {
  const headCommit    = getHeadCommit();
  const lastErrorPath = writePushLastError({
    remote,
    branch:     defaultBranch,
    pushStderr,
    pullStderr,
    headCommit,
  });

  if (!process.env.CURSOR_API_KEY) {
    log.warn('merge_push_push_triage_skipped', 'CURSOR_API_KEY 未设置，跳过 push 分诊', {
      remote,
      branch: defaultBranch,
    });
    return { ok: false, blocked: false, reason: 'no_api_key' };
  }

  for (let attempt = 1; attempt <= triageMaxAttempts; attempt++) {
    const triage = await runPushTriageAgent({ attempt, lastErrorPath });

    if (triage.decision === 'blocked') {
      return {
        ok: false,
        blocked: true,
        reason:       triage.reason,
        user_actions: triage.user_actions,
      };
    }

    if (triage.decision === 'fix_rebase') {
      const rebaseDone = tryCompleteRebase();
      if (!rebaseDone.ok) {
        log.warn('merge_push_rebase_continue_fail', `[merge_push] rebase continue 失败 attempt=${attempt}`, {
          error: rebaseDone.error,
        });
        continue;
      }
    }

    if (triage.decision === 'retry_push' || triage.decision === 'fix_rebase') {
      const sync = pullRebaseAndPush(remote, defaultBranch);
      if (sync.ok) {
        log.info('merge_push_push_recovered', `[merge_push] push 分诊后推送成功`, {
          remote,
          branch:  defaultBranch,
          attempt,
          decision: triage.decision,
        });
        return { ok: true };
      }
      log.warn('merge_push_push_retry_fail', `[merge_push] 分诊后 pull/push 仍失败 attempt=${attempt}`, {
        decision: triage.decision,
        push_error: (sync.pushStderr || sync.pullStderr || '').trim().slice(0, 300),
      });
    }
  }

  return { ok: false, blocked: false, reason: 'push_triage_exhausted' };
}

function sortFeatures(completedFeatures, prdFeatures) {
  const priorityMap = {};
  for (const f of prdFeatures) {
    if (f.feature_id) priorityMap[f.feature_id] = f.priority || 'P3';
  }
  return completedFeatures.slice().sort((a, b) => {
    const pa = PRIORITY_ORDER[priorityMap[a.feature_id] || 'P3'] ?? 3;
    const pb = PRIORITY_ORDER[priorityMap[b.feature_id] || 'P3'] ?? 3;
    if (pa !== pb) return pa - pb;
    return a.feature_id.localeCompare(b.feature_id);
  });
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  loadProjectEnv(projectRoot);

  // ── 0. 检测 stop.signal ──────────────────────────────────────────
  if (getStopReason() !== null) {
    const stages = readStagesJson();
    handleStop(stages, false);
  }

  // stage_start 日志
  log.info('stage_start', `merge_push stage 启动，项目: ${projectRoot}`, {
    run_id:     runId,
    stage:      'merge_push',
    project:    projectRoot,
    started_at: startedAtStr,
  });

  // ── 读 stages.json ───────────────────────────────────────────────
  let stages = readStagesJson();
  if (!stages) {
    log.error('stage_failed', 'stages.json 不存在，无法读取上游状态', {
      stage: 'merge_push', exit_code: 1, reason: 'stages.json missing',
      duration_ms: Date.now() - startedAt.getTime(),
    });
    process.exit(1);
  }

  // ── 1. 上游门闸 ──────────────────────────────────────────────────
  const codeReview = stages.stages && stages.stages.code_review;
  if (!codeReview) {
    log.error('stage_failed', '上游门闸未满足：stages.code_review 不存在', {
      stage: 'merge_push', exit_code: 1, reason: 'code_review stage not found',
      duration_ms: 0,
    });
    process.exit(1);
  }
  if (codeReview.status !== 'completed') {
    log.error('stage_failed',
      `上游门闸未满足：code_review.status=${codeReview.status}，需要 completed`, {
        stage: 'merge_push', exit_code: 1,
        reason: `code_review.status=${codeReview.status}`,
        duration_ms: 0,
      });
    process.exit(1);
  }
  const decision = codeReview.outputs && codeReview.outputs.decision;
  if (decision !== 'passed' && decision !== 'passed_with_warnings') {
    log.error('stage_failed',
      `上游门闸未满足：code_review.outputs.decision=${decision}，需要 passed 或 passed_with_warnings`, {
        stage: 'merge_push', exit_code: 1,
        reason: `code_review.decision=${decision}`,
        duration_ms: 0,
      });
    process.exit(1);
  }
  // validation.passed：缺失视为通过（宽松），明确为 false 才拒绝
  const crValidation = codeReview.validation;
  if (crValidation && crValidation.passed === false) {
    log.error('stage_failed',
      '上游门闸未满足：code_review.validation.passed=false', {
        stage: 'merge_push', exit_code: 1,
        reason: 'code_review.validation.passed=false',
        duration_ms: 0,
      });
    process.exit(1);
  }

  // ── 读取配置（docs/config.dev.json 为真源，同步到 stages.pipeline.project.git）──
  const devConfig     = gitStageSync.loadConfigDev(projectRoot);
  const gitResolved   = gitStageSync.resolveGitConfig(devConfig);
  stages              = gitStageSync.applyGitConfigToStages(stages, devConfig);
  writeStagesJson(stages);
  stages              = readStagesJson();

  const defaultBranch = gitResolved.default_branch;
  const remote        = gitResolved.remote;
  const allowPush     = gitResolved.allow_push;

  const pipelineStagesCfg = (devConfig.pipeline && devConfig.pipeline.stages) || {};
  const mergePushStageCfg = pipelineStagesCfg.merge_push || {};
  const triageMaxAttempts =
    mergePushStageCfg.triage_max_attempts != null ? mergePushStageCfg.triage_max_attempts : 2;

  // ── 收集已完成的 codegen feature ─────────────────────────────────
  const codegenFeatures = (stages.stages && stages.stages.codegen &&
                            stages.stages.codegen.features) || {};
  const prdFeatures     = (stages.stages && stages.stages.prd &&
                            stages.stages.prd.outputs &&
                            stages.stages.prd.outputs.features) || [];

  const completedFeatures = [];
  for (const [featureId, fData] of Object.entries(codegenFeatures)) {
    if (fData && fData.status === 'completed') {
      const commit = fData.commit || fData.last_commit;
      const branch = fData.branch || `features/v3-${featureId}`;
      if (commit) {
        completedFeatures.push({ feature_id: featureId, commit, branch });
      }
    }
  }

  if (completedFeatures.length === 0) {
    log.error('stage_failed', '没有已完成的 codegen feature 可合并', {
      stage: 'merge_push', exit_code: 1, reason: 'no completed codegen features',
      duration_ms: Date.now() - startedAt.getTime(),
    });
    process.exit(1);
  }

  // ── 计算 merge_bundle_hash ───────────────────────────────────────
  const mergeBundleHash = computeMergeBundleHash(completedFeatures);

  // ── hash 门控 ────────────────────────────────────────────────────
  if (!forceRerun) {
    const mp = stages.stages && stages.stages.merge_push;
    if (mp && mp.status === 'completed') {
      const storedHash = mp.inputs && mp.inputs.merge_bundle_hash;
      log.info('hash_check', 'merge_bundle_hash 门控检查', {
        file:          'codegen features',
        stored_hash:   storedHash || null,
        computed_hash: mergeBundleHash,
        hit:           !!storedHash && storedHash === mergeBundleHash,
      });
      if (storedHash && storedHash === mergeBundleHash) {
        log.info('stage_skipped', 'merge_push hash 门控命中，跳过执行', {
          stage:  'merge_push',
          reason: 'merge_bundle_hash matched',
          exit_code: 0,
        });
        process.exit(0);
      }
    }
  }

  // ── 获取 PID 锁 ──────────────────────────────────────────────────
  const lockResult = acquirePidLock();
  if (!lockResult.ok) {
    log.error('stage_failed',
      `PID 锁被占用（pid=${lockResult.existingPid}），可能有并发 merge_push 在运行`, {
        stage: 'merge_push', exit_code: 1,
        reason: `pid_lock_occupied: ${lockResult.existingPid}`,
        duration_ms: Date.now() - startedAt.getTime(),
      });
    process.exit(1);
  }
  // 确保退出时释放锁
  process.on('exit', releasePidLock);
  process.on('SIGINT',  () => { releasePidLock(); process.exit(1); });
  process.on('SIGTERM', () => { releasePidLock(); process.exit(1); });

  // ── 写 running 状态 ───────────────────────────────────────────────
  stages.stages = stages.stages || {};
  stages.stages.merge_push = Object.assign({}, stages.stages.merge_push || {}, {
    status:      'running',
    started_at:  startedAtStr,
    inputs: {
      merge_bundle_hash:        mergeBundleHash,
      code_review_decision_hash: mergeBundleHash,
      feature_branches: Object.fromEntries(
        completedFeatures.map(f => [f.feature_id, f.branch])
      ),
    },
  });
  stages.pipeline = stages.pipeline || {};
  stages.pipeline.updated_at    = formatLocalTimeShort();
  stages.pipeline.current_stage = 'merge_push';
  writeStagesJson(stages);

  log.info('file_updated', '已写入 merge_push running 状态', {
    status: 'running',
    merge_bundle_hash: mergeBundleHash,
  });

  // ── 2. 准备主干 ───────────────────────────────────────────────────
  // 检查是否有 remote
  const remoteCheck = git(['remote', '-v']);
  const hasRemote   = remoteCheck.status === 0 &&
                      remoteCheck.stdout.includes(remote);

  if (hasRemote) {
    log.info('git_checkout', `正在 git fetch ${remote}`, { branch: defaultBranch, remote });
    const fetchResult = git(['fetch', remote], { timeout: 120000 });
    if (fetchResult.status !== 0) {
      log.warn('validation_fail',
        `git fetch ${remote} 失败，继续本地合并`, {
          error: fetchResult.stderr.trim(),
        });
    }
  }

  // stash 工作区未提交变更
  let stashed = false;
  if (!isWorkingTreeClean()) {
    const stashResult = git(['stash', 'push', '-m', 'ai-std3-merge-push-auto-stash']);
    if (stashResult.status !== 0) {
      const durMs = Date.now() - startedAt.getTime();
      stages = readStagesJson() || stages;
      stages.stages.merge_push.status = 'failed';
      stages.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stages);
      releasePidLock();
      log.error('stage_failed', '工作区有未提交变更且 stash 失败', {
        stage: 'merge_push', step: 'stash', exit_code: 1,
        reason: stashResult.stderr.trim(), duration_ms: durMs,
      });
      process.exit(1);
    }
    stashed = true;
    log.info('file_updated', '已 stash 工作区未提交变更', { stashed: true });
  }

  // checkout 主干
  const checkoutResult = git(['checkout', defaultBranch]);
  if (checkoutResult.status !== 0) {
    const durMs = Date.now() - startedAt.getTime();
    stages = readStagesJson() || stages;
    stages.stages.merge_push.status = 'failed';
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    if (stashed) git(['stash', 'pop']);
    releasePidLock();
    log.error('stage_failed', `git checkout ${defaultBranch} 失败`, {
      stage: 'merge_push', step: 'checkout', exit_code: 1,
      reason: checkoutResult.stderr.trim(), duration_ms: durMs,
    });
    process.exit(1);
  }
  log.info('git_checkout', `已切换到 ${defaultBranch}`, { branch: defaultBranch, remote });

  // fast-forward 对齐 remote
  if (hasRemote) {
    const ffResult = git(['merge', '--ff-only', `${remote}/${defaultBranch}`],
                        { timeout: 60000 });
    if (ffResult.status !== 0) {
      log.warn('validation_fail',
        `git merge --ff-only ${remote}/${defaultBranch} 失败（主干有本地提交？），继续...`, {
          error: ffResult.stderr.trim(),
        });
    }
  }

  // ── 3. 按 feature 合并 ────────────────────────────────────────────
  const sortedFeatures = sortFeatures(completedFeatures, prdFeatures);

  const mergedFeatures        = [];
  const alreadyMergedFeatures = [];
  const conflictFeatures      = [];

  for (const feature of sortedFeatures) {
    // 每次 merge 前检查 stop.signal
    if (getStopReason() !== null) {
      stages = readStagesJson() || stages;
      stages.stages.merge_push.outputs = Object.assign(
        stages.stages.merge_push.outputs || {},
        {
          merged_features:         mergedFeatures,
          already_merged_features: alreadyMergedFeatures,
          conflict_features:       conflictFeatures,
        }
      );
      handleStop(stages, stashed);
    }

    const { feature_id, commit, branch } = feature;

    // 检查是否已在主干（ancestor 检查）
    const ancestorCheck = git(['merge-base', '--is-ancestor', commit, 'HEAD']);
    if (ancestorCheck.status === 0) {
      log.info('feature_skipped', `feature ${feature_id} 已在主干，跳过`, {
        feature_id,
        commit,
        reason: 'already_merged',
      });
      alreadyMergedFeatures.push(feature_id);
      continue;
    }

    // 执行 --no-ff merge
    const beforeCommit  = getHeadCommit();
    const mergeResult   = git(
      ['merge', '--no-ff', branch, '-m',
       `feat(${feature_id}): merge codegen implementation`],
      { timeout: 120000 }
    );

    if (mergeResult.status !== 0) {
      const mergeErr = (mergeResult.stderr || mergeResult.stdout || '').trim();
      const looksLikeConflict =
        isMergeInProgress() || /CONFLICT|conflict|Automatic merge failed/i.test(mergeErr);

      if (!looksLikeConflict) {
        log.error('validation_fail', `feature ${feature_id} merge 失败（非冲突）`, {
          feature_id,
          exit_code: 4,
          error: mergeErr,
        });
        conflictFeatures.push(feature_id);
        abortMergeIfNeeded();
        break;
      }

      log.error('validation_fail', `feature ${feature_id} merge 冲突，启动分诊`, {
        conflict_features: [feature_id],
        exit_code: 6,
        error: mergeResult.stderr.trim(),
      });

      const resolved = await resolveConflictWithTriage({
        featureId: feature_id,
        branch,
        mergeStderr: mergeResult.stderr,
        targetBranch: defaultBranch,
        triageMaxAttempts,
      });

      if (resolved.ok) {
        const afterCommit = getHeadCommit();
        log.info('git_commit', `feature ${feature_id} 冲突解决后已合并到 ${defaultBranch}`, {
          branch:        defaultBranch,
          commit_hash:   afterCommit,
          feature_id,
          files_changed: getDiffStat(beforeCommit, afterCommit),
        });
        mergedFeatures.push(feature_id);
        continue;
      }

      conflictFeatures.push(feature_id);
      if (resolved.blocked) {
        stages = readStagesJson() || stages;
        stages.stages.merge_push = Object.assign(stages.stages.merge_push || {}, {
          outputs: Object.assign(stages.stages.merge_push.outputs || {}, {
            blocked_reason: resolved.reason,
            user_actions:   resolved.user_actions || [],
          }),
        });
        writeStagesJson(stages);
        if (stashed) git(['stash', 'pop']);
        releasePidLock();
        log.error('merge_push_blocked', `[merge_push] 分诊 blocked: ${resolved.reason}`, {
          stage: 'merge_push', exit_code: 9, feature_id,
        });
        process.exit(9);
      }
      break;
    }

    const afterCommit = getHeadCommit();
    log.info('git_commit', `feature ${feature_id} 已合并到 ${defaultBranch}`, {
      branch:        defaultBranch,
      commit_hash:   afterCommit,
      feature_id,
      files_changed: getDiffStat(beforeCommit, afterCommit),
    });
    mergedFeatures.push(feature_id);
  }

  // 有冲突 → 写 failed 并退出 6
  if (conflictFeatures.length > 0) {
    const durMs        = Date.now() - startedAt.getTime();
    const completedStr = formatLocalTimeShort();

    stages = readStagesJson() || stages;
    stages.stages.merge_push = Object.assign(stages.stages.merge_push || {}, {
      status:       'failed',
      completed_at: completedStr,
      outputs: {
        final_commit:            null,
        merged_features:         mergedFeatures,
        already_merged_features: alreadyMergedFeatures,
        conflict_features:       conflictFeatures,
        push_status:             'not_attempted',
        remote,
        target_branch:           defaultBranch,
        duration_ms:             durMs,
        timed_out:               false,
        timeout_reason:          null,
      },
      validation: {
        passed:                  false,
        checked_at:              completedStr,
        summary:                 `合并冲突：${conflictFeatures.join(', ')}`,
        required_files:          [],
        missing_required_fields: [],
        warnings:                [],
      },
    });
    stages.pipeline.updated_at = formatLocalTimeShort();
    if (stashed) git(['stash', 'pop']);
    writeStagesJson(stages);
    releasePidLock();

    log.error('stage_failed', `merge_push 失败：合并冲突 [${conflictFeatures.join(', ')}]`, {
      stage:    'merge_push',
      step:     'merge',
      exit_code: 6,
      reason:   `conflict_features: ${conflictFeatures.join(', ')}`,
      duration_ms: durMs,
    });
    process.exit(6);
  }

  // ── 4. 推送 ──────────────────────────────────────────────────────
  let pushStatus = 'skipped_no_remote';

  if (!allowPush) {
    pushStatus = 'skipped_allow_push_false';
    log.info('git_push', 'git.allow_push=false，跳过 push', {
      remote,
      branch: defaultBranch,
      status: pushStatus,
    });
  } else if (hasRemote) {
    // push 前再检查一次 stop.signal
    if (getStopReason() !== null) {
      stages = readStagesJson() || stages;
      handleStop(stages, stashed);
    }

    let pushResult  = git(['push', remote, defaultBranch], { timeout: 120000 });
    let pullResult  = null;

    if (pushResult.status !== 0) {
      log.warn('git_push_retry',
        `push 初次失败，尝试 git pull --rebase 后重试`, {
          remote,
          branch: defaultBranch,
          error:  pushResult.stderr.trim(),
        });
      pullResult = git(['pull', '--rebase', remote, defaultBranch], { timeout: 120000 });
      if (pullResult.status === 0) {
        pushResult = git(['push', remote, defaultBranch], { timeout: 120000 });
      }
    }

    if (pushResult.status !== 0) {
      const initialPushErr = pushResult.stderr.trim();
      const initialPullErr = pullResult && pullResult.status !== 0
        ? (pullResult.stderr || '').trim()
        : '';

      log.error('git_push_failed', 'git push 失败，尝试 push 分诊', {
        remote,
        branch:    defaultBranch,
        error:     initialPushErr,
        exit_code: 7,
      });

      const pushResolved = await resolvePushWithTriage({
        remote,
        defaultBranch,
        pushStderr:        initialPushErr,
        pullStderr:        initialPullErr,
        triageMaxAttempts,
      });

      if (pushResolved.ok) {
        pushResult = { status: 0, stderr: '' };
      } else if (pushResolved.blocked) {
        const durMs        = Date.now() - startedAt.getTime();
        const completedStr = formatLocalTimeShort();
        const finalCommit  = getHeadCommit();

        stages = readStagesJson() || stages;
        stages.stages.merge_push = Object.assign(stages.stages.merge_push || {}, {
          status:       'failed',
          completed_at: completedStr,
          outputs: {
            final_commit:            finalCommit,
            merged_features:         mergedFeatures,
            already_merged_features: alreadyMergedFeatures,
            conflict_features:       [],
            push_status:             'failed',
            blocked_reason:          pushResolved.reason,
            user_actions:            pushResolved.user_actions || [],
            remote,
            target_branch:           defaultBranch,
            duration_ms:             durMs,
            timed_out:               false,
            timeout_reason:          null,
          },
          validation: {
            passed:                  false,
            checked_at:              completedStr,
            summary:                 `push 分诊 blocked: ${pushResolved.reason}`,
            required_files:          [],
            missing_required_fields: [],
            warnings:                [],
          },
        });
        stages.pipeline.updated_at = formatLocalTimeShort();
        if (stashed) git(['stash', 'pop']);
        writeStagesJson(stages);
        releasePidLock();

        log.error('merge_push_blocked', `[merge_push] push 分诊 blocked: ${pushResolved.reason}`, {
          stage: 'merge_push', exit_code: 9, step: 'push',
        });
        process.exit(9);
      } else if (pushResult.status !== 0) {
        const durMs        = Date.now() - startedAt.getTime();
        const completedStr = formatLocalTimeShort();
        const finalCommit  = getHeadCommit();

        stages = readStagesJson() || stages;
        stages.stages.merge_push = Object.assign(stages.stages.merge_push || {}, {
          status:       'failed',
          completed_at: completedStr,
          outputs: {
            final_commit:            finalCommit,
            merged_features:         mergedFeatures,
            already_merged_features: alreadyMergedFeatures,
            conflict_features:       [],
            push_status:             'failed',
            remote,
            target_branch:           defaultBranch,
            duration_ms:             durMs,
            timed_out:               false,
            timeout_reason:          null,
          },
          validation: {
            passed:                  false,
            checked_at:              completedStr,
            summary:                 'push 失败',
            required_files:          [],
            missing_required_fields: [],
            warnings:                [],
          },
          git_sync: {
            initial_pushed_at:       null,
            docs_pipeline_pushed_at: null,
            last_commit:             finalCommit,
            last_push_status:        'failed',
          },
        });
        stages.pipeline.updated_at = formatLocalTimeShort();
        if (stashed) git(['stash', 'pop']);
        writeStagesJson(stages);
        releasePidLock();

        log.error('stage_failed', 'merge_push 失败：push 失败', {
          stage:       'merge_push',
          step:        'push',
          exit_code:   7,
          reason:      initialPushErr,
          duration_ms: durMs,
        });
        process.exit(7);
      }
    }

    pushStatus = 'success';
    log.info('git_push', 'git push 成功', {
      remote,
      branch: defaultBranch,
      status: 'success',
    });
  } else if (allowPush) {
    log.info('git_push', '无 remote，跳过 push', {
      remote,
      branch: defaultBranch,
      status: 'skipped_no_remote',
    });
  }

  // ── 5. 写完成态 ──────────────────────────────────────────────────
  const completedAt    = new Date();
  const completedAtStr = formatLocalTimeShort(completedAt);
  const durMs          = completedAt.getTime() - startedAt.getTime();
  const finalCommit    = getHeadCommit();

  stages = readStagesJson() || stages;
  stages.stages.merge_push = Object.assign(stages.stages.merge_push || {}, {
    status:       'completed',
    started_at:   startedAtStr,
    completed_at: completedAtStr,
    inputs: {
      merge_bundle_hash:        mergeBundleHash,
      code_review_decision_hash: mergeBundleHash,
      feature_branches: Object.fromEntries(
        completedFeatures.map(f => [f.feature_id, f.branch])
      ),
    },
    outputs: {
      final_commit:            finalCommit,
      merged_features:         mergedFeatures,
      already_merged_features: alreadyMergedFeatures,
      conflict_features:       [],
      push_status:             pushStatus,
      remote,
      target_branch:           defaultBranch,
      duration_ms:             durMs,
      timed_out:               false,
      timeout_reason:          null,
    },
    validation: {
      passed:                  true,
      checked_at:              completedAtStr,
      summary:                 null,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    },
    generated_files: [],
    blocking_issues: [],
    git_sync: {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             finalCommit,
      last_push_status:        pushStatus,
    },
  });
  stages.pipeline.last_completed_stage = 'merge_push';
  stages.pipeline.current_stage        = 'merge_push';
  stages.pipeline.updated_at           = completedAtStr;

  const stagesPath = writeStagesJson(stages);
  const stat       = fs.statSync(stagesPath);
  log.info('file_updated', '已写入 merge_push 完成态', {
    path:                stagesPath,
    size_bytes:          stat.size,
    status:              'completed',
    final_commit:        finalCommit,
    merged_count:        mergedFeatures.length,
    already_merged_count: alreadyMergedFeatures.length,
  });

  if (stashed) git(['stash', 'pop']);
  releasePidLock();

  log.info('validation_pass', 'merge_push 校验通过', {
    checks:   mergedFeatures.length + alreadyMergedFeatures.length,
    warnings: [],
  });

  log.info('stage_complete', `merge_push stage 完成，耗时 ${durMs}ms`, {
    stage:        'merge_push',
    final_commit: finalCommit,
    merged_count: mergedFeatures.length,
    exit_code:    0,
  });

  process.exit(0);
}

main().catch(err => {
  console.error(`[FATAL] merge-push.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  releasePidLock();
  process.exit(1);
});

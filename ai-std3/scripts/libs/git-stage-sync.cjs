'use strict';

/**
 * 将 docs/config.dev.json → git.* 同步到 stages，并在 stage 完成时按配置 commit/push。
 * commit 门闸：git.auto_commit === true
 * push 门闸：git.allow_push === true 且已配置 remote
 */

const path = require('path');
const gitSync = require('../../../ai-auto3/scripts/lib/git-pipeline-sync.cjs');

/** ai-std3 stage 名 → git-pipeline-sync phaseKey */
const STAGE_PHASE_MAP = {
  prd:            'prd_complete',
  'prd-review':   'prd_review',
  prd_review:     'prd_review',
  design:         'design',
  'design-review': 'design_review',
  design_review:  'design_review',
  codegen:        'codegen',
  'code-review':  'code_review',
  code_review:    'code_review',
  merge_push:     'merge_push',
  setup:          null,
};

function loadConfigDev(projectRoot) {
  return gitSync.loadConfigDev(projectRoot);
}

/**
 * @param {object} config docs/config.dev.json
 * @returns {{ remote: string, default_branch: string, remote_url: string|null, auto_commit: boolean, allow_push: boolean }}
 */
function resolveGitConfig(config = {}) {
  const g = config.git || {};
  const remoteUrl = String(g.remote_url || g.repo_url || '').trim() || null;
  return {
    remote:         g.remote || 'origin',
    default_branch: g.default_branch || 'main',
    remote_url:     remoteUrl,
    auto_commit:    g.auto_commit === true,
    allow_push:     g.allow_push === true,
  };
}

/**
 * 把 config.dev.json 的 git 段写入 stages.pipeline.project.git（merge_push 等读此字段）。
 */
function applyGitConfigToStages(stagesObj, config = {}) {
  const g = resolveGitConfig(config);
  if (!stagesObj.pipeline) stagesObj.pipeline = {};
  if (!stagesObj.pipeline.project) stagesObj.pipeline.project = {};
  const prev = stagesObj.pipeline.project.git || {};
  stagesObj.pipeline.project.git = {
    ...prev,
    remote:         g.remote,
    default_branch: g.default_branch,
    remote_url:     g.remote_url != null ? g.remote_url : (prev.remote_url ?? null),
  };
  return stagesObj;
}

function stageKeyToStagesField(stageKey) {
  return String(stageKey).replace(/-/g, '_');
}

function formatLocalTimeShort(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = d.getTimezoneOffset();
  const sign = tz <= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(tz) / 60));
  const om = pad(Math.abs(tz) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${oh}${om}`;
}

/**
 * 根据 sync 结果更新 stages.<stage>.git_sync
 */
function updateStageGitSync(stagesObj, stageKey, syncResult) {
  const field = stageKeyToStagesField(stageKey);
  if (!stagesObj.stages) stagesObj.stages = {};
  if (!stagesObj.stages[field]) stagesObj.stages[field] = {};
  const gs = { ...(stagesObj.stages[field].git_sync || {}) };
  const now = formatLocalTimeShort();

  if (syncResult && syncResult.skipped) {
    gs.last_push_status = syncResult.reason || gs.last_push_status || 'skipped';
    stagesObj.stages[field].git_sync = gs;
    return stagesObj;
  }

  if (syncResult && syncResult.commit) {
    gs.last_commit = syncResult.commit;
  }
  const pushStatus = syncResult && (syncResult.push_status || (syncResult.pushed ? 'pushed' : null));
  if (pushStatus) {
    gs.last_push_status = pushStatus;
    if (pushStatus === 'pushed') {
      gs.docs_pipeline_pushed_at = gs.docs_pipeline_pushed_at || now;
      if (!gs.initial_pushed_at) gs.initial_pushed_at = now;
    }
  }
  stagesObj.stages[field].git_sync = gs;
  return stagesObj;
}

/**
 * stage 完成后：若 auto_commit 则 commit；若 allow_push 且 remote 可推则 push。
 * @returns {Promise<object>} sync 结果或 { skipped: true, reason }
 */
async function runGitSyncAfterStage(projectRoot, stageKey, opts = {}) {
  const config = opts.config || loadConfigDev(projectRoot);
  const g = resolveGitConfig(config);
  const phase = STAGE_PHASE_MAP[stageKey];

  if (!g.auto_commit) {
    return { ok: true, skipped: true, reason: 'git.auto_commit=false' };
  }
  if (!phase) {
    return { ok: true, skipped: true, reason: 'stage_not_mapped_for_git_sync' };
  }
  if (!gitSync.isInsideWorkTree(projectRoot)) {
    return { ok: false, skipped: true, reason: 'not_a_git_repo' };
  }

  if (g.remote_url) {
    const init = gitSync.initLocalAndRemote(projectRoot, config);
    if (!init.ok) {
      return { ok: false, reason: init.reason || 'git_init_failed' };
    }
  }

  const syncResult = gitSync.syncPipelineGit(projectRoot, phase, {
    config,
    featureId: opts.featureId,
    message:   opts.message,
  });

  return syncResult;
}

/**
 * 读取 config、同步 project.git、可选执行 stage git sync 并写回 stages。
 * @param {{ writeStagesJson: (obj)=>string, readStagesJson: ()=>object, log?: object }} io
 */
async function finalizeStageGit(projectRoot, stageKey, io, opts = {}) {
  const config = loadConfigDev(projectRoot);
  let stagesObj = io.readStagesJson();
  stagesObj = applyGitConfigToStages(stagesObj, config);
  io.writeStagesJson(stagesObj);

  const onlyOnCompleted = opts.onlyOnCompleted !== false;
  if (onlyOnCompleted) {
    const field = stageKeyToStagesField(stageKey);
    const st = stagesObj.stages && stagesObj.stages[field];
    if (!st || st.status !== 'completed') {
      return { skipped: true, reason: 'stage_not_completed' };
    }
  }

  const syncResult = await runGitSyncAfterStage(projectRoot, stageKey, {
    config,
    featureId: opts.featureId,
    message:   opts.message,
  });

  stagesObj = io.readStagesJson();
  stagesObj = applyGitConfigToStages(stagesObj, config);
  stagesObj = updateStageGitSync(stagesObj, stageKey, syncResult);
  io.writeStagesJson(stagesObj);

  const log = opts.log || io.log;
  if (log) {
    if (syncResult.skipped) {
      log.info('git_sync_skipped', `stage ${stageKey} 跳过 git 同步`, {
        stage: stageKey, reason: syncResult.reason,
      });
    } else if (syncResult.committed) {
      log.info('git_sync', `stage ${stageKey} git commit 完成`, {
        stage: stageKey, commit: syncResult.commit || null,
        push_status: syncResult.push_status || 'not_requested',
      });
    } else if (syncResult.reason === 'clean') {
      log.info('git_sync_skipped', `stage ${stageKey} 工作区无变更`, {
        stage: stageKey, reason: 'clean',
      });
    } else if (!syncResult.ok) {
      log.warn('git_sync_failed', `stage ${stageKey} git 同步失败`, {
        stage: stageKey, reason: syncResult.reason || syncResult.push_error,
      });
    }
  }

  return syncResult;
}

module.exports = {
  STAGE_PHASE_MAP,
  loadConfigDev,
  resolveGitConfig,
  applyGitConfigToStages,
  updateStageGitSync,
  runGitSyncAfterStage,
  finalizeStageGit,
};

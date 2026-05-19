'use strict';

/**
 * pipeline-recovery.cjs — run-pipeline 编排级 stage 失败修复（std3 §3.4）
 *
 * 组装错误包 → 派发 pipeline-recovery Agent → Ajv 校验 → git commit/push → 重跑 step
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getCursorApiKey, getSkillsRoot, readConfigJson, resolvePipelineModel, loadProjectEnv } = require('./pipeline-config.cjs');
const gitStageSync = require('./git-stage-sync.cjs');
const { invokeSdkAgent } = require('./invoke-sdk-agent.cjs');

const NON_RECOVERABLE_EXIT = new Set([0, 2, 5, 9]);
const NO_RECOVERY_STEPS    = new Set(['report']);

const GIT_BLOCKLIST_SUBSTR = [
  'config.env',
  '/.env',
  '.env.',
  'credentials',
  '.pem',
  '.key',
];

// ── Ajv（缓存）────────────────────────────────────────────────────
let _ajv = null;
let _recoveryValidate = null;

function getRecoveryValidator(skillsRoot) {
  if (_recoveryValidate) return _recoveryValidate;
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  _ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(_ajv);
  const schemaPath = path.join(skillsRoot, 'ai-std3', 'schemas', 'pipeline-recovery-output.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  _recoveryValidate = _ajv.compile(schema);
  return _recoveryValidate;
}

// ── 配置 ──────────────────────────────────────────────────────────
function readRecoveryConfig(projectRoot) {
  const cfg     = readConfigJson(projectRoot);
  const rec     = (cfg.pipeline && cfg.pipeline.recovery) || {};
  return {
    enabled:                  rec.enabled !== false,
    maxAttemptsPerStage:        Number(rec.max_attempts_per_stage) || 2,
    recoverableExitCodes:     Array.isArray(rec.recoverable_exit_codes)
      ? rec.recoverable_exit_codes.map(Number)
      : [3, 4, 6, 8],
    logTailLines:             Number(rec.log_tail_lines) || 200,
    requirePushForSkillFix:   rec.require_push_for_skill_fix !== false,
  };
}

// ── step → 日志 stage 名 ──────────────────────────────────────────
function stepToLogStages(step) {
  if (step === 'design_phase') return ['design', 'design-review'];
  if (step === 'build_phase')  return ['codegen', 'create-ui-scenarios'];
  return [step];
}

function stageKeyInJson(step) {
  return step.replace(/-/g, '_');
}

// ── 日志尾行 ──────────────────────────────────────────────────────
function readLogTail(projectRoot, logStages, maxLines) {
  const out = {};
  for (const st of logStages) {
    const dir = path.join(projectRoot, 'logs', 'stages', st);
    if (!fs.existsSync(dir)) {
      out[st] = [];
      continue;
    }
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length === 0) {
      out[st] = [];
      continue;
    }
    const content = fs.readFileSync(path.join(dir, files[0].f), 'utf8');
    const lines   = content.split('\n');
    out[st] = lines.slice(-maxLines);
  }
  return out;
}

// ── 分诊产物摘录 ──────────────────────────────────────────────────
function findTriageArtifacts(projectRoot) {
  const pipelineDir = path.join(projectRoot, '.pipeline');
  if (!fs.existsSync(pipelineDir)) return [];
  const names = fs.readdirSync(pipelineDir).filter(n =>
    /triage/i.test(n) && n.endsWith('.json')
  );
  const artifacts = [];
  for (const name of names.slice(0, 8)) {
    const p = path.join(pipelineDir, name);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      artifacts.push({
        path:    name,
        excerpt: raw.length > 8000 ? raw.slice(0, 8000) + '\n…(truncated)' : raw,
      });
    } catch (_) { /* */ }
  }
  return artifacts;
}

// ── 是否应跳过（stage 内分诊已 blocked）──────────────────────────
function isStageInternallyBlocked(stages, step) {
  if (!stages || !stages.stages) return false;
  if (step === 'deploy' || step.includes('deploy')) {
    const d = stages.stages.deploy;
    return !!(d && d.outputs && d.outputs.blocked_reason);
  }
  if (step === 'ui_e2e') {
    const u = stages.stages.ui_e2e;
    return Array.isArray(u && u.outputs && u.outputs.blocked_features) &&
      u.outputs.blocked_features.length > 0;
  }
  if (step === 'merge_push') {
    const m = stages.stages.merge_push;
    return !!(m && m.outputs && m.outputs.blocked_reason);
  }
  return false;
}

function countRecoveryAttempts(stages, step, runId) {
  const hist = (stages && stages.pipeline && stages.pipeline.recovery_history) || [];
  return hist.filter(h => h.stage === step && (!runId || h.run_id === runId)).length;
}

function shouldAttemptRecovery({ step, exitCode, projectRoot, stages, runId }) {
  if (NO_RECOVERY_STEPS.has(step)) {
    return { ok: false, reason: 'step_excluded' };
  }
  if (NON_RECOVERABLE_EXIT.has(exitCode)) {
    return { ok: false, reason: `exit_code_${exitCode}` };
  }
  const cfg = readRecoveryConfig(projectRoot);
  if (!cfg.enabled) {
    return { ok: false, reason: 'recovery_disabled' };
  }
  if (!cfg.recoverableExitCodes.includes(exitCode)) {
    return { ok: false, reason: 'exit_not_recoverable' };
  }
  if (step === 'setup' && exitCode === 2) {
    return { ok: false, reason: 'setup_pending_user' };
  }
  if (isStageInternallyBlocked(stages, step)) {
    return { ok: false, reason: 'stage_internal_blocked' };
  }
  if (countRecoveryAttempts(stages, step, runId) >= cfg.maxAttemptsPerStage) {
    return { ok: false, reason: 'max_attempts_reached' };
  }
  if (!getCursorApiKey()) {
    return { ok: false, reason: 'no_api_key' };
  }
  return { ok: true, cfg };
}

// ── 错误包 ────────────────────────────────────────────────────────
function recoveryBundlePath(projectRoot, step) {
  return path.join(projectRoot, '.pipeline', `pipeline-recovery-${step}.json`);
}

function assembleErrorBundle({
  projectRoot, skillsRoot, step, exitCode, runId, attempt, stages,
}) {
  const cfg = readRecoveryConfig(projectRoot);
  let stageSnap = null;
  if (stages && stages.stages) {
    if (step === 'design_phase') {
      stageSnap = {
        design:         stages.stages.design || null,
        design_review:  stages.stages.design_review || null,
      };
    } else if (step === 'build_phase') {
      stageSnap = {
        codegen:               stages.stages.codegen || null,
        create_ui_scenarios:   stages.stages.create_ui_scenarios || null,
      };
    } else {
      const sk = stageKeyInJson(step);
      stageSnap = stages.stages[sk] || null;
    }
  }

  return {
    failed_stage:  step,
    exit_code:     exitCode,
    run_id:        runId,
    attempt,
    assembled_at:  require('./logger.cjs').formatLocalTimeShort(),
    skills_root:   skillsRoot,
    log_tail:      readLogTail(projectRoot, stepToLogStages(step), cfg.logTailLines),
    stage_snapshot: stageSnap,
    triage_artifacts: findTriageArtifacts(projectRoot),
    acceptance_criteria: [
      '修改须能解释 exit_code 与 log_tail 中的错误信息',
      'repair_target=skill 时仅允许修改 ai-std3/ 下文件',
      'repair_target=project 时禁止修改 ai-std3/ 与 skill 仓',
      '禁止提交 config.env、.env、密钥文件',
      '输出 JSON 须满足 pipeline-recovery-output.schema.json',
    ],
    recovery: null,
  };
}

// ── Agent ─────────────────────────────────────────────────────────
async function runRecoveryAgent({ projectRoot, skillsRoot, bundlePath, step, log }) {
  loadProjectEnv(projectRoot);
  const cfg   = readConfigJson(projectRoot);
  const model = resolvePipelineModel(cfg);

  const result = await invokeSdkAgent({
    skillsRoot,
    projectRoot,
    promptFile:   'pipeline-recovery.md',
    agentId:      `pipeline-recovery-${step}`,
    cwd:          projectRoot,
    model,
    timeoutMs:    600000,
    log,
    artifactPath: bundlePath,
    inject: {
      recovery_bundle: bundlePath,
      failed_stage:    step,
    },
    extraPrompt: '读取 recovery_bundle 中的 input 字段，将 recovery 对象写回同一 JSON 文件。',
  });

  if (!result.artifact) {
    log.error('recovery_complete', 'recovery Agent 未产出有效 recovery 字段', {
      error: result.error,
    });
    return null;
  }
  return result.artifact;
}

function validateRecovery(recovery, skillsRoot) {
  const validate = getRecoveryValidator(skillsRoot);
  const valid = validate(recovery);
  return { valid, errors: validate.errors || [] };
}

// ── Git ───────────────────────────────────────────────────────────
function resolveSkillGitRoot(skillsRoot) {
  let cur = path.resolve(skillsRoot);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(skillsRoot);
}

function isBlockedGitPath(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  return GIT_BLOCKLIST_SUBSTR.some(s => norm.includes(s));
}

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function listDirtyFiles(repoRoot) {
  const r = runGit(repoRoot, ['status', '--porcelain']);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const rest = line.slice(3).trim();
      const arrow = rest.indexOf(' -> ');
      return arrow >= 0 ? rest.slice(arrow + 4).trim() : rest;
    });
}

function safeGitAdd(repoRoot, repairTarget) {
  const files = listDirtyFiles(repoRoot);
  let added = 0;
  for (const file of files) {
    if (isBlockedGitPath(file)) continue;
    const norm = file.replace(/\\/g, '/');
    if (repairTarget === 'skill' && !norm.startsWith('ai-std3/')) continue;
    if (repairTarget === 'project' && norm.startsWith('ai-std3/')) continue;
    const ar = runGit(repoRoot, ['add', '--', file]);
    if (ar.status === 0) added++;
  }
  return added;
}

function gitDiffStat(repoRoot) {
  const r = runGit(repoRoot, ['diff', '--cached', '--stat']);
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

function commitAndPush({
  repairTarget, projectRoot, skillsRoot, stage, reason, autoCommit, allowPush, requirePushForSkill,
}) {
  const repoRoot = repairTarget === 'skill'
    ? resolveSkillGitRoot(skillsRoot)
    : projectRoot;

  if (repairTarget === 'project' && !autoCommit) {
    return {
      repo: repairTarget,
      commit: null,
      pushed: false,
      push_skipped_reason: 'git.auto_commit=false',
    };
  }

  const dirty = listDirtyFiles(repoRoot);
  if (dirty.length === 0) {
    return {
      repo: repairTarget,
      commit: null,
      pushed: false,
      push_skipped_reason: 'no_changes',
    };
  }

  safeGitAdd(repoRoot, repairTarget);

  const stat = gitDiffStat(repoRoot);
  const staged = runGit(repoRoot, ['diff', '--cached', '--quiet']);
  if (staged.status === 0) {
    return {
      repo: repairTarget,
      commit: null,
      pushed: false,
      push_skipped_reason: 'nothing_staged_after_filter',
      diff_stat: stat,
    };
  }

  const msg = repairTarget === 'skill'
    ? `fix(ai-std3): ${stage} recovery — ${(reason || 'auto').slice(0, 72)}`
    : `fix: ${stage} pipeline recovery`;

  const commitR = runGit(repoRoot, ['commit', '-m', msg]);
  if (commitR.status !== 0) {
    return {
      repo: repairTarget,
      commit: null,
      pushed: false,
      push_skipped_reason: `commit_failed: ${(commitR.stderr || '').trim()}`,
      diff_stat: stat,
    };
  }

  const headR = runGit(repoRoot, ['rev-parse', '--short', 'HEAD']);
  const commit = headR.status === 0 ? headR.stdout.trim() : null;

  let pushed = false;
  let push_skipped_reason = null;

  const shouldPush = repairTarget === 'skill' || allowPush === true;
  if (shouldPush) {
    const pushR = runGit(repoRoot, ['push']);
    pushed = pushR.status === 0;
    if (!pushed) {
      push_skipped_reason = (pushR.stderr || pushR.stdout || 'push failed').trim().slice(0, 200);
      if (repairTarget === 'skill' && requirePushForSkill) {
        // 仍视为 fix，仅 WARN（§3.4）
      }
    }
  } else {
    push_skipped_reason = 'git.allow_push=false';
  }

  return { repo: repairTarget, commit, pushed, push_skipped_reason, diff_stat: stat };
}

function ensureGitAfterRecovery({
  recovery, projectRoot, skillsRoot, stage, log, cfg,
}) {
  if (recovery.decision !== 'fix') return recovery.git || null;

  const gitCfg = gitStageSync.resolveGitConfig(readConfigJson(projectRoot));

  if (recovery.git && recovery.git.commit && recovery.git.pushed) {
    return recovery.git;
  }

  const target = recovery.repair_target;
  if (target !== 'skill' && target !== 'project') return recovery.git || null;

  const gitResult = commitAndPush({
    repairTarget:          target,
    projectRoot,
    skillsRoot,
    stage,
    reason:                recovery.reason,
    autoCommit:            gitCfg.auto_commit,
    allowPush:             gitCfg.allow_push,
    requirePushForSkill:   cfg.requirePushForSkillFix,
  });

  if (gitResult.diff_stat) {
    log.info('recovery_review', 'git diff --stat（脚本确定性评审）', {
      repair_target: target,
      diff_stat:     gitResult.diff_stat,
    });
  }

  if (gitResult.pushed) {
    log.info('recovery_git_push', `${target} push 成功`, {
      repo:   target,
      commit: gitResult.commit,
      pushed: true,
    });
  } else if (gitResult.push_skipped_reason) {
    log.warn('recovery_git_push', `${target} 未 push: ${gitResult.push_skipped_reason}`, {
      repo:   target,
      commit: gitResult.commit,
      pushed: false,
    });
  }

  recovery.git = {
    repo:                gitResult.repo,
    commit:              gitResult.commit,
    pushed:              !!gitResult.pushed,
    push_skipped_reason: gitResult.push_skipped_reason || null,
  };
  return recovery.git;
}

// ── stages.json 历史 ────────────────────────────────────────────────
function appendRecoveryHistory(stages, entry) {
  if (!stages.pipeline) stages.pipeline = {};
  if (!Array.isArray(stages.pipeline.recovery_history)) {
    stages.pipeline.recovery_history = [];
  }
  stages.pipeline.recovery_history.push(entry);
  stages.pipeline.updated_at = require('./logger.cjs').formatLocalTimeShort();
}

// ── 单次 recovery ─────────────────────────────────────────────────
async function runOneRecoveryAttempt({
  projectRoot, skillsRoot, runId, step, exitCode, attempt,
  stages, log, writeStagesJson, readStagesJson,
}) {
  const cfg = readRecoveryConfig(projectRoot);
  const bundlePath = recoveryBundlePath(projectRoot, step);
  const bundle = assembleErrorBundle({
    projectRoot, skillsRoot, step, exitCode, runId, attempt, stages,
  });

  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n', 'utf8');

  let recovery = await runRecoveryAgent({
    projectRoot, skillsRoot, bundlePath, step, log,
  });

  if (!recovery) {
    log.warn('recovery_complete', 'recovery_failed：无有效 Agent 产出', {
      decision: 'invalid', will_retry_step: false,
    });
    return { kind: 'failed' };
  }

  // 合并写回 bundle
  try {
    const doc = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    doc.recovery = recovery;
    fs.writeFileSync(bundlePath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (_) { /* */ }

  const { valid, errors } = validateRecovery(recovery, skillsRoot);
  if (!valid) {
    log.warn('recovery_complete', 'recovery JSON 未通过 Ajv', {
      errors: JSON.stringify(errors).slice(0, 500),
      will_retry_step: false,
    });
    return { kind: 'failed' };
  }

  if (recovery.self_review) {
    log.info('recovery_review', 'Agent 自评', {
      repair_target: recovery.repair_target,
      passed:        recovery.self_review.passed,
      notes:         recovery.self_review.notes || '',
      files_changed: recovery.files_changed || [],
    });
  }

  ensureGitAfterRecovery({
    recovery, projectRoot, skillsRoot, step, log, cfg,
  });

  const histEntry = {
    stage:         step,
    run_id:        runId,
    exit_code:     exitCode,
    attempt,
    decision:      recovery.decision,
    repair_target: recovery.repair_target,
    commit:        recovery.git && recovery.git.commit,
    pushed:        recovery.git && recovery.git.pushed,
    at:            require('./logger.cjs').formatLocalTimeShort(),
  };

  const st = readStagesJson() || stages || { pipeline: {}, stages: {} };
  appendRecoveryHistory(st, histEntry);

  if (recovery.decision === 'blocked') {
    st.pipeline.recovery_blocked_at = histEntry.at;
    st.pipeline.recovery_blocked_stage = step;
    writeStagesJson(st);
    log.error('recovery_blocked', recovery.reason, {
      user_actions: recovery.user_actions || [],
    });
    return { kind: 'blocked', recovery };
  }

  writeStagesJson(st);

  if (recovery.decision === 'fix' || recovery.decision === 'retry_only') {
    log.info('recovery_complete', `recovery decision=${recovery.decision}，将重跑 step`, {
      decision:        recovery.decision,
      will_retry_step: true,
    });
    return { kind: 'retry', recovery };
  }

  log.warn('recovery_complete', `未识别的 decision=${recovery.decision}`, {
    will_retry_step: false,
  });
  return { kind: 'failed', recovery };
}

/**
 * stage 失败后的 recovery 循环（§3.4）
 *
 * @returns {Promise<{ exitCode: number, stopPipeline: boolean }>}
 */
async function handleStepFailure({
  projectRoot,
  skillsRoot,
  runId,
  step,
  exitCode,
  log,
  readStagesJson,
  writeStagesJson,
  rerunStep,
}) {
  let currentExit = exitCode;
  let stages      = readStagesJson();

  for (;;) {
    const check = shouldAttemptRecovery({
      step, exitCode: currentExit, projectRoot, stages, runId,
    });

    if (!check.ok) {
      if (check.reason === 'no_api_key' && readRecoveryConfig(projectRoot).enabled) {
        const rec = readRecoveryConfig(projectRoot);
        if (rec.recoverableExitCodes.includes(currentExit) && !NO_RECOVERY_STEPS.has(step)) {
          log.warn('recovery_skipped', 'CURSOR_API_KEY 未设置，跳过编排级修复', {
            failed_stage: step,
            exit_code:    currentExit,
            reason:       check.reason,
          });
        }
      }
      return { exitCode: currentExit, stopPipeline: false };
    }

    const attempt = countRecoveryAttempts(stages, step, runId) + 1;

    log.info('recovery_start', `step=${step} exit=${currentExit} recovery attempt ${attempt}`, {
      failed_stage: step,
      exit_code:    currentExit,
      attempt,
    });

    const result = await runOneRecoveryAttempt({
      projectRoot,
      skillsRoot,
      runId,
      step,
      exitCode: currentExit,
      attempt,
      stages,
      log,
      writeStagesJson,
      readStagesJson,
    });

    stages = readStagesJson();

    if (result.kind === 'blocked') {
      return { exitCode: 9, stopPipeline: true };
    }

    if (result.kind === 'retry') {
      currentExit = await rerunStep();
      log.info(
        currentExit === 0 ? 'stage_complete' : 'stage_failed',
        `recovery 后重跑 step ${step}，退出码 ${currentExit}`,
        { stage: step, exit_code: currentExit, recovery_attempt: attempt }
      );
      if (currentExit === 0) {
        return { exitCode: 0, stopPipeline: false };
      }
      if (currentExit === 5) {
        return { exitCode: 5, stopPipeline: true };
      }
      continue;
    }

    return { exitCode: currentExit, stopPipeline: false };
  }
}

module.exports = {
  readRecoveryConfig,
  shouldAttemptRecovery,
  assembleErrorBundle,
  validateRecovery,
  handleStepFailure,
  recoveryBundlePath,
  stepToLogStages,
  countRecoveryAttempts,
};

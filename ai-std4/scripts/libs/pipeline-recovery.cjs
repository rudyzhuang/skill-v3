'use strict';

/**
 * pipeline-recovery.cjs — run-pipeline 编排级 stage 失败修复（std4 §3.4）
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
  const schemaPath = path.join(skillsRoot, 'ai-std4', 'schemas', 'pipeline-recovery-output.schema.json');
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
    runSelfTestAfterSkillFix: rec.run_self_test_after_skill_fix !== false,
    clearStaleCodegenWorkers: rec.clear_stale_codegen_workers !== false,
    artifactExcerptMaxBytes:  Number(rec.artifact_excerpt_max_bytes) || 12000,
  };
}

/** 日志中常见确定性错误签名（用于错误包与 recovery_hints） */
const ERROR_SIGNATURE_PATTERNS = [
  { id: 'sdk_module_not_found', re: /Cannot find module '@cursor\/sdk'/i,
    hint: 'codegen 内联 worker 须用 createRequire(ai-std4/package.json) 加载 @cursor/sdk，勿依赖 worktree cwd；修复后须清理 .pipeline/workers/codegen/*.tmp.cjs' },
  { id: 'ajv_schema_duplicate', re: /schema.*already exists|ui-scenarios\.yaml\.schema\.json/i,
    hint: 'create-ui-scenarios 须缓存 Ajv compile（勿对同一 $id 重复 compile）' },
  { id: 'stages_json_missing', re: /stages\.json 不存在/i,
    hint: '先跑 setup；勿在 tick 中丢失 stages.json' },
  { id: 'build_phase_max_iter', re: /tick 循环超出最大迭代|max_iterations/i,
    hint: 'build_phase exit 3 常为 tick 空转；先查 codegen exit 4 / has_failed 与 worker 生成物' },
];

function scanLogTailForSignatures(logTail) {
  const hits = [];
  const lines = [];
  for (const [stage, stageLines] of Object.entries(logTail || {})) {
    for (const line of stageLines || []) {
      for (const pat of ERROR_SIGNATURE_PATTERNS) {
        if (pat.re.test(line)) {
          if (!hits.includes(pat.id)) hits.push(pat.id);
          lines.push(`[${stage}] ${line.trim()}`);
        }
      }
    }
  }
  return { signature_ids: hits, matched_lines: lines.slice(0, 40) };
}

function collectFailedFeatures(stages, step) {
  const out = [];
  if (!stages || !stages.stages) return out;
  const keys = step === 'build_phase'
    ? ['codegen', 'create_ui_scenarios']
    : [stageKeyInJson(step)];
  for (const sk of keys) {
    const st = stages.stages[sk];
    if (!st) continue;
    const feats = st.features || {};
    for (const [fid, f] of Object.entries(feats)) {
      if (!f || !['failed', 'blocked'].includes(f.status)) continue;
      out.push({
        feature_id: fid,
        stage:      sk,
        status:     f.status,
        error:      (f.error || '').slice(0, 500),
      });
    }
    if (st.status === 'failed' && st.outputs && Array.isArray(st.outputs.failed_features)) {
      for (const fid of st.outputs.failed_features) {
        if (!out.some(x => x.feature_id === fid && x.stage === sk)) {
          out.push({ feature_id: fid, stage: sk, status: 'failed', error: null });
        }
      }
    }
  }
  return out;
}

function collectCodegenWorkerExcerpts(projectRoot, maxBytes) {
  const workerDir = path.join(projectRoot, '.pipeline', 'workers', 'codegen');
  if (!fs.existsSync(workerDir)) return [];
  const excerpts = [];
  let budget = maxBytes;
  const archiveDir = path.join(workerDir, 'archive');
  const archiveStates = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir)
      .filter(f => f.endsWith('.state.json'))
      .map(f => ({ f: path.join('archive', f), abs: path.join(archiveDir, f), m: fs.statSync(path.join(archiveDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 4)
    : [];
  for (const { f, abs } of archiveStates) {
    if (budget <= 0) break;
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      if (!SDK_RECOVERABLE_RE.test(raw) && !/\"files_changed\": \[\]/.test(raw)) continue;
      let excerpt = raw.length > 1500 ? raw.slice(0, 1500) + '\n…(truncated)' : raw;
      if (excerpt.length > budget) excerpt = excerpt.slice(0, budget) + '\n…(truncated)';
      budget -= excerpt.length;
      excerpts.push({
        path:    `.pipeline/workers/codegen/${f}`,
        excerpt,
        hint:    SDK_RECOVERABLE_RE.test(excerpt)
          ? '归档 worker 含 @cursor/sdk 加载失败（旧内联模板或 stale tmp.cjs）'
          : (/\"status\": \"completed\"/.test(excerpt) ? '归档 worker 为伪完成（completed + 空 files_changed）' : null),
      });
    } catch (_) { /* */ }
  }
  const files = fs.readdirSync(workerDir)
    .filter(f => f.endsWith('.tmp.cjs') || (f.endsWith('.cjs') && !f.includes('archive')))
    .map(f => ({ f, m: fs.statSync(path.join(workerDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 6);
  for (const { f } of files) {
    if (budget <= 0) break;
    const fp = path.join(workerDir, f);
    try {
      let raw = fs.readFileSync(fp, 'utf8');
      const sdkLine = raw.split('\n').findIndex(l => /@cursor\/sdk|createRequire/.test(l));
      let excerpt;
      if (sdkLine >= 0) {
        const start = Math.max(0, sdkLine - 5);
        excerpt = raw.split('\n').slice(start, start + 25).join('\n');
      } else {
        excerpt = raw.length > 2000 ? raw.slice(0, 2000) + '\n…(truncated)' : raw;
      }
      if (excerpt.length > budget) excerpt = excerpt.slice(0, budget) + '\n…(truncated)';
      budget -= excerpt.length;
      excerpts.push({
        path:    `.pipeline/workers/codegen/${f}`,
        excerpt,
        hint:    /@cursor\/sdk/.test(excerpt) && !/createRequire/.test(excerpt)
          ? 'worker 可能为旧模板（裸 require @cursor/sdk）'
          : null,
      });
    } catch (_) { /* */ }
  }
  return excerpts;
}

function buildRecoveryHints({ exitCode, step, signatures, failedFeatures, artifactExcerpts }) {
  const hints = [];
  for (const id of signatures.signature_ids || []) {
    const pat = ERROR_SIGNATURE_PATTERNS.find(p => p.id === id);
    if (pat && pat.hint) hints.push(pat.hint);
  }
  if (exitCode === 3 && step === 'build_phase') {
    hints.push('优先排查 codegen/create-ui-scenarios 的 exit 4 与 agent_failed，勿仅减少 tick 次数');
  }
  if ((artifactExcerpts || []).some(a => a.hint)) {
    for (const a of artifactExcerpts) {
      if (a.hint) hints.push(`${a.path}: ${a.hint}`);
    }
  }
  if ((failedFeatures || []).length > 0) {
    hints.push(`失败 feature 共 ${failedFeatures.length} 个，修复 skill 后脚本将清理 stale codegen worker 再重跑 step`);
  }
  return [...new Set(hints)];
}

function touchesCodegenSkillPath(filesChanged) {
  if (!Array.isArray(filesChanged)) return false;
  return filesChanged.some(f => {
    const n = String(f).replace(/\\/g, '/');
    return /ai-std4\/scripts\/stages\/(codegen|create-ui-scenarios)\.cjs/.test(n) ||
      /ai-std4\/scripts\/run-pipeline\.cjs/.test(n) ||
      /ai-std4\/scripts\/libs\/pipeline-recovery/.test(n);
  });
}

function shouldClearCodegenWorkers({ recovery, step, cfg }) {
  if (!cfg.clearStaleCodegenWorkers) return false;
  if (recovery.decision !== 'fix' && recovery.decision !== 'retry_only') return false;
  if (step !== 'build_phase' && step !== 'codegen') return false;
  if (recovery.decision === 'retry_only') return true;
  if (recovery.repair_target === 'skill' && touchesCodegenSkillPath(recovery.files_changed)) return true;
  return recovery.category === 'script_bug' && (step === 'build_phase' || step === 'codegen');
}

function clearStaleCodegenWorkers(projectRoot, log) {
  const workerDir = path.join(projectRoot, '.pipeline', 'workers', 'codegen');
  if (!fs.existsSync(workerDir)) return { removed: [] };
  const removed = [];
  for (const name of fs.readdirSync(workerDir)) {
    if (!name.endsWith('.tmp.cjs')) continue;
    try {
      fs.unlinkSync(path.join(workerDir, name));
      removed.push(name);
    } catch (_) { /* */ }
  }
  if (removed.length > 0 && log) {
    log.info('recovery_artifacts_cleared', '已清理 stale codegen worker 脚本', {
      count: removed.length,
      files: removed.slice(0, 20),
    });
  }
  return { removed };
}

const SDK_RECOVERABLE_RE = /Cannot find module '@cursor\/sdk'/i;
// no_heartbeat / stdout_idle / fs_idle 均属可重试的 agent 挂起，不是业务逻辑失败
const AGENT_HANG_RE = /^(no_heartbeat|stdout_idle|fs_idle|wall_timeout)$/i;
const EMPTY_FILES_RE = /empty files_changed|no_files_changed|completed_without_files/i;

function isSdkRecoverableCodegenError(err) {
  const s = String(err || '');
  return SDK_RECOVERABLE_RE.test(s) || AGENT_HANG_RE.test(s.trim());
}

function isCodegenRecoverableFailure(err, feat) {
  if (isSdkRecoverableCodegenError(err)) return true;
  if (EMPTY_FILES_RE.test(String(err || ''))) return true;
  const hh = (feat && feat.hang_history) || [];
  return hh.some(h => AGENT_HANG_RE.test(String(h.hang_kind || '').trim()));
}

function readLatestCodegenArchiveState(projectRoot, featureId) {
  const archiveDir = path.join(projectRoot, '.pipeline', 'workers', 'codegen', 'archive');
  if (!fs.existsSync(archiveDir)) return null;
  const prefix = `${featureId}.`;
  const candidates = fs.readdirSync(archiveDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.state.json'))
    .map(f => ({ f, m: fs.statSync(path.join(archiveDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of candidates) {
    try {
      return JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'));
    } catch (_) { /* */ }
  }
  return null;
}

function scanCodegenArchiveSignatures(projectRoot) {
  const archiveDir = path.join(projectRoot, '.pipeline', 'workers', 'codegen', 'archive');
  if (!fs.existsSync(archiveDir)) return { signature_ids: [], matched_lines: [] };
  const ids = [];
  const lines = [];
  for (const fname of fs.readdirSync(archiveDir)) {
    if (!fname.endsWith('.state.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(archiveDir, fname), 'utf8');
      if (SDK_RECOVERABLE_RE.test(raw)) {
        if (!ids.includes('sdk_module_not_found')) ids.push('sdk_module_not_found');
        const errLine = raw.split('\n').find(l => /"error"/.test(l)) || fname;
        lines.push(`[archive] ${fname}: ${errLine.trim().slice(0, 200)}`);
      }
      if (/\"status\": \"completed\"/.test(raw) && /\"files_changed\": \[\]/.test(raw)) {
        if (!ids.includes('codegen_pseudo_completed')) ids.push('codegen_pseudo_completed');
        lines.push(`[archive] ${fname}: completed 但 files_changed 为空`);
      }
    } catch (_) { /* */ }
  }
  return { signature_ids: ids, matched_lines: lines.slice(0, 20) };
}

function shouldResetCodegenSdkFailures({ recovery, step, bundle, cfg }) {
  if (!cfg || cfg.clearStaleCodegenWorkers === false) return false;
  if (recovery.decision !== 'fix' && recovery.decision !== 'retry_only') return false;
  if (step !== 'build_phase' && step !== 'codegen') return false;
  const sigIds = (bundle && bundle.error_signatures && bundle.error_signatures.signature_ids) || [];
  if (sigIds.includes('sdk_module_not_found')) return true;
  const failed = (bundle && bundle.failed_features) || [];
  if (failed.some(f => f.stage === 'codegen' && isSdkRecoverableCodegenError(f.error))) return true;
  const excerpts = (bundle && bundle.artifact_excerpts) || [];
  if (excerpts.some(a => a.hint && /旧模板/.test(a.hint))) return true;
  if (recovery.category === 'script_bug' && (recovery.evidence || []).some(e => SDK_RECOVERABLE_RE.test(e))) {
    return true;
  }
  if (sigIds.includes('codegen_pseudo_completed')) return true;
  if (failed.some(f => f.stage === 'codegen' && isCodegenRecoverableFailure(f.error))) return true;
  return false;
}

/**
 * skill 修复 SDK 加载后，将触顶的 failed/blocked codegen feature 重置为 pending 以便重跑。
 */
function resetCodegenSdkFailures(projectRoot, stages, log) {
  const cg = stages && stages.stages && stages.stages.codegen;
  if (!cg || !cg.features) return { reset: [] };

  const features = cg.features;
  const resetIds = new Set();

  for (const [fid, feat] of Object.entries(features)) {
    if (!feat || feat.status !== 'failed') continue;
    const arch = readLatestCodegenArchiveState(projectRoot, fid);
    const archErr = arch && (arch.error || (arch.status === 'completed' && !(arch.files_changed || []).length
      ? 'completed_without_files_changed' : null));
    if (isCodegenRecoverableFailure(feat.error || archErr, feat)) {
      resetIds.add(fid);
    }
  }

  if (resetIds.size === 0) return { reset: [] };

  let changed = true;
  while (changed) {
    changed = false;
    for (const [fid, feat] of Object.entries(features)) {
      if (!feat || feat.status !== 'blocked' || !feat.error) continue;
      const m = String(feat.error).match(/^dependency_failed:(.+)$/);
      if (m && resetIds.has(m[1]) && !resetIds.has(fid)) {
        resetIds.add(fid);
        changed = true;
      }
    }
  }

  const workerDir = path.join(projectRoot, '.pipeline', 'workers', 'codegen');
  for (const fid of resetIds) {
    const feat = features[fid];
    if (!feat) continue;
    feat.status = 'pending';
    feat.error = null;
    feat.attempts_used = 0;
    feat.agent_id = null;
    feat.started_at = null;
    feat.completed_at = null;
    const statePath = path.join(workerDir, `${fid}.state.json`);
    try {
      if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    } catch (_) { /* */ }
  }

  cg.status = 'running';
  cg.completed_at = null;
  if (cg.outputs) {
    cg.outputs.failed_features = (cg.outputs.failed_features || []).filter(fid => !resetIds.has(fid));
    if (cg.outputs.decision === 'needs_fix') cg.outputs.decision = null;
  }

  const reset = [...resetIds];
  if (reset.length > 0 && log) {
    log.info('recovery_codegen_reset', '已重置 SDK 可恢复 codegen feature 为 pending', {
      feature_ids: reset,
    });
  }
  return { reset };
}

/** 子进程执行重置，避免 run-pipeline 进程内 require 缓存旧版 pipeline-recovery */
function invokeCodegenSdkResetSubprocess(projectRoot, log) {
  const script = path.join(__dirname, 'recovery-reset-codegen.cjs');
  if (!fs.existsSync(script)) {
    const st = readStagesJson();
    if (st) {
      resetCodegenSdkFailures(projectRoot, st, log);
      writeStagesJson(st);
    }
    return;
  }
  const r = spawnSync(process.execPath, [script, `--project=${projectRoot}`], {
    cwd:    projectRoot,
    env:    process.env,
    encoding: 'utf8',
    stdio:  ['ignore', 'pipe', 'pipe'],
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0) {
    log.warn('recovery_codegen_reset', '子进程重置 codegen feature 失败', {
      exit_code: r.status,
      output:    out.slice(-500),
    });
    return;
  }
  log.info('recovery_codegen_reset', '子进程已重置 SDK 可恢复 codegen feature', {
    output: out || null,
  });
}

function runSkillRecoverySelfTests(skillsRoot) {
  const script = path.join(skillsRoot, 'ai-std4', 'scripts', 'self-test-pipeline-recovery.cjs');
  if (!fs.existsSync(script)) {
    return { passed: true, skipped: true, output: 'self-test script missing' };
  }
  const r = spawnSync(process.execPath, [script], {
    cwd:    skillsRoot,
    env:    process.env,
    encoding: 'utf8',
    stdio:  ['ignore', 'pipe', 'pipe'],
  });
  const output = ((r.stdout || '') + (r.stderr || '')).trim();
  return { passed: r.status === 0, skipped: false, output: output.slice(-4000) };
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

function countRecoveryAttempts(stages, step, runId, exitCode) {
  const hist = (stages && stages.pipeline && stages.pipeline.recovery_history) || [];
  return hist.filter(h =>
    h.stage === step &&
    (!runId || h.run_id === runId) &&
    (exitCode == null || h.exit_code == null || h.exit_code === exitCode)
  ).length;
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
  if (countRecoveryAttempts(stages, step, runId, exitCode) >= cfg.maxAttemptsPerStage) {
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

  const logTail = readLogTail(projectRoot, stepToLogStages(step), cfg.logTailLines);
  const signatures = scanLogTailForSignatures(logTail);
  if (step === 'build_phase' || step === 'codegen') {
    const archSigs = scanCodegenArchiveSignatures(projectRoot);
    for (const id of archSigs.signature_ids) {
      if (!signatures.signature_ids.includes(id)) signatures.signature_ids.push(id);
    }
    signatures.matched_lines.push(...archSigs.matched_lines);
  }
  const failedFeatures = collectFailedFeatures(stages, step);
  const includeWorkers = step === 'build_phase' || step === 'codegen';
  const artifactExcerpts = includeWorkers
    ? collectCodegenWorkerExcerpts(projectRoot, cfg.artifactExcerptMaxBytes)
    : [];
  const recoveryHints = buildRecoveryHints({
    exitCode, step, signatures, failedFeatures, artifactExcerpts,
  });

  return {
    failed_stage:  step,
    exit_code:     exitCode,
    run_id:        runId,
    attempt,
    assembled_at:  require('./logger.cjs').formatLocalTimeShort(),
    skills_root:   skillsRoot,
    log_tail:      logTail,
    error_signatures: signatures,
    failed_features:  failedFeatures,
    artifact_excerpts: artifactExcerpts,
    recovery_hints:   recoveryHints,
    stage_snapshot: stageSnap,
    triage_artifacts: findTriageArtifacts(projectRoot),
    acceptance_criteria: [
      '修改须能解释 exit_code、error_signatures 与 artifact_excerpts 中的错误',
      '须逐条处理 recovery_hints（若存在）',
      'repair_target=skill 时仅允许修改 ai-std4/ 下文件',
      'repair_target=project 时禁止修改 ai-std4/ 与 skill 仓',
      '禁止提交 config.env、.env、密钥文件',
      'skill 修复后由脚本跑 self-test-pipeline-recovery.cjs（勿跳过）',
      'codegen SDK：createRequire(ai-std4/package.json)；ui-scenarios：缓存 Ajv validator',
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
    if (repairTarget === 'skill' && !norm.startsWith('ai-std4/')) continue;
    if (repairTarget === 'project' && norm.startsWith('ai-std4/')) continue;
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
    ? `fix(ai-std4): ${stage} recovery — ${(reason || 'auto').slice(0, 72)}`
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

  if (recovery.decision === 'fix' && recovery.repair_target === 'skill' && cfg.runSelfTestAfterSkillFix) {
    const stResult = runSkillRecoverySelfTests(skillsRoot);
    if (!stResult.passed && !stResult.skipped) {
      log.error('recovery_self_test_failed', 'skill 修复后确定性自测未通过', {
        output: stResult.output,
      });
      return { kind: 'failed', recovery, self_test_failed: true };
    }
    if (!stResult.skipped) {
      log.info('recovery_self_test_passed', 'skill 修复后确定性自测通过', {
        script: 'self-test-pipeline-recovery.cjs',
      });
    }
  }

  ensureGitAfterRecovery({
    recovery, projectRoot, skillsRoot, step, log, cfg,
  });

  let clearedWorkers = { removed: [] };
  if (shouldClearCodegenWorkers({ recovery, step, cfg })) {
    clearedWorkers = clearStaleCodegenWorkers(projectRoot, log);
  }

  const sigIds = (bundle && bundle.error_signatures && bundle.error_signatures.signature_ids) || [];
  const needCodegenReset = shouldResetCodegenSdkFailures({ recovery, step, bundle, cfg }) ||
    (clearedWorkers.removed.length > 0 && sigIds.includes('sdk_module_not_found'));

  if (needCodegenReset) {
    invokeCodegenSdkResetSubprocess(projectRoot, log);
  }

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

    const attempt = countRecoveryAttempts(stages, step, runId, currentExit) + 1;

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
  scanLogTailForSignatures,
  collectCodegenWorkerExcerpts,
  collectFailedFeatures,
  buildRecoveryHints,
  clearStaleCodegenWorkers,
  resetCodegenSdkFailures,
  shouldResetCodegenSdkFailures,
  isSdkRecoverableCodegenError,
  runSkillRecoverySelfTests,
  shouldClearCodegenWorkers,
  touchesCodegenSkillPath,
  ERROR_SIGNATURE_PATTERNS,
};

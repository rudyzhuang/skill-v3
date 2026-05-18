'use strict';

/**
 * prd-review.cjs — prd-review stage 编排入口
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. 上游门闸：stages.prd.status=completed 且 validation.passed=true 且 features[] 非空 → exit 1
 *   2. 检测 stop.signal → exit 5
 *   3. hash 门控（prd_spec_hash + 各端 per_target_hashes 全命中 → skipped exit 0）
 *   4. bootstrap：初始化 stages.prd_review 骨架，写 status=running
 *   5. 按端哈希门控：命中且上次 passed 的端跳过 Agent
 *   6. 并发调用各端 Agent（prd-review-<client_target>.md）→ prd-review-<client_target>.json
 *   7. 合并各端产出 → prd-review-output.json；覆盖门闸校验；写完成态
 *   → exit 0 成功 / exit 1 门闸 / exit 3 超时 / exit 4 质量门失败 / exit 5 stop.signal
 *
 * 参数：
 *   --project=<路径>   业务项目根（绝对或相对）
 *   --run-id=<id>      run_id（由 run-pipeline 传入；缺失时自动生成）
 *   --force-rerun      强制跳过 hash 门控，重新执行
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

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
  : process.env.AI_STD3_PROJECT
    ? path.resolve(process.env.AI_STD3_PROJECT)
    : process.cwd();

const skillsRoot = process.env.CURSOR_SKILLS_ROOT
  || path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

const forceRerun = args['force-rerun'] === true || args['force-rerun'] === 'true';

// ── 生成 run_id ───────────────────────────────────────────────────
function generateRunId() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${crypto.randomBytes(4).toString('hex')}`;
}

const runId = args['run-id'] || generateRunId();

// ── 初始化 Logger ──────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'prd-review', runId });

// ── prompt 映射表（client_target → prompt 文件名）────────────────
const PROMPT_MAP = {
  website:  'prd-review-web.md',
  web:      'prd-review-web.md',
  frontend: 'prd-review-web.md',
  backend:  'prd-review-backend.md',
  server:   'prd-review-backend.md',
  api:      'prd-review-backend.md',
  mobile:   'prd-review-mobile.md',
  ios:      'prd-review-mobile.md',
  android:  'prd-review-mobile.md',
  admin:    'prd-review-admin.md',
};

function resolvePromptFile(clientTarget) {
  return PROMPT_MAP[clientTarget.toLowerCase()] || 'prd-review-default.md';
}

// ── client_target → prd 文件名 ───────────────────────────────────
const PRD_FILE_MAP = {
  website: 'prd-web.json',
  web:     'prd-web.json',
  frontend:'prd-web.json',
  backend: 'prd-backend.json',
  server:  'prd-backend.json',
  api:     'prd-backend.json',
  mobile:  'prd-mobile.json',
  ios:     'prd-mobile.json',
  android: 'prd-mobile.json',
  admin:   'prd-admin.json',
};

function resolvePrdFileName(clientTarget) {
  return PRD_FILE_MAP[clientTarget.toLowerCase()] || `prd-${clientTarget.toLowerCase()}.json`;
}

// ── 工具函数 ──────────────────────────────────────────────────────
/** 计算文件 SHA-256 hex；文件不存在返回 null */
function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** 读取 stages.json；不存在返回 null */
function readStagesJson() {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/** 写 stages.json（原子覆盖） */
function writeStagesJson(obj) {
  const pipelineDir = path.join(projectRoot, '.pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const p = path.join(pipelineDir, 'stages.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return p;
}

/** 检查 stop.signal 是否存在 */
function checkStopSignal() {
  return fs.existsSync(path.join(projectRoot, '.pipeline', 'stop.signal'));
}

/** 读取 stop.signal 的 reason */
function getStopReason() {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.pipeline', 'stop.signal'), 'utf8');
    return JSON.parse(raw).reason || 'unknown';
  } catch (_) { return 'unknown'; }
}

/** 优雅停止：写日志、更新 stages.json、删除 stop.signal、退出码 5 */
function gracefulStop(stagesObj) {
  const stoppedAt = formatLocalTimeShort();
  const reason = getStopReason();
  log.info('pipeline_stop', '检测到 stop.signal，开始优雅停止', {
    stage: 'prd-review', reason, stopped_at: stoppedAt,
  });

  if (stagesObj && stagesObj.stages) {
    if (!stagesObj.stages.prd_review) {
      stagesObj.stages.prd_review = buildPrdReviewSkeleton({ status: 'stopped', startedAtStr: stoppedAt });
    } else {
      stagesObj.stages.prd_review.status = 'stopped';
    }
    if (stagesObj.pipeline) {
      stagesObj.pipeline.updated_at = stoppedAt;
      stagesObj.pipeline.stop_info = {
        stopped_at:    stoppedAt,
        stopped_stage: 'prd-review',
        reason,
      };
    }
    writeStagesJson(stagesObj);
  }

  try {
    const signalPath = path.join(projectRoot, '.pipeline', 'stop.signal');
    if (fs.existsSync(signalPath)) fs.unlinkSync(signalPath);
  } catch (_) { /* ignore */ }

  log.info('pipeline_stopped', 'prd-review stage 已优雅停止', {
    stage: 'prd-review', stopped_at: stoppedAt, exit_code: 5,
  });
  process.exit(5);
}

/** 构建 stages.prd_review 初始骨架 */
function buildPrdReviewSkeleton({ status, startedAtStr, existing }) {
  const base = existing || {};
  return Object.assign({}, base, {
    status,
    started_at:   startedAtStr || null,
    completed_at: base.completed_at || null,
    inputs: Object.assign({}, base.inputs || {}, {
      prd_spec_hash:     (base.inputs && base.inputs.prd_spec_hash) || null,
      requires_stage:    'prd',
      source_prd_spec:   path.join(projectRoot, 'docs', 'prd-spec.md'),
      feature_index_ref: 'stages.prd.outputs.features',
      per_target_hashes: (base.inputs && base.inputs.per_target_hashes) || {},
    }),
    outputs: base.outputs || {
      decision:         'pending',
      can_enter_design: false,
      current_phase:    null,
      duration_ms:      null,
      timed_out:        false,
      timeout_reason:   null,
    },
    review: base.review || {
      summary:                    '',
      phase_plan:                 [],
      deferred_features:          [],
      priority_changes:           [],
      cross_phase_dependencies:   [],
      config_change_suggestions:  { dev: [], release: [] },
      suggested_prd_spec_changes: [],
    },
    blocking_issues: base.blocking_issues || [],
    conditions:      base.conditions      || [],
    validation: base.validation || {
      passed:                  false,
      checked_at:              null,
      summary:                 null,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    },
    generated_files: base.generated_files || [],
    git_sync: base.git_sync || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  });
}

/** 读取配置 */
function readConfig() {
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { /* ignore */ }
  }
  const timeoutS          = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.prd_review_s) || 300;
  const maxRetries        = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.prd_review && cfg.pipeline.stages.prd_review.max_retries) || 2;
  const model             = (cfg.pipeline && cfg.pipeline.model) || 'composer-2';
  const featureMaxParallel= (cfg.pipeline && cfg.pipeline.autorun && cfg.pipeline.autorun.feature_max_parallel) || 3;
  const autoCommit        = !!(cfg.git && cfg.git.auto_commit);
  return { timeoutS, maxRetries, model, featureMaxParallel, autoCommit };
}

// ── Ajv 校验 ──────────────────────────────────────────────────────
let _ajv = null;
function getAjv() {
  if (_ajv) return _ajv;
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  _ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(_ajv);
  return _ajv;
}

function loadSchema(schemaName) {
  const p = path.join(skillsRoot, 'ai-std3', 'schemas', schemaName);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function validateJson(data, schemaName) {
  const schema = loadSchema(schemaName);
  if (!schema) return { valid: true, errors: [] }; // schema 不存在时宽松通过
  const ajv = getAjv();
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return { valid, errors: validate.errors || [] };
}

// ── Agent 调用（通过 @cursor/sdk）────────────────────────────────
/**
 * 调用 Cursor Agent
 * @param {object} opts
 * @returns {Promise<{success: boolean, timedOut: boolean, error: string|null, agentRunId: string|null}>}
 */
async function invokeAgent(opts) {
  const {
    agentId, promptFile, inputFiles = [], model, timeoutMs, clientTarget,
    cwd = projectRoot, extraContext = {}, logExtraMeta = {},
  } = opts;

  const promptPath = path.join(skillsRoot, 'ai-std3', 'prompts', promptFile);
  let promptContent = '';
  if (fs.existsSync(promptPath)) {
    promptContent = fs.readFileSync(promptPath, 'utf8');
  } else {
    return { success: false, timedOut: false, error: `Prompt file not found: ${promptPath}`, agentRunId: null };
  }

  // 把额外上下文注入到 prompt 末尾
  const contextLines = Object.entries(extraContext)
    .map(([k, v]) => `\n<!-- inject: ${k}=${v} -->`).join('');
  const finalPrompt = promptContent + contextLines;

  log.info('agent_start', `启动 Agent: ${agentId}`, {
    agent_id:    agentId,
    prompt:      promptFile,
    input_files: inputFiles,
    model,
    ...(clientTarget ? { client_target: clientTarget } : {}),
    ...logExtraMeta,
  });

  let agentRunId = null;
  try {
    const { Agent } = require('@cursor/sdk');

    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      return {
        success: false, timedOut: false,
        error: 'CURSOR_API_KEY not set — cannot invoke Cursor Agent',
        agentRunId: null,
      };
    }

    const agentOptions = {
      apiKey,
      model: { id: model || 'composer-2' },
      local: { cwd },
    };

    const runPromise = (async () => {
      const agent = Agent.create(agentOptions);
      try {
        const run = await agent.send(finalPrompt);
        agentRunId = run.id || null;

        if (run.supports && run.supports('stream')) {
          for await (const event of run.stream()) {
            if (event.type === 'assistant') {
              for (const block of (event.message && event.message.content) || []) {
                if (block.type === 'text') process.stdout.write(block.text);
              }
            }
          }
        }
        const result = await run.wait();
        return { success: result.status === 'finished', error: result.status !== 'finished' ? `Agent run status: ${result.status}` : null };
      } finally {
        if (typeof agent[Symbol.asyncDispose] === 'function') {
          await agent[Symbol.asyncDispose]();
        }
      }
    })();

    const timeoutPromise = new Promise(resolve =>
      setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    );

    const outcome = await Promise.race([runPromise, timeoutPromise]);

    if (outcome.timedOut) {
      return { success: false, timedOut: true, error: `Agent timeout after ${timeoutMs}ms`, agentRunId };
    }
    return { success: outcome.success, timedOut: false, error: outcome.error || null, agentRunId };

  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    return { success: false, timedOut: false, error: errMsg, agentRunId };
  }
}

// ── 单端 Agent（带重试）─────────────────────────────────────────
async function runReviewAgentForTarget({ clientTarget, model, timeoutMs, maxRetries, featuresInScope }) {
  const promptFile  = resolvePromptFile(clientTarget);
  const prdFileName = resolvePrdFileName(clientTarget);
  const prdFile     = path.join(projectRoot, 'docs', prdFileName);
  const flFile      = path.join(projectRoot, 'docs', `feature_list-${clientTarget}.md`);
  const prdSpec     = path.join(projectRoot, 'docs', 'prd-spec.md');
  const outputFile  = path.join(projectRoot, '.pipeline', `prd-review-${clientTarget}.json`);
  const agentId     = `prd-review-agent-${clientTarget}`;

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      log.warn('agent_retry', `Agent(${clientTarget}) 第 ${attempt} 次尝试`, {
        agent_id: agentId, client_target: clientTarget, attempt, reason: lastError,
      });
    }

    const t0 = Date.now();
    const featuresInScopeIds = featuresInScope.map(f => f.feature_id);
    const result = await invokeAgent({
      agentId,
      promptFile,
      inputFiles: [prdSpec, prdFile, flFile],
      model, timeoutMs,
      clientTarget, cwd: projectRoot,
      extraContext: {
        client_target:      clientTarget,
        prd_spec_file:      prdSpec,
        prd_client_file:    prdFile,
        feature_list_file:  flFile,
        output_file:        outputFile,
        features_in_scope:  JSON.stringify(featuresInScopeIds),
      },
      logExtraMeta: {
        features_in_scope: featuresInScopeIds,
      },
    });
    const durationMs = Date.now() - t0;

    if (result.timedOut) {
      log.error('agent_failed', `Agent(${clientTarget}) 超时`, {
        agent_id: agentId, client_target: clientTarget,
        max_attempts: maxRetries + 1, last_error: result.error,
        exit_code: 3,
      });
      return { success: false, timedOut: true, clientTarget, error: result.error };
    }

    if (!result.success) {
      lastError = result.error;
      if (attempt > maxRetries) break;
      continue;
    }

    // Schema 校验
    if (fs.existsSync(outputFile)) {
      let outputData;
      try { outputData = JSON.parse(fs.readFileSync(outputFile, 'utf8')); }
      catch (e) {
        lastError = `JSON parse error: ${e.message}`;
        if (attempt > maxRetries) break;
        log.warn('agent_retry', `Agent(${clientTarget}) JSON 解析失败，重试`, {
          agent_id: agentId, client_target: clientTarget, attempt, reason: lastError,
        });
        continue;
      }

      const { valid, errors } = validateJson(outputData, 'prd-review-client-output.schema.json');
      if (!valid) {
        const invalidFields = errors.map(e => e.instancePath + ' ' + e.message).join('; ');
        lastError = `Schema validation failed: ${invalidFields}`;
        log.warn('agent_retry', `Agent(${clientTarget}) schema 校验失败`, {
          agent_id: agentId, client_target: clientTarget, attempt,
          reason: 'schema_validation_failed', invalid_fields: invalidFields,
        });
        if (attempt > maxRetries) break;
        continue;
      }

      // 校验通过
      const decision         = outputData.outputs && outputData.outputs.decision;
      const featuresReviewed = outputData.outputs && outputData.outputs.features_reviewed;
      const featuresDeferred = outputData.outputs && outputData.outputs.features_deferred;

      log.info('agent_complete', `Agent(${clientTarget}) 完成`, {
        agent_id:          agentId,
        client_target:     clientTarget,
        duration_ms:       durationMs,
        output_files:      [outputFile],
        decision,
        features_reviewed: featuresReviewed,
        features_deferred: featuresDeferred,
      });

      return { success: true, timedOut: false, clientTarget, decision, outputData };
    } else {
      lastError = `Output file not found: ${outputFile}`;
      if (attempt > maxRetries) break;
      log.warn('agent_retry', `Agent(${clientTarget}) 输出文件缺失，重试`, {
        agent_id: agentId, client_target: clientTarget, attempt, reason: lastError,
      });
    }
  }

  log.error('agent_failed', `Agent(${clientTarget}) 超过最大重试次数`, {
    agent_id:     agentId,
    client_target: clientTarget,
    max_attempts: maxRetries + 1,
    last_error:   lastError,
    exit_code:    4,
  });
  return { success: false, timedOut: false, clientTarget, error: lastError };
}

// ── 并发控制：Worker pool ─────────────────────────────────────────
async function runAgentsConcurrent({ clientTargets, model, timeoutMs, maxRetries, featureMaxParallel, allFeatures }) {
  const concurrency = Math.min(featureMaxParallel, clientTargets.length);
  const results = [];
  let index = 0;
  let timedOutExists = false;

  async function worker() {
    while (index < clientTargets.length) {
      const ct = clientTargets[index++];

      // 每个 Agent 启动前检查 stop.signal
      if (checkStopSignal()) {
        results.push({ success: false, timedOut: false, clientTarget: ct, stopped: true });
        continue;
      }

      const featuresInScope = allFeatures.filter(f =>
        Array.isArray(f.client_targets) && f.client_targets.includes(ct)
      );

      const result = await runReviewAgentForTarget({
        clientTarget: ct, model, timeoutMs, maxRetries, featuresInScope,
      });

      if (result.timedOut) timedOutExists = true;
      results.push(result);
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { results, timedOutExists };
}

// ── 合并各端产出 → prd-review-output.json ───────────────────────
const PHASE_ORDER = ['mvp', 'standard', 'complete', 'future'];

function mergeClientOutputs({ clientTargets, allFeatures }) {
  const clientOutputs = [];
  const missingFiles  = [];

  for (const ct of clientTargets) {
    const outputFile = path.join(projectRoot, '.pipeline', `prd-review-${ct}.json`);
    if (!fs.existsSync(outputFile)) {
      missingFiles.push(outputFile);
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      clientOutputs.push({ clientTarget: ct, data });
    } catch (e) {
      missingFiles.push(`${outputFile} (parse error: ${e.message})`);
    }
  }

  if (missingFiles.length > 0) {
    return {
      success: false,
      reason: `Missing or invalid client output files: ${missingFiles.join(', ')}`,
      conflictFeatureIds: [],
    };
  }

  // 判断所有端是否都 passed
  const allPassed = clientOutputs.every(co =>
    co.data.outputs && co.data.outputs.decision === 'passed'
  );

  // 构建 feature disposition 汇总 map
  // feature_id → { dispositions: {ct: 'include'|'defer'}, phases: {ct: phase}, notes: [] }
  const featureMap = new Map();

  for (const { clientTarget, data } of clientOutputs) {
    const assessments = (data.review && data.review.feature_assessments) || [];
    for (const a of assessments) {
      if (!a.feature_id) continue;
      if (!featureMap.has(a.feature_id)) {
        featureMap.set(a.feature_id, { dispositions: {}, phases: {}, notes: [] });
      }
      const entry = featureMap.get(a.feature_id);
      entry.dispositions[clientTarget] = a.disposition;
      if (a.phase) entry.phases[clientTarget] = a.phase;
      if (a.notes) entry.notes.push(`[${clientTarget}] ${a.notes}`);
    }
  }

  // 检测冲突：同一 feature 在不同端 include/defer 不一致
  const conflictFeatureIds = [];
  for (const [fid, entry] of featureMap.entries()) {
    const dispositions = Object.values(entry.dispositions);
    if (dispositions.includes('include') && dispositions.includes('defer')) {
      conflictFeatureIds.push(fid);
    }
  }

  if (conflictFeatureIds.length > 0) {
    log.error('validation_fail', '合并冲突：feature 在不同端 include/defer 不一致', {
      conflict_feature_ids: conflictFeatureIds,
      details: `Features with conflicting dispositions: ${conflictFeatureIds.join(', ')}`,
    });
    return { success: false, reason: 'Conflicting dispositions across targets', conflictFeatureIds };
  }

  // 按 phase 分组（include 的 feature）；defer 的汇总为 deferred_features
  const phaseGroups = {};  // phase → { feature_ids: [], notes: [] }
  const deferredFeatures = [];

  for (const [fid, entry] of featureMap.entries()) {
    const dispositions = Object.values(entry.dispositions);
    const hasInclude   = dispositions.includes('include');
    const allDeferred  = dispositions.length > 0 && dispositions.every(d => d === 'defer');

    if (hasInclude) {
      // 取跨端最早 phase
      const phases = Object.values(entry.phases).filter(p => PHASE_ORDER.includes(p));
      const phase  = phases.length > 0
        ? phases.reduce((a, b) => PHASE_ORDER.indexOf(a) <= PHASE_ORDER.indexOf(b) ? a : b)
        : 'future';

      if (!phaseGroups[phase]) phaseGroups[phase] = { feature_ids: [], notes: [] };
      phaseGroups[phase].feature_ids.push(fid);
      phaseGroups[phase].notes.push(...entry.notes);
    } else if (allDeferred) {
      // 从各端 deferred_features 中提取 reason/priority
      const deferEntry = { feature_id: fid };
      for (const { clientTarget, data } of clientOutputs) {
        const df = ((data.review && data.review.deferred_features) || []).find(d => d.feature_id === fid);
        if (df) {
          if (df.reason   && !deferEntry.reason)   deferEntry.reason   = df.reason;
          if (df.priority && !deferEntry.priority) deferEntry.priority = df.priority;
        }
      }
      deferredFeatures.push(deferEntry);
    }
  }

  // allFeatures 中未被任何端评估的 feature → 按 prd 原有 phase 放入 phase_plan
  const coveredIds = new Set(featureMap.keys());
  for (const f of allFeatures) {
    if (!coveredIds.has(f.feature_id)) {
      const phase = PHASE_ORDER.includes(f.phase) ? f.phase : 'future';
      if (!phaseGroups[phase]) phaseGroups[phase] = { feature_ids: [], notes: [] };
      phaseGroups[phase].feature_ids.push(f.feature_id);
    }
  }

  // 构建 phase_plan（按 PHASE_ORDER 排序）
  const phasePlan = PHASE_ORDER
    .filter(p => phaseGroups[p] && phaseGroups[p].feature_ids.length > 0)
    .map(p => {
      const group    = phaseGroups[p];
      const uniqueIds = [...new Set(group.feature_ids)];
      const notesText = group.notes.filter(Boolean).join('；');
      return {
        phase:        p,
        feature_ids:  uniqueIds,
        goal:         notesText ? notesText.substring(0, 300) : `完成 ${p} 阶段的所有功能点`,
        exit_criteria: [
          `${p} 阶段所有 feature 实现完成并通过验收`,
          `功能列表覆盖：${uniqueIds.join(', ')}`,
        ],
      };
    });

  // schema 要求 phase_plan minItems:1，确保非空
  if (phasePlan.length === 0 && allFeatures.length > 0) {
    phasePlan.push({
      phase:         'mvp',
      feature_ids:   allFeatures.map(f => f.feature_id),
      goal:          '完成 MVP 阶段的所有功能点',
      exit_criteria: ['MVP 阶段所有 feature 实现完成并通过验收'],
    });
  }

  // 合并 summaries
  const summaryParts = clientOutputs.map(co =>
    `### ${co.clientTarget}\n${(co.data.review && co.data.review.summary) || ''}`
  );
  const summary = summaryParts.join('\n\n');

  // 合并 blocking_issues / conditions / suggested_prd_spec_changes
  const allBlockingIssues   = [];
  const allConditions        = [];
  const allSuggestedChanges  = [];

  for (const { data } of clientOutputs) {
    if (data.review && Array.isArray(data.review.blocking_issues)) {
      allBlockingIssues.push(...data.review.blocking_issues);
    }
    if (Array.isArray(data.blocking_issues)) {
      allBlockingIssues.push(...data.blocking_issues);
    }
    if (Array.isArray(data.conditions)) {
      allConditions.push(...data.conditions);
    }
    if (data.review && Array.isArray(data.review.suggested_prd_spec_changes)) {
      allSuggestedChanges.push(...data.review.suggested_prd_spec_changes);
    }
  }

  const overallDecision = (allPassed && conflictFeatureIds.length === 0) ? 'passed' : 'failed';

  const mergedOutput = {
    review: {
      summary,
      phase_plan:                 phasePlan,
      deferred_features:          deferredFeatures,
      suggested_prd_spec_changes: allSuggestedChanges,
    },
    outputs: {
      decision: overallDecision,
    },
    blocking_issues: allBlockingIssues,
    conditions:      allConditions,
  };

  return { success: true, mergedOutput, overallDecision, conflictFeatureIds: [] };
}

// ── 覆盖门闸校验 ─────────────────────────────────────────────────
function validateCoverage({ allFeatures, mergedOutput }) {
  const featureIdSet = new Set(allFeatures.map(f => f.feature_id));
  const inPlan = new Set(mergedOutput.review.phase_plan.flatMap(p => p.feature_ids));
  const deferred = new Set(
    mergedOutput.review.deferred_features.map(d =>
      typeof d === 'string' ? d : d.feature_id
    )
  );

  const uncovered  = [];
  const duplicates = [];
  const unknown    = [];

  for (const fid of featureIdSet) {
    if (!inPlan.has(fid) && !deferred.has(fid)) uncovered.push(fid);
    if (inPlan.has(fid) && deferred.has(fid))  duplicates.push(fid);
  }
  for (const fid of [...inPlan, ...deferred]) {
    if (!featureIdSet.has(fid) && !unknown.includes(fid)) unknown.push(fid);
  }

  if (uncovered.length > 0 || duplicates.length > 0 || unknown.length > 0) {
    log.error('validation_fail', '覆盖门闸失败', {
      uncovered_feature_ids: uncovered,
      duplicate_feature_ids: duplicates,
      unknown_feature_ids:   unknown,
    });
    return { passed: false, uncovered, duplicates, unknown };
  }

  return { passed: true, uncovered: [], duplicates: [], unknown: [] };
}

// ── 生成 prd-implementation-summary.md ──────────────────────────
function generateImplementationSummary({ mergedOutput, clientTargets }) {
  const { review, outputs } = mergedOutput;
  const decision   = outputs.decision;
  const checkedAt  = formatLocalTimeShort();

  let md = `# PRD 评审结论\n\n`;
  md += `## AI 评审门闸结果\n\n`;
  md += `| 项 | 值 |\n| --- | --- |\n`;
  md += `| **评审时间** | ${checkedAt} |\n`;
  md += `| **整体决策** | ${decision === 'passed' ? '✓ PASSED' : '✗ FAILED'} |\n`;
  md += `| **评审端** | ${clientTargets.join(', ')} |\n`;
  md += `| **分期数** | ${review.phase_plan.length} |\n`;
  md += `| **延期功能** | ${review.deferred_features.length} 个 |\n\n`;

  md += `## 评审摘要\n\n${review.summary}\n\n`;

  if (review.phase_plan.length > 0) {
    md += `## 分期计划\n\n`;
    for (const phase of review.phase_plan) {
      md += `### ${phase.phase.toUpperCase()} 阶段\n\n`;
      md += `**目标**：${phase.goal}\n\n`;
      md += `**功能列表**：${phase.feature_ids.join(', ')}\n\n`;
      md += `**验收标准**：\n`;
      for (const c of phase.exit_criteria) {
        md += `- ${c}\n`;
      }
      md += '\n';
    }
  }

  if (review.deferred_features.length > 0) {
    md += `## 延期功能\n\n`;
    for (const df of review.deferred_features) {
      const fid    = typeof df === 'string' ? df : df.feature_id;
      const reason = typeof df === 'object' && df.reason ? df.reason : '';
      md += `- **${fid}**${reason ? `：${reason}` : ''}\n`;
    }
    md += '\n';
  }

  if (decision !== 'passed' && mergedOutput.blocking_issues.length > 0) {
    md += `## 阻塞问题\n\n`;
    for (const issue of mergedOutput.blocking_issues) {
      md += `- ${JSON.stringify(issue)}\n`;
    }
    md += '\n';
  }

  md += `---\n\n*由 ai-std3 prd-review stage 自动生成*\n`;
  return md;
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  // 0. 启动时检测 stop.signal
  if (checkStopSignal()) {
    gracefulStop(readStagesJson());
  }

  log.info('stage_start', `prd-review stage 启动，项目: ${projectRoot}`, {
    run_id:     runId,
    stage:      'prd-review',
    project:    projectRoot,
    started_at: startedAtStr,
  });

  // 1. 上游门闸
  let stagesObj = readStagesJson();
  if (!stagesObj) {
    log.error('stage_failed', 'stages.json 不存在，prd 尚未完成', {
      stage: 'prd-review', exit_code: 1, reason: 'stages.json missing', duration_ms: 0,
    });
    process.exit(1);
  }

  const prdStage = stagesObj.stages && stagesObj.stages.prd;

  // 门闸 1：prd.status=completed
  if (!prdStage || prdStage.status !== 'completed') {
    log.error('stage_failed', '上游门闸未满足：prd.status 不是 completed', {
      stage:    'prd-review',
      exit_code: 1,
      reason:   `prd.status=${prdStage ? prdStage.status : 'missing'}`,
      duration_ms: 0,
    });
    process.exit(1);
  }

  // 门闸 2：prd.validation.passed=true
  if (!prdStage.validation || !prdStage.validation.passed) {
    log.error('stage_failed', '上游门闸未满足：prd.validation.passed 不是 true', {
      stage: 'prd-review', exit_code: 1, reason: 'prd.validation.passed=false', duration_ms: 0,
    });
    process.exit(1);
  }

  // 门闸 3：prd.outputs.features[] 非空
  const allFeatures    = (prdStage.outputs && prdStage.outputs.features) || [];
  const clientTargets  = (prdStage.outputs && prdStage.outputs.client_targets) || [];

  if (!Array.isArray(allFeatures) || allFeatures.length === 0) {
    log.error('stage_failed', '上游门闸未满足：prd.outputs.features[] 为空', {
      stage: 'prd-review', exit_code: 1, reason: 'prd.outputs.features[] is empty', duration_ms: 0,
    });
    process.exit(1);
  }

  // 2. 检测 stop.signal（门闸通过后）
  if (checkStopSignal()) {
    gracefulStop(readStagesJson());
  }

  // 读取配置
  const { timeoutS, maxRetries, model, featureMaxParallel } = readConfig();
  const timeoutMs = timeoutS * 1000;

  // 3. hash 门控（整段跳过判断）
  const prdSpecPath       = path.join(projectRoot, 'docs', 'prd-spec.md');
  const currentPrdSpecHash = fileSha256(prdSpecPath);

  if (!forceRerun) {
    const prdReviewStage = stagesObj.stages && stagesObj.stages.prd_review;
    if (
      prdReviewStage &&
      prdReviewStage.status === 'completed' &&
      prdReviewStage.outputs &&
      prdReviewStage.outputs.decision === 'passed'
    ) {
      const storedSpecHash       = prdReviewStage.inputs && prdReviewStage.inputs.prd_spec_hash;
      const storedPerTargetHashes = (prdReviewStage.inputs && prdReviewStage.inputs.per_target_hashes) || {};

      const specHashHit = !!(currentPrdSpecHash && storedSpecHash && currentPrdSpecHash === storedSpecHash);
      log.info('hash_check', 'hash 门控：prd-spec.md', {
        file:          'prd-spec.md',
        stored_hash:   storedSpecHash || null,
        computed_hash: currentPrdSpecHash,
        hit:           specHashHit,
      });

      let allTargetHashesHit = specHashHit;
      for (const ct of clientTargets) {
        const prdFile    = path.join(projectRoot, 'docs', resolvePrdFileName(ct));
        const curHash    = fileSha256(prdFile);
        const storedHash = storedPerTargetHashes[ct];
        const hit        = !!(curHash && storedHash && curHash === storedHash);

        log.info('hash_check', `hash 门控：${ct} prd 文件`, {
          client_target: ct,
          file:          resolvePrdFileName(ct),
          stored_hash:   storedHash || null,
          computed_hash: curHash,
          hit,
          skip_agent:    hit,
        });

        if (!hit) allTargetHashesHit = false;
      }

      const outputFileExists = fs.existsSync(path.join(projectRoot, '.pipeline', 'prd-review-output.json'));
      const summaryExists    = fs.existsSync(path.join(projectRoot, '.pipeline', 'reports', 'prd-implementation-summary.md'));

      if (allTargetHashesHit && outputFileExists && summaryExists) {
        log.info('stage_skipped', 'prd-review hash 门控命中，跳过执行', {
          stage:     'prd-review',
          reason:    'prd_spec_hash and all per_target_hashes matched, output files exist',
          exit_code: 0,
        });
        process.exit(0);
      }
    }
  }

  // 4. bootstrap：初始化 stages.prd_review 骨架
  stagesObj = readStagesJson();
  const existingPrdReview = stagesObj.stages && stagesObj.stages.prd_review;

  if (!existingPrdReview) {
    if (!stagesObj.stages) stagesObj.stages = {};
    stagesObj.stages.prd_review = buildPrdReviewSkeleton({ status: 'started', startedAtStr });
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;

    const sp   = writeStagesJson(stagesObj);
    const stat = fs.statSync(sp);
    log.info('file_created', '已写入 stages.prd_review 骨架', {
      path: sp, size_bytes: stat.size, from_template: true,
    });
  } else {
    existingPrdReview.status     = 'running';
    existingPrdReview.started_at = startedAtStr;
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;

    const sp   = writeStagesJson(stagesObj);
    const stat = fs.statSync(sp);
    log.info('file_updated', '已更新 stages.prd_review（status=running）', {
      path: sp, size_bytes: stat.size, status: 'running',
    });
  }

  // 写 status=running（独立写入，与骨架初始化分开）
  stagesObj = readStagesJson();
  stagesObj.stages.prd_review.status = 'running';
  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = formatLocalTimeShort();
  {
    const sp   = writeStagesJson(stagesObj);
    const stat = fs.statSync(sp);
    log.info('file_updated', '已写 prd-review status=running', {
      path: sp, size_bytes: stat.size, status: 'running',
    });
  }

  log.info('hash_check', 'prd-spec.md 哈希已计算', {
    file:          'prd-spec.md',
    stored_hash:   null,
    computed_hash: currentPrdSpecHash,
    hit:           false,
  });

  // 5. 检测 stop.signal（Agent 批次启动前）
  if (checkStopSignal()) {
    gracefulStop(readStagesJson());
  }

  // 按端哈希门控：命中 + 上次 passed 的端跳过 Agent
  stagesObj = readStagesJson();
  const prdReview          = stagesObj.stages && stagesObj.stages.prd_review;
  const storedPerTargetHashes = (prdReview && prdReview.inputs && prdReview.inputs.per_target_hashes) || {};

  const toRunTargets   = [];
  const skippedTargets = [];

  for (const ct of clientTargets) {
    const prdFile    = path.join(projectRoot, 'docs', resolvePrdFileName(ct));
    const curHash    = fileSha256(prdFile);
    const storedHash = storedPerTargetHashes[ct];
    const outputFile = path.join(projectRoot, '.pipeline', `prd-review-${ct}.json`);

    let perTargetPassed = false;
    if (fs.existsSync(outputFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        perTargetPassed = !!(data.outputs && data.outputs.decision === 'passed');
      } catch (_) { /* */ }
    }

    const hashHit    = !!(curHash && storedHash && curHash === storedHash);
    const shouldSkip = !forceRerun && hashHit && fs.existsSync(outputFile) && perTargetPassed;

    log.info('hash_check', `按端哈希比对：${ct}`, {
      client_target: ct,
      file:          resolvePrdFileName(ct),
      stored_hash:   storedHash || null,
      computed_hash: curHash,
      hit:           hashHit,
      skip_agent:    shouldSkip,
    });

    if (shouldSkip) {
      skippedTargets.push(ct);
    } else {
      toRunTargets.push(ct);
    }
  }

  // 6. 并发 Agent 批次
  const batchId = 'prd-review-agents';
  log.info('agent_batch_start', `prd-review Agent 批次开始，共 ${clientTargets.length} 端`, {
    batch_id:       batchId,
    stage:          'prd-review',
    client_targets: toRunTargets,
    agents_total:   clientTargets.length,
    agents_skipped: skippedTargets,
  });

  for (const ct of skippedTargets) {
    log.info('agent_skipped', `Agent(${ct}) 跳过：per_target_hash 命中`, {
      agent_id:      `prd-review-agent-${ct}`,
      client_target: ct,
      reason:        'per_target_hash matched',
    });
  }

  const batchT0 = Date.now();
  let failedTargets  = [];
  let timedOutExists = false;

  if (toRunTargets.length > 0) {
    const { results, timedOutExists: tOut } = await runAgentsConcurrent({
      clientTargets: toRunTargets,
      model, timeoutMs, maxRetries, featureMaxParallel,
      allFeatures,
    });
    timedOutExists = tOut;

    for (const r of results) {
      if (r.stopped) {
        gracefulStop(readStagesJson());
      }
      if (!r.success) {
        failedTargets.push(r.clientTarget);
      }
    }
  }

  const batchDurationMs  = Date.now() - batchT0;
  const succeededTargets = clientTargets.filter(ct => !failedTargets.includes(ct));

  log.info('agent_batch_complete', 'prd-review Agent 批次结束', {
    batch_id:         batchId,
    agents_succeeded: succeededTargets,
    agents_failed:    failedTargets,
    agents_skipped:   skippedTargets,
    duration_ms:      batchDurationMs,
  });

  if (failedTargets.length > 0) {
    const dms = Date.now() - startedAt.getTime();
    stagesObj = readStagesJson();
    if (!stagesObj.stages.prd_review) stagesObj.stages.prd_review = {};
    stagesObj.stages.prd_review.status          = 'failed';
    stagesObj.stages.prd_review.blocking_issues = failedTargets.map(ct => `Agent failed for client_target=${ct}`);
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stagesObj);

    const exitCode = timedOutExists ? 3 : 4;
    log.error('stage_failed', `prd-review stage 失败，${failedTargets.length} 个端失败`, {
      stage:                'prd-review',
      step:                 'agent-review',
      exit_code:            exitCode,
      reason:               `failed client_targets: ${failedTargets.join(', ')}`,
      failed_client_target: failedTargets.join(', '),
      duration_ms:          dms,
    });
    process.exit(exitCode);
  }

  // 7. 合并并校验
  const mergeResult = mergeClientOutputs({ clientTargets, allFeatures });

  if (!mergeResult.success) {
    const dms = Date.now() - startedAt.getTime();
    stagesObj = readStagesJson();
    if (!stagesObj.stages.prd_review) stagesObj.stages.prd_review = {};
    stagesObj.stages.prd_review.status = 'failed';
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stagesObj);

    log.error('stage_failed', `prd-review 合并失败: ${mergeResult.reason}`, {
      stage: 'prd-review', step: 'merge', exit_code: 4,
      reason: mergeResult.reason, duration_ms: dms,
    });
    process.exit(4);
  }

  const { mergedOutput, overallDecision } = mergeResult;

  // 全局 schema 校验
  const { valid: outputValid, errors: outputErrors } = validateJson(mergedOutput, 'prd-review-output.schema.json');
  if (!outputValid) {
    const errStr = outputErrors.map(e => e.instancePath + ' ' + e.message).join('; ');
    log.error('validation_fail', '全局 schema 校验失败', {
      missing: [], invalid: [errStr],
      schema:  'prd-review-output.schema.json',
    });

    const dms = Date.now() - startedAt.getTime();
    stagesObj = readStagesJson();
    if (!stagesObj.stages.prd_review) stagesObj.stages.prd_review = {};
    stagesObj.stages.prd_review.status = 'failed';
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stagesObj);

    log.error('stage_failed', 'prd-review-output.json schema 校验失败', {
      stage: 'prd-review', step: 'validate-output-schema', exit_code: 4,
      reason: errStr, duration_ms: dms,
    });
    process.exit(4);
  }

  // 覆盖门闸校验
  const coverageResult = validateCoverage({ allFeatures, mergedOutput });
  if (!coverageResult.passed) {
    const dms = Date.now() - startedAt.getTime();
    stagesObj = readStagesJson();
    if (!stagesObj.stages.prd_review) stagesObj.stages.prd_review = {};
    stagesObj.stages.prd_review.status = 'failed';
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stagesObj);

    log.error('stage_failed', '覆盖门闸校验失败', {
      stage: 'prd-review', step: 'coverage-gate', exit_code: 4,
      reason: `uncovered: ${coverageResult.uncovered.join(', ')}`,
      duration_ms: dms,
    });
    process.exit(4);
  }

  // 写 prd-review-output.json
  const pipelineDir    = path.join(projectRoot, '.pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const outputFilePath = path.join(pipelineDir, 'prd-review-output.json');
  fs.writeFileSync(outputFilePath, JSON.stringify(mergedOutput, null, 2) + '\n', 'utf8');

  const mergedFrom = clientTargets.map(ct => path.join(pipelineDir, `prd-review-${ct}.json`));
  log.info('file_created', '已写入 prd-review-output.json', {
    path:        outputFilePath,
    merged_from: mergedFrom,
  });

  // 各端决策汇总
  const perTargetDecisions = {};
  for (const ct of clientTargets) {
    const f = path.join(pipelineDir, `prd-review-${ct}.json`);
    if (fs.existsSync(f)) {
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        perTargetDecisions[ct] = (data.outputs && data.outputs.decision) || 'unknown';
      } catch (_) { perTargetDecisions[ct] = 'unknown'; }
    }
  }

  // 校验结论日志
  if (overallDecision === 'passed') {
    log.info('validation_pass', '校验通过', {
      decision:            'passed',
      phase_plan_phases:   mergedOutput.review.phase_plan.map(p => p.phase),
      features_in_plan:    mergedOutput.review.phase_plan.reduce((s, p) => s + p.feature_ids.length, 0),
      features_deferred:   mergedOutput.review.deferred_features.length,
      per_target_decisions: perTargetDecisions,
    });
  } else {
    log.error('validation_fail', '评审决策为 failed', {
      missing: [], invalid: ['overall decision=failed'],
    });
  }

  // 生成 prd-implementation-summary.md
  const reportsDir  = path.join(pipelineDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const summaryPath = path.join(reportsDir, 'prd-implementation-summary.md');
  const summaryContent = generateImplementationSummary({ mergedOutput, clientTargets });
  fs.writeFileSync(summaryPath, summaryContent, 'utf8');

  log.info('file_created', '已生成 prd-implementation-summary.md', { path: summaryPath });

  // 计算最终哈希（写入 stages.json）
  const finalPrdSpecHash     = fileSha256(prdSpecPath);
  const finalPerTargetHashes = {};
  for (const ct of clientTargets) {
    finalPerTargetHashes[ct] = fileSha256(path.join(projectRoot, 'docs', resolvePrdFileName(ct)));
  }

  // 构建 client_results
  const clientResults = {};
  for (const ct of clientTargets) {
    const f = path.join(pipelineDir, `prd-review-${ct}.json`);
    let ctDecision   = 'unknown';
    let issuesCount  = 0;
    if (fs.existsSync(f)) {
      try {
        const data  = JSON.parse(fs.readFileSync(f, 'utf8'));
        ctDecision  = (data.outputs && data.outputs.decision) || 'unknown';
        issuesCount = (data.review && Array.isArray(data.review.blocking_issues))
          ? data.review.blocking_issues.length
          : 0;
      } catch (_) { /* */ }
    }
    clientResults[ct] = {
      decision:    ctDecision,
      issues_count: issuesCount,
      output_file: f,
    };
  }

  // 写完成态
  const completedAt    = new Date();
  const completedAtStr = formatLocalTimeShort(completedAt);
  const durationMs     = completedAt.getTime() - startedAt.getTime();
  const currentPhase   = mergedOutput.review.phase_plan.length > 0
    ? mergedOutput.review.phase_plan[0].phase
    : null;

  stagesObj = readStagesJson();
  if (stagesObj.pipeline) {
    stagesObj.pipeline.current_stage        = 'prd-review';
    stagesObj.pipeline.last_completed_stage = 'prd-review';
    stagesObj.pipeline.updated_at           = completedAtStr;
  }

  stagesObj.stages.prd_review = Object.assign(stagesObj.stages.prd_review || {}, {
    status:       overallDecision === 'passed' ? 'completed' : 'failed',
    started_at:   startedAtStr,
    completed_at: completedAtStr,
    inputs: {
      prd_spec_hash:     finalPrdSpecHash,
      requires_stage:    'prd',
      source_prd_spec:   prdSpecPath,
      feature_index_ref: 'stages.prd.outputs.features',
      per_target_hashes: finalPerTargetHashes,
    },
    outputs: {
      decision:         overallDecision,
      can_enter_design: overallDecision === 'passed',
      current_phase:    currentPhase,
      client_results:   clientResults,
      merged_output:    outputFilePath,
      duration_ms:      durationMs,
      timed_out:        false,
      timeout_reason:   null,
    },
    review: {
      summary:                    mergedOutput.review.summary,
      phase_plan:                 mergedOutput.review.phase_plan,
      deferred_features:          mergedOutput.review.deferred_features,
      priority_changes:           [],
      cross_phase_dependencies:   [],
      config_change_suggestions:  { dev: [], release: [] },
      suggested_prd_spec_changes: mergedOutput.review.suggested_prd_spec_changes || [],
    },
    blocking_issues: mergedOutput.blocking_issues,
    conditions:      mergedOutput.conditions,
    validation: {
      passed:                  overallDecision === 'passed',
      checked_at:              completedAtStr,
      summary:                 null,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    },
    generated_files: [outputFilePath, summaryPath],
    git_sync: (stagesObj.stages.prd_review && stagesObj.stages.prd_review.git_sync) || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  });

  const sp   = writeStagesJson(stagesObj);
  const stat = fs.statSync(sp);
  log.info('file_updated', '已写 prd-review 完成态', {
    path:               sp,
    size_bytes:         stat.size,
    status:             overallDecision === 'passed' ? 'completed' : 'failed',
    prd_spec_hash:      finalPrdSpecHash,
    per_target_hashes:  finalPerTargetHashes,
    current_phase:      currentPhase,
  });

  if (overallDecision === 'passed') {
    log.info('stage_complete', `prd-review stage 完成，耗时 ${durationMs}ms`, {
      stage:                   'prd-review',
      duration_ms:             durationMs,
      exit_code:               0,
      decision:                overallDecision,
      phase_count:             mergedOutput.review.phase_plan.length,
      client_targets_reviewed: clientTargets,
    });
    process.exit(0);
  } else {
    log.error('stage_failed', 'prd-review stage 失败：评审决策为 failed', {
      stage:       'prd-review',
      step:        'decision',
      exit_code:   4,
      reason:      'overall decision=failed',
      duration_ms: durationMs,
    });
    process.exit(4);
  }
}

main().catch(err => {
  console.error(`[FATAL] prd-review.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

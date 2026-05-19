'use strict';

/**
 * create-ui-scenarios.cjs — create-ui-scenarios stage 编排入口
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. 读取配置；若 ui_e2e.enabled=false → 整段 skipped，exit 0
 *   2. 上游门闸：stages.design_review.outputs.can_enter_codegen=true → exit 1
 *   3. 检测 stop.signal → exit 5
 *   --bootstrap 模式：
 *     4. 计算 release_bundle_hash，门控判断整体跳过（exit 0 if skipped）
 *     5. 初始化 stages.create_ui_scenarios 骨架，写 stages.json
 *   --tick 模式：
 *     4. 若 bootstrap 未完成则先执行 bootstrap
 *     5. 检测 stop.signal → exit 5
 *     6. 调度就绪 feature Agent（受 effective_parallel 限制）
 *     7. 校验 YAML，写回 stages.json，exit 0
 *   --feature=<id> 模式：同 tick，但只调度指定 feature
 *   批量模式（无 --tick / --bootstrap）：bootstrap + loop tick + validate
 *   → exit 0 成功 / exit 1 门闸 / exit 3 超时 / exit 4 质量门失败 / exit 5 stop.signal
 *
 * 参数：
 *   --project=<路径>       业务项目根（绝对或相对）
 *   --run-id=<id>          run_id（由 run-pipeline 传入；缺失时自动生成）
 *   --bootstrap            执行 bootstrap 步骤
 *   --tick                 执行 tick 步骤（复合编排调用，单轮调度后 exit 0）
 *   --feature=<feature_id> 只处理指定 feature
 *   --force-rerun          跳过 hash 门控，强制重跑
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { createPipelinePaths } = require('../libs/pipeline-paths.cjs');
const { createLogger, formatLocalTimeShort } = require('../libs/logger.cjs');
const { createStagesJsonWriteQueue } = require('../libs/stages-json-write-queue.cjs');

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
const paths = createPipelinePaths(projectRoot);

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
const log = createLogger({ projectRoot, stage: 'create-ui-scenarios', runId });

// ── 工具函数 ──────────────────────────────────────────────────────
/** 计算文件 SHA-256 hex；文件不存在返回 null */
function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 读取 stages.json；不存在或解析失败返回 null */
function readStagesJson() {
  return paths.readStagesJson();
}

/** 写 stages.json（原子覆盖） */
function writeStagesJson(obj) {
  return paths.writeStagesJson(obj);
}

function checkStopSignal() {
  return fs.existsSync(paths.stopSignalPath);
}

function getStopReason() {
  try {
    return JSON.parse(fs.readFileSync(paths.stopSignalPath, 'utf8')).reason || 'unknown';
  } catch (_) { return 'unknown'; }
}

/** 优雅停止：写日志 + stages.json + 删 stop.signal + exit 5 */
function gracefulStop(stagesObj) {
  const stoppedAt = formatLocalTimeShort();
  const reason    = getStopReason();

  log.info('pipeline_stop', '检测到 stop.signal，开始优雅停止', {
    stage: 'create-ui-scenarios', reason, stopped_at: stoppedAt,
  });

  if (stagesObj && stagesObj.stages) {
    if (!stagesObj.stages.create_ui_scenarios) {
      stagesObj.stages.create_ui_scenarios = { status: 'stopped' };
    } else {
      stagesObj.stages.create_ui_scenarios.status = 'stopped';
    }
    if (stagesObj.pipeline) {
      stagesObj.pipeline.updated_at = stoppedAt;
      stagesObj.pipeline.stop_info  = { stopped_at: stoppedAt, stopped_stage: 'create-ui-scenarios', reason };
    }
    writeStagesJson(stagesObj);
  }

  try {
    const sig = paths.stopSignalPath;
    if (fs.existsSync(sig)) fs.unlinkSync(sig);
  } catch (_) { /* ignore */ }

  log.info('pipeline_stopped', 'create-ui-scenarios stage 已优雅停止', {
    stage: 'create-ui-scenarios', stopped_at: stoppedAt, exit_code: 5,
  });
  process.exit(5);
}

// ── 读取配置 ──────────────────────────────────────────────────────
function readConfig() {
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { /* */ }
  }

  // ui_e2e.enabled 取自 pipeline.stages.ui_e2e.enabled，默认 true
  const ui_e2e_stage = cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.ui_e2e;
  const ui_e2e_enabled = ui_e2e_stage ? ui_e2e_stage.enabled !== false : true;

  const timeoutS       = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.create_ui_scenarios_s) || 600;
  const maxRetries     = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.create_ui_scenarios && cfg.pipeline.stages.create_ui_scenarios.max_retries) || 2;
  const model          = (cfg.pipeline && cfg.pipeline.model) || 'composer-2';
  const stageParallel  = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.create_ui_scenarios && cfg.pipeline.stages.create_ui_scenarios.feature_max_parallel) || 3;
  const globalParallel = (cfg.pipeline && cfg.pipeline.autorun && cfg.pipeline.autorun.feature_max_parallel) || 3;
  const effectiveParallel = Math.min(stageParallel, globalParallel);
  const maxScenariosPerFeature = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.create_ui_scenarios && cfg.pipeline.stages.create_ui_scenarios.max_scenarios_per_feature) || 10;

  return { ui_e2e_enabled, timeoutS, maxRetries, model, effectiveParallel, maxScenariosPerFeature };
}

// ── Ajv 校验 ──────────────────────────────────────────────────────
let _ajv = null;
/** @type {import('ajv').ValidateFunction | null} */
let _uiScenariosValidate = null;

function getAjv() {
  if (_ajv) return _ajv;
  try {
    const Ajv = require('ajv');
    _ajv = new Ajv({ allErrors: true, strict: false });
    try { require('ajv-formats')(_ajv); } catch (_) { /* optional */ }
  } catch (_) { return null; }
  return _ajv;
}

/** 缓存 compile 结果，避免同一 $id schema 重复 ajv.compile 抛 already exists */
function getUiScenariosValidator() {
  if (_uiScenariosValidate) return _uiScenariosValidate;
  const schema = loadSchema('ui-scenarios.yaml.schema.json');
  if (!schema) return null;
  const ajv = getAjv();
  if (!ajv) return null;
  const schemaId = schema.$id || 'ui-scenarios.yaml.schema.json';
  const existing = ajv.getSchema(schemaId);
  if (existing) {
    _uiScenariosValidate = existing;
    return _uiScenariosValidate;
  }
  _uiScenariosValidate = ajv.compile(schema);
  return _uiScenariosValidate;
}

function loadSchema(schemaName) {
  const p = path.join(skillsRoot, 'ai-std4', 'schemas', schemaName);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/**
 * YAML 解析 + schema 校验（两步）
 * 返回 { valid, errors, parsedData }
 */
function validateScenariosYaml(filePath) {
  // Step 1: YAML 解析
  let parsedData;
  try {
    const yaml    = require('js-yaml');
    const content = fs.readFileSync(filePath, 'utf8');
    parsedData    = yaml.load(content);
  } catch (e) {
    return { valid: false, errors: [`YAML parse error: ${e.message}`], parsedData: null };
  }

  if (!parsedData || typeof parsedData !== 'object') {
    return { valid: false, errors: ['YAML did not produce an object'], parsedData: null };
  }

  // Step 2: Ajv schema 校验
  try {
    const validate = getUiScenariosValidator();
    if (!validate) return { valid: true, errors: [], parsedData };
    const valid    = validate(parsedData);
    return {
      valid,
      errors: (validate.errors || []).map(e => `${e.instancePath} ${e.message}`),
      parsedData,
    };
  } catch (e) {
    return { valid: false, errors: [`Ajv error: ${e.message}`], parsedData };
  }
}

// ── UI feature 检测 ────────────────────────────────────────────────
const UI_CLIENT_TARGETS = new Set(['website', 'web', 'mobile', 'admin', 'ios', 'android']);

/** 如果 client_targets 中有任意 UI 端则返回 true */
function isUiFeature(clientTargets) {
  if (!Array.isArray(clientTargets) || clientTargets.length === 0) return true; // 默认视为 UI
  return clientTargets.some(ct => UI_CLIENT_TARGETS.has(ct));
}

// ── hash 计算 ──────────────────────────────────────────────────────
/**
 * release_bundle_hash：对 design_review.features 中 can_enter_codegen=true 的 feature
 * 按字典序排列，取各自 design.json SHA-256，再做 hash-of-hashes
 */
function computeReleaseBundleHash(drFeatures) {
  if (!drFeatures || Object.keys(drFeatures).length === 0) return null;
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
 * design_bundle_hash：对 design.features 中 status=completed 的 feature
 * 按字典序排列，取各自 design.json SHA-256，再做 hash-of-hashes
 */
function computeDesignBundleHash(designFeatures) {
  if (!designFeatures || Object.keys(designFeatures).length === 0) return null;
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

// ── Bootstrap ────────────────────────────────────────────────────
async function doBootstrap(stagesObj, config) {
  const startedAtStr = formatLocalTimeShort();

  const drStage    = stagesObj.stages && stagesObj.stages.design_review;
  const drFeatures = (drStage && drStage.features) || {};
  const prdFeatures = (stagesObj.stages && stagesObj.stages.prd && stagesObj.stages.prd.outputs && stagesObj.stages.prd.outputs.features) || [];
  const prdFeatureMap = new Map(prdFeatures.map(f => [f.feature_id, f]));

  // 目标 feature：design_review.features 中 can_enter_codegen=true
  const targetFeatureIds = Object.keys(drFeatures)
    .filter(fid => drFeatures[fid] && drFeatures[fid].can_enter_codegen === true)
    .sort();

  // 计算 hash
  const designStage       = stagesObj.stages && stagesObj.stages.design;
  const designFeatures    = (designStage && designStage.features) || {};
  const releaseBundleHashNew = computeReleaseBundleHash(drFeatures);
  const designBundleHashNew  = computeDesignBundleHash(designFeatures);

  const existingCUS = stagesObj.stages && stagesObj.stages.create_ui_scenarios;

  // hash 门控（整段跳过）
  if (!forceRerun && existingCUS && existingCUS.status === 'completed') {
    const storedReleaseBundleHash = existingCUS.inputs && existingCUS.inputs.design_review_hash;
    const allTargetDone = targetFeatureIds.every(fid => {
      const fs_ = existingCUS.features && existingCUS.features[fid];
      return fs_ && (fs_.status === 'completed' || fs_.status === 'skipped' || fs_.status === 'failed');
    });

    if (releaseBundleHashNew && storedReleaseBundleHash
        && releaseBundleHashNew === storedReleaseBundleHash
        && allTargetDone) {
      log.info('stage_skipped', 'create-ui-scenarios hash 门控命中，跳过整段执行', {
        stage: 'create-ui-scenarios',
        reason: 'release_bundle_hash matched, all scenarios fresh',
        exit_code: 0,
      });
      process.exit(0);
    }
  }

  // hash_check 日志
  log.info('hash_check', '计算 release_bundle_hash', {
    release_bundle_hash:  releaseBundleHashNew,
    design_bundle_hash:   designBundleHashNew,
    stored_hash:          (existingCUS && existingCUS.inputs && existingCUS.inputs.design_review_hash) || null,
    computed_hash:        releaseBundleHashNew,
    hit:                  false,
  });

  const existingFeatures  = (existingCUS && existingCUS.features) || {};
  const zombieResetList   = [];
  const newFeaturesAdded  = [];
  const skippedFeatureIds = [];
  const pendingFeatureIds = [];

  const features = {};

  for (const fid of targetFeatureIds) {
    const existing      = existingFeatures[fid];
    const prdMeta       = prdFeatureMap.get(fid);
    const clientTargets = (prdMeta && prdMeta.client_targets) || [];
    const hasUiTarget   = isUiFeature(clientTargets);

    // group_id 取自 design_review.features.<id>.group_id（若有）
    const groupId = (drFeatures[fid] && drFeatures[fid].group_id) || null;

    if (!hasUiTarget) {
      // 纯 backend feature → 确定性预检直接 skipped
      features[fid] = Object.assign({}, existing || {}, {
        status:          'skipped',
        skip_reason:     'no_ui_client_target',
        group_id:        groupId,
        started_at:      null,
        completed_at:    startedAtStr,
        attempts:        0,
        scenario_file:   null,
        scenario_hash:   null,
        scenarios_count: 0,
        design_hash:     null,
        error:           null,
      });
      skippedFeatureIds.push(fid);
    } else if (!existing) {
      features[fid] = {
        status:          'pending',
        skip_reason:     null,
        group_id:        groupId,
        started_at:      null,
        completed_at:    null,
        attempts:        0,
        scenario_file:   null,
        scenario_hash:   null,
        scenarios_count: 0,
        design_hash:     null,
        error:           null,
      };
      newFeaturesAdded.push(fid);
      pendingFeatureIds.push(fid);
    } else if (existing.status === 'running') {
      // zombie 恢复
      features[fid] = Object.assign({}, existing, {
        status:   'pending',
        group_id: groupId || existing.group_id,
      });
      zombieResetList.push(fid);
      pendingFeatureIds.push(fid);
    } else {
      features[fid] = Object.assign({ scenarios_count: 0 }, existing, { group_id: groupId || existing.group_id });
      if (existing.status === 'skipped') skippedFeatureIds.push(fid);
      else if (existing.status === 'pending') pendingFeatureIds.push(fid);
    }
  }

  log.info('validation_pass', '确定性预检完成', {
    pending_feature_ids:  pendingFeatureIds,
    skipped_feature_ids:  skippedFeatureIds,
    blocking_feature_ids: [],
  });

  // 写入 stages.create_ui_scenarios
  if (!stagesObj.stages) stagesObj.stages = {};

  const existingOutputs = (existingCUS && existingCUS.outputs) || {};
  stagesObj.stages.create_ui_scenarios = {
    status:       'running',
    started_at:   (existingCUS && existingCUS.started_at) || startedAtStr,
    completed_at: null,
    inputs: {
      design_review_hash: releaseBundleHashNew,
      design_bundle_hash: designBundleHashNew,
      design_hashes: Object.fromEntries(
        targetFeatureIds.map(fid => {
          const p = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
          return [fid, fileSha256(p)];
        })
      ),
    },
    outputs: {
      scenario_files:   existingOutputs.scenario_files   || {},
      skipped_features: skippedFeatureIds,
      failed_features:  existingOutputs.failed_features  || [],
      duration_ms:      null,
      timed_out:        false,
      timeout_reason:   null,
      decision:         existingOutputs.decision          || 'pending',
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
    generated_files: [],
    blocking_issues: [],
    git_sync: (existingCUS && existingCUS.git_sync) || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  };

  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;
  const sp   = writeStagesJson(stagesObj);
  const stat = fs.statSync(sp);

  log.info('file_updated', '已写 stages.create_ui_scenarios bootstrap 骨架', {
    path:                  sp,
    size_bytes:            stat.size,
    status:                'running',
    zombie_features_reset: zombieResetList,
    new_features_added:    newFeaturesAdded,
    effective_parallel:    config.effectiveParallel,
  });

  return { targetFeatureIds, pendingFeatureIds, skippedFeatureIds };
}

// ── Agent 调用 ────────────────────────────────────────────────────
async function invokeScenariosAgent({ featureId, featureMeta, stagesObj, model, timeoutMs }) {
  const agentId    = `create-ui-scenarios-agent-${featureId}`;
  const promptFile = 'create-ui-scenarios.md';
  const promptPath = path.join(skillsRoot, 'ai-std4', 'prompts', promptFile);

  if (!fs.existsSync(promptPath)) {
    return { success: false, timedOut: false, error: `Prompt file not found: ${promptPath}`, agentRunId: null };
  }

  let promptContent = fs.readFileSync(promptPath, 'utf8');

  const designFile = path.join(projectRoot, 'docs', 'designs', `${featureId}.design.json`);
  const outputDir  = path.join(projectRoot, 'docs', 'ui-scenarios');
  const outputFile = path.join(outputDir, `${featureId}.scenarios.yaml`);
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');

  fs.mkdirSync(outputDir, { recursive: true });

  const ctx = [
    `<!-- inject: feature_id=${featureId} -->`,
    `<!-- inject: project_root=${projectRoot} -->`,
    `<!-- inject: output_file=${outputFile} -->`,
    `<!-- inject: design_file=${designFile} -->`,
  ].join('\n');

  const finalPrompt = promptContent + '\n\n' + ctx;

  const inputFiles = [designFile, configPath].filter(f => fs.existsSync(f));
  log.info('agent_start', `启动 create-ui-scenarios Agent: ${agentId}`, {
    agent_id:     agentId,
    feature_id:   featureId,
    prompt:       promptFile,
    input_files:  inputFiles,
    client_target: (featureMeta && featureMeta.client_targets) || [],
    model,
  });

  let agentRunId = null;
  try {
    const { Agent } = require('@cursor/sdk');
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      return { success: false, timedOut: false, error: 'CURSOR_API_KEY not set', agentRunId: null };
    }

    const runPromise = (async () => {
      const agent = await Agent.create({ apiKey, model: { id: model || 'composer-2' }, local: { cwd: projectRoot } });
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
        return {
          success: result.status === 'finished',
          error: result.status !== 'finished' ? `Agent status: ${result.status}` : null,
        };
      } finally {
        if (typeof agent[Symbol.asyncDispose] === 'function') await agent[Symbol.asyncDispose]();
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
    return { success: false, timedOut: false, error: err && err.message ? err.message : String(err), agentRunId };
  }
}

// ── 单 feature Agent（带重试 + schema 校验）──────────────────────
async function runScenariosAgentForFeature({ featureId, featureMeta, stagesObj, model, timeoutMs, maxRetries }) {
  const agentId    = `create-ui-scenarios-agent-${featureId}`;
  const outputFile = path.join(projectRoot, 'docs', 'ui-scenarios', `${featureId}.scenarios.yaml`);

  let lastError = null;
  let timedOut  = false;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      log.warn('agent_retry', `create-ui-scenarios Agent(${featureId}) 第 ${attempt} 次重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
    }

    const t0     = Date.now();
    const result = await invokeScenariosAgent({ featureId, featureMeta, stagesObj, model, timeoutMs });
    const dms    = Date.now() - t0;

    if (result.timedOut) {
      timedOut  = true;
      lastError = result.error;
      log.error('agent_failed', `create-ui-scenarios Agent(${featureId}) 超时`, {
        agent_id:     agentId,
        feature_id:   featureId,
        max_attempts: maxRetries + 1,
        last_error:   result.error,
        exit_code:    3,
        timed_out:    true,
      });
      return { success: false, timedOut: true, featureId, error: result.error, durationMs: dms };
    }

    if (!result.success) {
      lastError = result.error;
      if (attempt > maxRetries) break;
      continue;
    }

    // 输出文件存在校验
    if (!fs.existsSync(outputFile)) {
      lastError = `Output file not found: ${outputFile}`;
      if (attempt > maxRetries) break;
      log.warn('agent_retry', `create-ui-scenarios Agent(${featureId}) 输出文件缺失，重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
      continue;
    }

    // YAML 解析 + schema 校验（两步）
    const { valid, errors, parsedData } = validateScenariosYaml(outputFile);
    if (!valid) {
      const invalidFields = errors.join('; ');
      lastError = `Schema validation failed: ${invalidFields}`;
      log.warn('agent_retry', `create-ui-scenarios Agent(${featureId}) YAML schema 校验失败，重试`, {
        agent_id:      agentId,
        feature_id:    featureId,
        attempt,
        reason:        'schema_validation_failed',
        invalid_fields: invalidFields,
      });
      if (attempt > maxRetries) break;
      continue;
    }

    // 成功
    const scenarioHash   = fileSha256(outputFile);
    const designHash     = fileSha256(path.join(projectRoot, 'docs', 'designs', `${featureId}.design.json`));
    const scenariosCount = (parsedData && Array.isArray(parsedData.scenarios)) ? parsedData.scenarios.length : 0;

    log.info('agent_complete', `create-ui-scenarios Agent(${featureId}) 完成`, {
      agent_id:        agentId,
      feature_id:      featureId,
      duration_ms:     dms,
      scenarios_count: scenariosCount,
      output_files:    [`ui-scenarios/${featureId}.scenarios.yaml`],
    });

    log.info('feature_scenarios_ready', `feature ${featureId} 场景就绪`, {
      feature_id:      featureId,
      group_id:        null,
      scenarios_count: scenariosCount,
      scenarios_hash:  scenarioHash,
    });

    return {
      success:        true,
      timedOut:       false,
      featureId,
      scenarioHash,
      designHash,
      scenariosCount,
      outputFile,
      durationMs:     dms,
      error:          null,
    };
  }

  log.error('agent_failed', `create-ui-scenarios Agent(${featureId}) 超过最大重试次数`, {
    agent_id:     agentId,
    feature_id:   featureId,
    max_attempts: maxRetries + 1,
    last_error:   lastError,
    exit_code:    4,
  });
  return { success: false, timedOut, featureId, error: lastError, durationMs: 0 };
}

// ── 并发 Worker Pool ──────────────────────────────────────────────
async function runAgentsConcurrent({ readyFeatureIds, featureMetaMap, stagesObj, config, progress }) {
  const { effectiveParallel, model, timeoutS, maxRetries } = config;
  const timeoutMs  = timeoutS * 1000;
  const results    = [];
  let index        = 0;
  let stoppedFound = false;

  async function worker() {
    while (index < readyFeatureIds.length) {
      const fid = readyFeatureIds[index++];

      if (checkStopSignal()) {
        results.push({ success: false, timedOut: false, featureId: fid, stopped: true, error: 'stop.signal' });
        stoppedFound = true;
        continue;
      }

      const featureMeta = featureMetaMap.get(fid);
      const result = await runScenariosAgentForFeature({
        featureId: fid, featureMeta, stagesObj, model, timeoutMs, maxRetries,
      });
      if (progress && !result.stopped) {
        const completedAtStr = formatLocalTimeShort();
        if (result.success) {
          await progress.patchFeature('create_ui_scenarios', fid, {
            status:           'completed',
            completed_at:     completedAtStr,
            scenario_file:    result.outputFile,
            scenario_hash:    result.scenarioHash,
            scenarios_count:  result.scenariosCount || 0,
            design_hash:      result.designHash,
            skip_reason:      null,
            error:            null,
          });
        } else {
          await progress.patchFeature('create_ui_scenarios', fid, {
            status:       'failed',
            error:        result.error || null,
            completed_at: completedAtStr,
          });
        }
      }
      results.push(result);
    }
  }

  const concurrency = Math.max(1, Math.min(effectiveParallel, readyFeatureIds.length));
  const workers     = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return { results, stoppedFound };
}

// ── tick：单轮调度 ────────────────────────────────────────────────
async function doTick(stagesObj, config, featureFilterId) {
  // 若 bootstrap 未完成，先执行 bootstrap
  if (!stagesObj.stages || !stagesObj.stages.create_ui_scenarios) {
    log.info('file_updated', 'create-ui-scenarios stage 未 bootstrap，先执行 bootstrap', { status: 'bootstrapping' });
    await doBootstrap(stagesObj, config);
    stagesObj = readStagesJson();
  }

  const cus             = stagesObj.stages.create_ui_scenarios;
  const drStage         = stagesObj.stages.design_review;
  const drFeatures      = (drStage && drStage.features) || {};
  const featureStatuses = cus.features || {};
  const prdFeatures     = (stagesObj.stages && stagesObj.stages.prd && stagesObj.stages.prd.outputs && stagesObj.stages.prd.outputs.features) || [];
  const featureMetaMap  = new Map(prdFeatures.map(f => [f.feature_id, f]));

  // 所有目标 feature（can_enter_codegen=true）
  const allTargetIds = Object.keys(drFeatures)
    .filter(fid => drFeatures[fid] && drFeatures[fid].can_enter_codegen === true)
    .sort();

  const scopeIds = featureFilterId
    ? allTargetIds.filter(id => id === featureFilterId)
    : allTargetIds;

  // 找就绪 feature：pending 且非 skipped/completed/running
  const readyFeatureIds = [];

  for (const fid of scopeIds) {
    const featureStatus = featureStatuses[fid];
    if (!featureStatus) continue;

    const status = featureStatus.status;
    if (status === 'completed' || status === 'skipped' || status === 'running') continue;
    if (status !== 'pending' && status !== 'failed') continue;

    // design.json 必须存在（否则本轮跳过等待下一轮）
    const designFilePath = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    if (!fs.existsSync(designFilePath)) {
      log.info('agent_skipped', `feature ${fid} design.json 不存在，本轮跳过等待`, {
        agent_id:   `create-ui-scenarios-agent-${fid}`,
        feature_id: fid,
        reason:     'design.json not found, waiting',
      });
      continue;
    }

    // 单 feature hash 门控（对 pending/failed 状态）：
    // design.json hash 命中且 scenario file 存在且 hash 命中 → agent_skipped，直接标 completed
    if (!forceRerun) {
      const storedDesignHash    = featureStatus.design_hash;
      const storedScenarioHash  = featureStatus.scenario_hash;
      const currentDesignHash   = fileSha256(designFilePath);
      const scenarioFile        = path.join(projectRoot, 'docs', 'ui-scenarios', `${fid}.scenarios.yaml`);
      const currentScenarioHash = fileSha256(scenarioFile);

      if (storedDesignHash && currentDesignHash && storedDesignHash === currentDesignHash
          && storedScenarioHash && currentScenarioHash && storedScenarioHash === currentScenarioHash) {
        // hash 命中，直接标 completed，跳过 Agent
        featureStatuses[fid].status = 'completed';
        if (!featureStatuses[fid].completed_at) {
          featureStatuses[fid].completed_at = formatLocalTimeShort();
        }
        log.info('agent_skipped', `feature ${fid} scenarios_hash + design_hash 命中，跳过 Agent`, {
          agent_id:   `create-ui-scenarios-agent-${fid}`,
          feature_id: fid,
          reason:     'scenarios_hash + design_hash matched',
        });
        continue;
      }
    }

    readyFeatureIds.push(fid);
  }

  // 检查整体完成状态
  const allDone = scopeIds.every(fid => {
    const fs_ = featureStatuses[fid];
    if (!fs_) return false;
    return fs_.status === 'completed' || fs_.status === 'skipped' || fs_.status === 'failed';
  });

  if (readyFeatureIds.length === 0) {
    writeStagesJson(stagesObj);
    const hasFailed = scopeIds.some(fid => featureStatuses[fid] && featureStatuses[fid].status === 'failed');
    return { allDone, hasFailed, timedOutDetected: false };
  }

  // 批次启动
  const waveIndex = ((cus.inputs && cus.inputs._tick_wave_index) || 0) + 1;
  if (cus.inputs) cus.inputs._tick_wave_index = waveIndex;
  const batchId = `create-ui-scenarios-tick-${waveIndex}`;

  log.info('agent_batch_start', `create-ui-scenarios Agent 批次开始，共 ${readyFeatureIds.length} 个 feature`, {
    batch_id:           batchId,
    feature_ids:        readyFeatureIds,
    agents_total:       readyFeatureIds.length,
    agents_skipped:     [],
    effective_parallel: config.effectiveParallel,
  });

  // 标记 running
  const tickStartedAt = formatLocalTimeShort();
  for (const fid of readyFeatureIds) {
    if (!featureStatuses[fid]) featureStatuses[fid] = {};
    featureStatuses[fid].status     = 'running';
    featureStatuses[fid].started_at = featureStatuses[fid].started_at || tickStartedAt;
    featureStatuses[fid].attempts   = (featureStatuses[fid].attempts || 0) + 1;
  }
  writeStagesJson(stagesObj);

  const featureProgress = createStagesJsonWriteQueue(projectRoot, {
    touchUpdatedAt: formatLocalTimeShort,
  });

  // 并发执行 Agent
  const batchT0 = Date.now();
  const { results, stoppedFound } = await runAgentsConcurrent({
    readyFeatureIds, featureMetaMap, stagesObj, config, progress: featureProgress,
  });
  const batchDurationMs = Date.now() - batchT0;

  if (stoppedFound) {
    gracefulStop(readStagesJson());
  }

  // 处理结果
  stagesObj = readStagesJson();
  const cusFresh        = stagesObj.stages.create_ui_scenarios;
  const featuresFresh   = cusFresh.features || {};

  const succeededIds   = [];
  const failedIds      = [];
  let timedOutDetected = false;

  for (const r of results) {
    if (r.stopped) continue;
    const completedAtStr = formatLocalTimeShort();
    const fStatus        = featuresFresh[r.featureId] || {};

    if (r.success) {
      fStatus.status          = 'completed';
      fStatus.completed_at    = completedAtStr;
      fStatus.scenario_file   = r.outputFile;
      fStatus.scenario_hash   = r.scenarioHash;
      fStatus.scenarios_count = r.scenariosCount || 0;
      fStatus.design_hash     = r.designHash;
      fStatus.skip_reason     = null;
      fStatus.error           = null;

      if (!cusFresh.outputs.scenario_files) cusFresh.outputs.scenario_files = {};
      cusFresh.outputs.scenario_files[r.featureId] = r.outputFile;

      succeededIds.push(r.featureId);
    } else {
      if (r.timedOut) timedOutDetected = true;
      fStatus.status       = 'failed';
      fStatus.error        = r.error;
      fStatus.completed_at = completedAtStr;
      failedIds.push(r.featureId);

      if (!cusFresh.outputs.failed_features) cusFresh.outputs.failed_features = [];
      if (!cusFresh.outputs.failed_features.includes(r.featureId)) {
        cusFresh.outputs.failed_features.push(r.featureId);
      }
    }

    featuresFresh[r.featureId] = fStatus;
  }

  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = formatLocalTimeShort();
  writeStagesJson(stagesObj);

  // 批次结束日志
  const skippedInBatch = readyFeatureIds.filter(
    id => !succeededIds.includes(id) && !failedIds.includes(id)
  );
  log.info('agent_batch_complete', 'create-ui-scenarios Agent 批次结束', {
    batch_id:         batchId,
    agents_succeeded: succeededIds,
    agents_failed:    failedIds,
    agents_skipped:   skippedInBatch,
    duration_ms:      batchDurationMs,
  });

  // 重新检查完成状态
  const freshFeatureStatuses = stagesObj.stages.create_ui_scenarios.features || {};
  const allDoneNow = scopeIds.every(fid => {
    const fs_ = freshFeatureStatuses[fid];
    return fs_ && (fs_.status === 'completed' || fs_.status === 'skipped' || fs_.status === 'failed');
  });
  const hasFailed = scopeIds.some(
    fid => freshFeatureStatuses[fid] && freshFeatureStatuses[fid].status === 'failed'
  );

  return { allDone: allDoneNow, hasFailed, timedOutDetected };
}

// ── 步骤 3：validate + 写完成态 ──────────────────────────────────
async function doValidate(stagesObj, targetFeatureIds) {
  const cus             = stagesObj.stages.create_ui_scenarios;
  const featureStatuses = cus.features || {};
  const completedAtStr  = formatLocalTimeShort();
  const startedAt       = cus.started_at ? new Date(cus.started_at).getTime() : Date.now();

  const completedFeatures = targetFeatureIds.filter(
    fid => featureStatuses[fid] && featureStatuses[fid].status === 'completed'
  );
  const skippedFeatures = targetFeatureIds.filter(
    fid => featureStatuses[fid] && featureStatuses[fid].status === 'skipped'
  );
  const failedFeatures = targetFeatureIds.filter(
    fid => featureStatuses[fid] && featureStatuses[fid].status === 'failed'
  );

  cus.outputs.skipped_features = skippedFeatures;
  cus.outputs.failed_features  = failedFeatures;
  cus.outputs.duration_ms      = Date.now() - startedAt;

  // 生成摘要报告
  const reportsDir = path.join(paths.stageOutputDir('report'));
  fs.mkdirSync(reportsDir, { recursive: true });
  const summaryPath  = paths.stageSummaryPath('create-ui-scenarios', 'create-ui-scenarios-summary.md');
  const summaryLines = [
    '# create-ui-scenarios 阶段摘要',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 目标 feature 总数 | ${targetFeatureIds.length} |`,
    `| 已生成场景 feature | ${completedFeatures.length} |`,
    `| 跳过（非 UI） | ${skippedFeatures.length} |`,
    `| 失败 | ${failedFeatures.length} |`,
    '',
    '## Feature 详情',
    '',
    ...targetFeatureIds.map(fid => {
      const f = featureStatuses[fid];
      if (!f) return `- \`${fid}\`: 未知状态`;
      if (f.status === 'completed') return `- \`${fid}\`: ✓ 已生成（hash: ${(f.scenario_hash || '').substring(0, 8)}）`;
      if (f.status === 'skipped')   return `- \`${fid}\`: ↷ 跳过（${f.skip_reason || ''}）`;
      if (f.status === 'failed')    return `- \`${fid}\`: ✗ 失败（${f.error || '未知原因'}）`;
      return `- \`${fid}\`: ${f.status}`;
    }),
  ];
  fs.writeFileSync(summaryPath, summaryLines.join('\n') + '\n', 'utf8');

  // 全部失败时 → stage 失败（exit 4）
  const allFailed = failedFeatures.length > 0
    && completedFeatures.length === 0
    && skippedFeatures.length === 0;

  if (allFailed) {
    cus.status           = 'failed';
    cus.completed_at     = completedAtStr;
    cus.outputs.decision = 'failed';
    cus.validation       = {
      passed:                  false,
      checked_at:              completedAtStr,
      summary:                 `所有 feature 均失败：${failedFeatures.join(', ')}`,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    };
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;
    writeStagesJson(stagesObj);

    log.error('validation_fail', 'create-ui-scenarios validate 失败：全部 feature 均失败', {
      decision:           'failed',
      failed_feature_ids: failedFeatures,
      exit_code:          4,
    });
    log.error('stage_failed', 'create-ui-scenarios stage 验证失败', {
      stage:       'create-ui-scenarios',
      step:        'validate',
      exit_code:   4,
      reason:      `all ${failedFeatures.length} features failed`,
      duration_ms: cus.outputs.duration_ms,
    });
    process.exit(4);
  }

  // 部分成功或全部完成
  const decision = failedFeatures.length > 0 ? 'partial' : 'passed';

  cus.status           = 'completed';
  cus.completed_at     = completedAtStr;
  cus.outputs.decision = decision;
  cus.validation       = {
    passed:                  true,
    checked_at:              completedAtStr,
    summary:                 `${completedFeatures.length} 个 feature 完成，${skippedFeatures.length} 个跳过，${failedFeatures.length} 个失败`,
    required_files:          [],
    missing_required_fields: [],
    warnings:                [],
  };
  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;

  const sp   = writeStagesJson(stagesObj);
  const stat = fs.statSync(sp);

  log.info('validation_pass', 'create-ui-scenarios validate 通过', {
    decision,
    completed_features: completedFeatures.length,
    skipped_features:   skippedFeatures.length,
    failed_features:    failedFeatures.length,
  });
  log.info('file_updated', '已写 create-ui-scenarios 完成态', {
    path:                sp,
    size_bytes:          stat.size,
    status:              'completed',
    release_bundle_hash: cus.inputs && cus.inputs.design_review_hash,
  });
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  // 0. 启动时检测 stop.signal
  if (checkStopSignal()) gracefulStop(readStagesJson());

  log.info('stage_start', `create-ui-scenarios stage 启动 [${mode}]，项目: ${projectRoot}`, {
    run_id:         runId,
    stage:          'create-ui-scenarios',
    project:        projectRoot,
    started_at:     startedAtStr,
    mode,
    feature_filter: featureFilter || null,
    parallel_with:  ['codegen'],
  });

  // 1. 读取 stages.json
  let stagesObj = readStagesJson();

  // 2. 读取配置（config.dev.json 不存在时使用默认值）
  const config = readConfig();

  // 3. 检查 ui_e2e.enabled（整段跳过条件）
  if (!config.ui_e2e_enabled) {
    if (stagesObj) {
      if (!stagesObj.stages) stagesObj.stages = {};
      stagesObj.stages.create_ui_scenarios = Object.assign(
        stagesObj.stages.create_ui_scenarios || {},
        { status: 'skipped', skip_reason: 'ui_e2e.enabled=false' }
      );
      if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;
      writeStagesJson(stagesObj);
    }
    log.info('stage_skipped', 'ui_e2e.enabled=false，整段跳过', {
      stage:     'create-ui-scenarios',
      reason:    'ui_e2e disabled',
      exit_code: 0,
    });
    process.exit(0);
  }

  // 4. 上游门闸：stages.design_review.outputs.can_enter_codegen=true
  if (!stagesObj) {
    log.error('stage_failed', 'stages.json 不存在，请先运行 setup', {
      stage: 'create-ui-scenarios', exit_code: 1, reason: 'stages.json missing', duration_ms: 0,
    });
    process.exit(1);
  }

  const drOutputs       = stagesObj.stages && stagesObj.stages.design_review && stagesObj.stages.design_review.outputs;
  const canEnterCodegen = drOutputs && drOutputs.can_enter_codegen === true;

  if (!canEnterCodegen) {
    const actualValue = (drOutputs && drOutputs.can_enter_codegen !== undefined)
      ? drOutputs.can_enter_codegen
      : 'missing';
    log.error('stage_failed', `上游门闸未满足：design_review.outputs.can_enter_codegen=${actualValue}`, {
      stage:       'create-ui-scenarios',
      exit_code:   1,
      reason:      `design_review.outputs.can_enter_codegen=${actualValue}`,
      duration_ms: 0,
    });
    process.exit(1);
  }

  // 5. 检测 stop.signal（门闸通过后）
  if (checkStopSignal()) gracefulStop(stagesObj);

  // ── bootstrap 模式 ──────────────────────────────────────────────
  if (mode === 'bootstrap') {
    await doBootstrap(stagesObj, config);
    const dms = Date.now() - startedAt.getTime();
    log.info('stage_complete', `create-ui-scenarios bootstrap 完成，耗时 ${dms}ms`, {
      stage: 'create-ui-scenarios', duration_ms: dms, exit_code: 0, mode: 'bootstrap',
    });
    process.exit(0);
  }

  // ── tick 模式 ───────────────────────────────────────────────────
  if (mode === 'tick') {
    if (checkStopSignal()) gracefulStop(stagesObj);

    const { allDone, hasFailed, timedOutDetected } = await doTick(stagesObj, config, featureFilter);
    const dms = Date.now() - startedAt.getTime();

    if (allDone) {
      stagesObj = readStagesJson();
      const cusStage = stagesObj.stages.create_ui_scenarios;

      if (cusStage && cusStage.status !== 'completed' && cusStage.status !== 'failed') {
        const completedAtStr   = formatLocalTimeShort();
        const drFeatures2      = (stagesObj.stages.design_review && stagesObj.stages.design_review.features) || {};
        const targetIds        = Object.keys(drFeatures2)
          .filter(fid => drFeatures2[fid] && drFeatures2[fid].can_enter_codegen === true);
        const featureStatuses2 = cusStage.features || {};
        const allFailed2       = targetIds.length > 0 && targetIds.every(fid => {
          const fs_ = featureStatuses2[fid];
          return fs_ && fs_.status === 'failed';
        });

        if (allFailed2) {
          cusStage.status           = 'failed';
          cusStage.completed_at     = completedAtStr;
          cusStage.outputs.decision = 'failed';
          cusStage.outputs.duration_ms = dms;
        } else {
          cusStage.status           = 'completed';
          cusStage.completed_at     = completedAtStr;
          cusStage.outputs.decision = hasFailed ? 'partial' : 'passed';
          cusStage.outputs.duration_ms = dms;
          cusStage.validation = {
            passed: true, checked_at: completedAtStr,
            summary: 'tick 完成', required_files: [],
            missing_required_fields: [], warnings: [],
          };
        }
        if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;
        writeStagesJson(stagesObj);
      }
    }

    log.info('stage_complete', `create-ui-scenarios tick 完成，耗时 ${dms}ms`, {
      stage:       'create-ui-scenarios',
      duration_ms: dms,
      exit_code:   0,
      mode:        'tick',
      all_done:    allDone,
      has_failed:  hasFailed,
      timed_out:   timedOutDetected,
    });
    process.exit(0);
  }

  // ── 批量模式（默认）────────────────────────────────────────────
  const { targetFeatureIds } = await doBootstrap(stagesObj, config);
  stagesObj = readStagesJson();

  // 重新从 stages.json 获取 allTargetIds（bootstrap 可能更新了状态）
  const drFeatures = (stagesObj.stages.design_review && stagesObj.stages.design_review.features) || {};
  const allTargetIds = Object.keys(drFeatures)
    .filter(fid => drFeatures[fid] && drFeatures[fid].can_enter_codegen === true)
    .sort();

  const maxIterations = Math.max(allTargetIds.length * ((config.maxRetries || 2) + 3) + 10, 10);
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    if (checkStopSignal()) gracefulStop(readStagesJson());

    stagesObj = readStagesJson();
    const { allDone, hasFailed, timedOutDetected } = await doTick(stagesObj, config, featureFilter);

    if (timedOutDetected) {
      const dms = Date.now() - startedAt.getTime();
      log.error('stage_failed', 'create-ui-scenarios stage 超时', {
        stage:       'create-ui-scenarios',
        step:        'tick',
        exit_code:   3,
        reason:      'agent timeout',
        duration_ms: dms,
      });
      process.exit(3);
    }

    if (allDone) break;
  }

  // 步骤 3: validate
  stagesObj = readStagesJson();
  await doValidate(stagesObj, allTargetIds);

  const dms = Date.now() - startedAt.getTime();
  log.info('stage_complete', `create-ui-scenarios stage 完成，耗时 ${dms}ms`, {
    stage:              'create-ui-scenarios',
    duration_ms:        dms,
    exit_code:          0,
    features_total:     allTargetIds.length,
    effective_parallel: config.effectiveParallel,
  });
  process.exit(0);
}

main().catch(err => {
  console.error(`[FATAL] create-ui-scenarios.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

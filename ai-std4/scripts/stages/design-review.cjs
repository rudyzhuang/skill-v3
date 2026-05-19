'use strict';

/**
 * design-review.cjs — design-review stage 编排入口
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. 上游门闸：
 *      - stages.prd_review.outputs.decision=passed → exit 1
 *      - stages.design.inputs.dependency_groups[] 非空（design bootstrap 已完成）→ exit 1
 *   2. 检测 stop.signal → exit 5
 *   --bootstrap 模式：
 *     3. 计算 design_bundle_hash，门控判断整体跳过（exit 0 if skipped）
 *     4. 初始化 stages.design_review 骨架，写 stages.json
 *   --tick 模式：
 *     3. 若 bootstrap 未完成则先执行 bootstrap
 *     4. 检测 stop.signal → exit 5
 *     5. 调度就绪 feature Agent（组感知，受 effective_parallel 限制）
 *     6. 检查 group release，更新 stages.json，exit 0
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

const { createLogger, formatLocalTimeShort } = require('../libs/logger.cjs');
const gitStageSync = require('../libs/git-stage-sync.cjs');

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
const log = createLogger({ projectRoot, stage: 'design-review', runId });

// ── 工具函数 ──────────────────────────────────────────────────────
/** 计算文件 SHA-256 hex；文件不存在返回 null */
function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 读取 stages.json；不存在或解析失败返回 null */
function readStagesJson() {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/** 写 stages.json（原子覆盖） */
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

/** 优雅停止：写日志 + stages.json + 删 stop.signal + exit 5 */
function gracefulStop(stagesObj) {
  const stoppedAt = formatLocalTimeShort();
  const reason    = getStopReason();

  log.info('pipeline_stop', '检测到 stop.signal，开始优雅停止', {
    stage: 'design-review', reason, stopped_at: stoppedAt,
  });

  if (stagesObj && stagesObj.stages) {
    if (!stagesObj.stages.design_review) {
      stagesObj.stages.design_review = { status: 'stopped' };
    } else {
      stagesObj.stages.design_review.status = 'stopped';
    }
    if (stagesObj.pipeline) {
      stagesObj.pipeline.updated_at = stoppedAt;
      stagesObj.pipeline.stop_info  = { stopped_at: stoppedAt, stopped_stage: 'design-review', reason };
    }
    writeStagesJson(stagesObj);
  }

  try {
    const sig = path.join(projectRoot, '.pipeline', 'stop.signal');
    if (fs.existsSync(sig)) fs.unlinkSync(sig);
  } catch (_) { /* ignore */ }

  log.info('pipeline_stopped', 'design-review stage 已优雅停止', {
    stage: 'design-review', stopped_at: stoppedAt, exit_code: 5,
  });
  process.exit(5);
}

/** 读取并发配置 */
function readConfig() {
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { /* */ }
  }
  const timeoutS       = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.design_review_s) || 900;
  const maxRetries     = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.design_review && cfg.pipeline.stages.design_review.max_retries) || 2;
  const model          = (cfg.pipeline && cfg.pipeline.model) || 'composer-2';
  const stageParallel  = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.design_review && cfg.pipeline.stages.design_review.feature_max_parallel) || 3;
  const globalParallel = (cfg.pipeline && cfg.pipeline.autorun && cfg.pipeline.autorun.feature_max_parallel) || 3;
  const effectiveParallel = Math.min(stageParallel, globalParallel);
  return { timeoutS, maxRetries, model, effectiveParallel };
}

// ── Ajv 校验 ──────────────────────────────────────────────────────
let _ajv = null;
function getAjv() {
  if (_ajv) return _ajv;
  try {
    const Ajv = require('ajv');
    _ajv = new Ajv({ allErrors: true, strict: false });
    try { require('ajv-formats')(_ajv); } catch (_) { /* optional */ }
  } catch (_) { return null; }
  return _ajv;
}

function loadSchema(schemaName) {
  const p = path.join(skillsRoot, 'ai-std4', 'schemas', schemaName);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function validateReviewOutput(data) {
  try {
    const schema = loadSchema('design-review-feature-output.schema.json');
    if (!schema) return { valid: true, errors: [] };
    const ajv = getAjv();
    if (!ajv) return { valid: true, errors: [] };
    const validate = ajv.compile(schema);
    const valid    = validate(data);
    return { valid, errors: validate.errors || [] };
  } catch (_) {
    return { valid: true, errors: [] };
  }
}

// ── 辅助：判断 gap 是否为 blocking ────────────────────────────────
function isBlockingGap(gap) {
  return gap.severity === 'blocking' || gap.blocking === true;
}

// ── 计算 design_bundle_hash ───────────────────────────────────────
/**
 * 对所有已 completed 的 feature 按 feature_id 字典序排列各自 design.json SHA-256，
 * 再对该列表做 JSON.stringify + SHA-256（hash-of-hashes）
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
  return crypto.createHash('sha256')
    .update(JSON.stringify(hashes))
    .digest('hex');
}

/** 计算 phase_plan 的稳定 SHA-256 哈希（与 design.cjs 一致） */
function computePhasePlanHash(phasePlan) {
  if (!Array.isArray(phasePlan) || phasePlan.length === 0) return null;
  const sorted = [...phasePlan].sort((a, b) => String(a.phase).localeCompare(String(b.phase)));
  const str = JSON.stringify(sorted.map(p => ({
    phase:       p.phase,
    feature_ids: [...(p.feature_ids || [])].sort(),
  })));
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ── 收集 feature_ids 来源 ─────────────────────────────────────────
/**
 * 从 design.inputs.feature_ids 或 dependency_groups 提取 targetFeatureIds
 */
function getTargetFeatureIds(stagesObj) {
  const designStage = stagesObj.stages && stagesObj.stages.design;
  if (!designStage) return [];

  // 优先读 design.inputs.feature_ids
  const directIds = designStage.inputs && designStage.inputs.feature_ids;
  if (Array.isArray(directIds) && directIds.length > 0) return directIds;

  // 从 dependency_groups 展开
  const groups = (designStage.inputs && designStage.inputs.dependency_groups) || [];
  const ids = [];
  for (const g of groups) {
    for (const fid of (g.feature_ids || [])) {
      if (!ids.includes(fid)) ids.push(fid);
    }
  }
  return ids;
}

// ── 确定性预检 ────────────────────────────────────────────────────
/**
 * 对已完成 design 的 feature 执行确定性检查（不调用 Agent），
 * 返回每个 feature 的 deterministic gaps。
 */
function runDeterministicChecks(stagesObj, targetFeatureIds) {
  const prdFeatures = (stagesObj.stages && stagesObj.stages.prd && stagesObj.stages.prd.outputs && stagesObj.stages.prd.outputs.features) || [];
  const featureIdSet = new Set(targetFeatureIds);

  // 检查跨 feature modify_files 路径冲突
  const modifyFileOwners = {};
  for (const fid of targetFeatureIds) {
    const designFile = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    if (!fs.existsSync(designFile)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(designFile, 'utf8'));
      const modifyFiles = (data.file_plan && data.file_plan.modify_files) || [];
      for (const mf of modifyFiles) {
        const fp = typeof mf === 'string' ? mf : mf.path;
        if (fp) {
          if (!modifyFileOwners[fp]) modifyFileOwners[fp] = [];
          modifyFileOwners[fp].push(fid);
        }
      }
    } catch (_) { /* ignore */ }
  }

  const result = {};
  for (const fid of targetFeatureIds) {
    const gaps = [];
    const designFile = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    if (!fs.existsSync(designFile)) continue;

    let data;
    try { data = JSON.parse(fs.readFileSync(designFile, 'utf8')); } catch (_) { continue; }

    // acceptance.length < 3 → blocking
    if (!Array.isArray(data.acceptance) || data.acceptance.length < 3) {
      gaps.push({
        field:    'acceptance',
        category: 'completeness',
        severity: 'blocking',
        blocking: true,
        message:  `acceptance 不足 3 条（当前 ${(data.acceptance || []).length} 条）`,
      });
    }

    // dependencies 中 id 不在本期 feature_ids → blocking
    for (const depId of (data.dependencies || [])) {
      if (!featureIdSet.has(depId)) {
        gaps.push({
          field:    'dependencies',
          category: 'prd_alignment',
          severity: 'blocking',
          blocking: true,
          message:  `dependency ${depId} 不在本期 feature_ids 中`,
        });
      }
    }

    // file_plan.new_files 与 modify_files 路径重叠 → blocking
    const newFiles    = ((data.file_plan && data.file_plan.new_files)    || []).map(f => typeof f === 'string' ? f : f.path).filter(Boolean);
    const modifyFiles = ((data.file_plan && data.file_plan.modify_files) || []).map(f => typeof f === 'string' ? f : f.path).filter(Boolean);
    for (const nf of newFiles) {
      if (modifyFiles.includes(nf)) {
        gaps.push({
          field:    'file_plan',
          category: 'completeness',
          severity: 'blocking',
          blocking: true,
          message:  `file_plan: ${nf} 同时出现在 new_files 和 modify_files 中`,
        });
      }
    }

    // 跨 feature modify_files 冲突 → warning
    for (const fp of modifyFiles) {
      const owners = modifyFileOwners[fp] || [];
      if (owners.length > 1 && owners.includes(fid)) {
        gaps.push({
          field:    'file_plan',
          category: 'conflict',
          severity: 'warning',
          blocking: false,
          message:  `modify_files 路径 ${fp} 与 feature [${owners.filter(o => o !== fid).join(', ')}] 冲突`,
        });
      }
    }

    if (gaps.length > 0) result[fid] = gaps;
  }
  return result;
}

// ── Bootstrap ────────────────────────────────────────────────────
async function doBootstrap(stagesObj, config) {
  const startedAtStr = formatLocalTimeShort();

  const designStage    = stagesObj.stages && stagesObj.stages.design;
  const prdReviewStage = stagesObj.stages && stagesObj.stages.prd_review;

  const targetFeatureIds = getTargetFeatureIds(stagesObj);
  if (targetFeatureIds.length === 0) {
    log.error('stage_failed', 'bootstrap: 无法从 design.inputs 获取 feature_ids', {
      stage: 'design-review', exit_code: 1, reason: 'feature_ids empty', duration_ms: 0,
    });
    process.exit(1);
  }

  const depGroups = (designStage && designStage.inputs && designStage.inputs.dependency_groups) || [];

  // feature → group_id 映射
  const featureGroupMap = {};
  for (const g of depGroups) {
    for (const fid of (g.feature_ids || [])) featureGroupMap[fid] = g.group_id;
  }

  // 计算 hash
  const designFeatures     = (designStage && designStage.features) || {};
  const phasePlan          = (prdReviewStage && prdReviewStage.review && prdReviewStage.review.phase_plan) || [];
  const designBundleHashNew = computeDesignBundleHash(designFeatures);
  const phasePlanHashNew    = computePhasePlanHash(phasePlan);

  const existingDR = stagesObj.stages && stagesObj.stages.design_review;

  // hash 门控（整段跳过）
  if (!forceRerun && existingDR && existingDR.status === 'completed') {
    const storedBundleHash = existingDR.inputs && existingDR.inputs.design_bundle_hash;
    const releasedGroupIds = ((existingDR.outputs && existingDR.outputs.released_groups) || []).map(g => typeof g === 'string' ? g : g.group_id);
    const allGroupsReleased = depGroups.every(g => releasedGroupIds.includes(g.group_id));
    const outputDecision    = existingDR.outputs && existingDR.outputs.decision;

    if (designBundleHashNew && storedBundleHash && designBundleHashNew === storedBundleHash
        && outputDecision === 'passed' && allGroupsReleased) {
      log.info('stage_skipped', 'design-review hash 门控命中，跳过整段执行', {
        stage: 'design-review', reason: 'design_bundle_hash matched, decision=passed', exit_code: 0,
      });
      process.exit(0);
    }
  }

  // hash_check 日志
  log.info('hash_check', '计算 design_bundle_hash', {
    design_bundle_hash:  designBundleHashNew,
    stored_hash:         existingDR && existingDR.inputs && existingDR.inputs.design_bundle_hash,
    computed_hash:       designBundleHashNew,
    hit:                 false,
  });

  // 已有骨架：zombie 恢复 + 新增 feature 初始化
  const existingFeatures   = (existingDR && existingDR.features) || {};
  const zombieResetList    = [];
  const newFeaturesAdded   = [];

  const features = {};
  for (const fid of targetFeatureIds) {
    const existing = existingFeatures[fid];
    if (!existing) {
      features[fid] = {
        status:       'pending',
        group_id:     featureGroupMap[fid] || null,
        can_enter_codegen: false,
        started_at:   null,
        completed_at: null,
        attempts:     0,
        review_file:  null,
        review_hash:  null,
        design_hash:  null,
        decision:     null,
        blocking_gaps: [],
        deterministic_gaps: [],
        error:        null,
      };
      newFeaturesAdded.push(fid);
    } else if (existing.status === 'running') {
      // zombie 恢复
      features[fid] = Object.assign({}, existing, { status: 'pending', group_id: featureGroupMap[fid] || existing.group_id });
      zombieResetList.push(fid);
    } else {
      features[fid] = Object.assign({}, existing, { group_id: featureGroupMap[fid] || existing.group_id });
    }
  }

  // 确定性预检（对 design.features.<id>.status=completed 且 review status∈{pending,failed} 的 feature）
  const completedDesignIds = targetFeatureIds.filter(fid => {
    const ds = designFeatures[fid];
    const rs = features[fid] && features[fid].status;
    return ds && ds.status === 'completed' && (rs === 'pending' || rs === 'failed');
  });

  const deterministicGaps = runDeterministicChecks(stagesObj, completedDesignIds);
  let deterministicBlockingCount = 0;
  let deterministicWarningCount  = 0;

  for (const fid of completedDesignIds) {
    const gaps = deterministicGaps[fid] || [];
    features[fid].deterministic_gaps = gaps;
    const blockingGaps = gaps.filter(isBlockingGap);
    deterministicBlockingCount += blockingGaps.length;
    deterministicWarningCount  += gaps.filter(g => !isBlockingGap(g)).length;
  }

  if (completedDesignIds.length > 0) {
    if (deterministicBlockingCount > 0) {
      log.warn('validation_fail', '确定性预检发现 blocking gap', {
        feature_ids: completedDesignIds,
        deterministic_blocking_count: deterministicBlockingCount,
        deterministic_warning_count:  deterministicWarningCount,
      });
    } else {
      log.info('validation_pass', '确定性预检通过', {
        feature_ids: completedDesignIds,
        deterministic_blocking_count: deterministicBlockingCount,
        deterministic_warning_count:  deterministicWarningCount,
      });
    }
  }

  // 写入 stages.design_review
  if (!stagesObj.stages) stagesObj.stages = {};

  const existingOutputs = (existingDR && existingDR.outputs) || {};
  stagesObj.stages.design_review = {
    status:       'running',
    started_at:   (existingDR && existingDR.started_at) || startedAtStr,
    completed_at: null,
    inputs: {
      design_bundle_hash: designBundleHashNew,
      phase_plan_hash:    phasePlanHashNew,
      design_hashes:      Object.fromEntries(
        targetFeatureIds.map(fid => {
          const p = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
          return [fid, fileSha256(p)];
        })
      ),
    },
    outputs: {
      can_enter_codegen: existingOutputs.can_enter_codegen || false,
      released_groups:   existingOutputs.released_groups   || [],
      failed_features:   existingOutputs.failed_features   || [],
      blocked_features:  existingOutputs.blocked_features  || [],
      decision:          existingOutputs.decision          || 'pending',
      gaps:              existingOutputs.gaps              || [],
      duration_ms:       null,
      timed_out:         false,
      timeout_reason:    null,
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
    git_sync: (existingDR && existingDR.git_sync) || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  };

  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;
  const sp   = writeStagesJson(stagesObj);
  const stat = fs.statSync(sp);

  log.info('file_updated', '已写 stages.design_review bootstrap 骨架', {
    path:                sp,
    size_bytes:          stat.size,
    status:              'running',
    zombie_features_reset: zombieResetList,
    new_features_added:    newFeaturesAdded,
    effective_parallel:    config.effectiveParallel,
  });

  return { targetFeatureIds, depGroups };
}

// ── Agent 调用 ────────────────────────────────────────────────────
async function invokeReviewAgent({ featureId, featureMeta, stagesObj, model, timeoutMs }) {
  const agentId    = `design-review-agent-${featureId}`;
  const promptFile = 'design-review.md';
  const promptPath = path.join(skillsRoot, 'ai-std4', 'prompts', promptFile);

  if (!fs.existsSync(promptPath)) {
    return { success: false, timedOut: false, error: `Prompt file not found: ${promptPath}`, agentRunId: null };
  }

  let promptContent = fs.readFileSync(promptPath, 'utf8');

  const designFile = path.join(projectRoot, 'docs', 'designs', `${featureId}.design.json`);
  const prdSpecPath = path.join(projectRoot, 'docs', 'prd-spec.md');
  const outputFile  = path.join(projectRoot, '.pipeline', `design-review-${featureId}.json`);
  const pipelineDir = path.join(projectRoot, '.pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });

  // 获取 deterministic_issues
  const drFeature  = stagesObj.stages && stagesObj.stages.design_review && stagesObj.stages.design_review.features && stagesObj.stages.design_review.features[featureId];
  const detGaps    = (drFeature && drFeature.deterministic_gaps) || [];

  // 涉及的 PRD 文件
  const prdFeatures  = (stagesObj.stages && stagesObj.stages.prd && stagesObj.stages.prd.outputs && stagesObj.stages.prd.outputs.features) || [];
  const fMeta        = featureMeta || prdFeatures.find(f => f.feature_id === featureId) || {};
  const clientTargets = fMeta.client_targets || (fMeta.client_target ? [fMeta.client_target] : []);
  const prdFiles = [];
  for (const ct of clientTargets) {
    const pf = path.join(projectRoot, 'docs', `prd-${ct}.json`);
    const fl = path.join(projectRoot, 'docs', `feature_list-${ct}.md`);
    if (fs.existsSync(pf)) prdFiles.push(pf);
    if (fs.existsSync(fl)) prdFiles.push(fl);
  }

  // 分期计划
  const prdReviewStage = stagesObj.stages && stagesObj.stages.prd_review;
  const phasePlan      = (prdReviewStage && prdReviewStage.review && prdReviewStage.review.phase_plan) || [];

  // 注入上下文
  const ctx = [
    `<!-- inject: feature_id=${featureId} -->`,
    `<!-- inject: project_root=${projectRoot} -->`,
    `<!-- inject: output_file=${outputFile} -->`,
    `<!-- inject: design_file=${designFile} -->`,
    prdFiles.length > 0       ? `<!-- inject: prd_files=${prdFiles.join(',')} -->` : '',
    detGaps.length > 0        ? `<!-- inject: deterministic_issues=${JSON.stringify(detGaps)} -->` : '',
    phasePlan.length > 0      ? `<!-- inject: phase_plan=${JSON.stringify(phasePlan)} -->` : '',
  ].filter(Boolean).join('\n');

  const finalPrompt = promptContent + '\n\n' + ctx;

  const inputFiles = [designFile, prdSpecPath, ...prdFiles].filter(fs.existsSync);
  log.info('agent_start', `启动 design-review Agent: ${agentId}`, {
    agent_id:    agentId,
    feature_id:  featureId,
    prompt:      promptFile,
    input_files: inputFiles,
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
        return { success: result.status === 'finished', error: result.status !== 'finished' ? `Agent status: ${result.status}` : null };
      } finally {
        if (typeof agent[Symbol.asyncDispose] === 'function') await agent[Symbol.asyncDispose]();
      }
    })();

    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), timeoutMs));
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
async function runReviewAgentForFeature({ featureId, featureMeta, stagesObj, model, timeoutMs, maxRetries }) {
  const agentId    = `design-review-agent-${featureId}`;
  const outputFile = path.join(projectRoot, '.pipeline', `design-review-${featureId}.json`);

  let lastError = null;
  let timedOut  = false;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      log.warn('agent_retry', `design-review Agent(${featureId}) 第 ${attempt} 次重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
    }

    const t0     = Date.now();
    const result = await invokeReviewAgent({ featureId, featureMeta, stagesObj, model, timeoutMs });
    const dms    = Date.now() - t0;

    if (result.timedOut) {
      timedOut  = true;
      lastError = result.error;
      log.error('agent_failed', `design-review Agent(${featureId}) 超时`, {
        agent_id: agentId, feature_id: featureId,
        max_attempts: maxRetries + 1, last_error: result.error, exit_code: 3,
      });
      return { success: false, timedOut: true, featureId, error: result.error, durationMs: dms };
    }

    if (!result.success) {
      lastError = result.error;
      if (attempt > maxRetries) break;
      continue;
    }

    // 输出文件校验
    if (!fs.existsSync(outputFile)) {
      lastError = `Output file not found: ${outputFile}`;
      if (attempt > maxRetries) break;
      log.warn('agent_retry', `design-review Agent(${featureId}) 输出文件缺失，重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
      continue;
    }

    let outputData;
    try {
      outputData = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    } catch (e) {
      lastError = `JSON parse error: ${e.message}`;
      if (attempt > maxRetries) break;
      log.warn('agent_retry', `design-review Agent(${featureId}) JSON 解析失败，重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
      continue;
    }

    // Ajv schema 校验
    const { valid, errors } = validateReviewOutput(outputData);
    if (!valid) {
      const invalidFields = errors.map(e => e.instancePath + ' ' + e.message).join('; ');
      lastError = `Schema validation failed: ${invalidFields}`;
      log.warn('agent_retry', `design-review Agent(${featureId}) schema 校验失败，重试`, {
        agent_id: agentId, feature_id: featureId, attempt,
        reason: 'schema_validation_failed', invalid_fields: invalidFields,
      });
      if (attempt > maxRetries) break;
      continue;
    }

    // 成功
    const reviewHash = fileSha256(outputFile);
    const designHash = fileSha256(path.join(projectRoot, 'docs', 'designs', `${featureId}.design.json`));
    const gaps       = outputData.gaps || [];
    const blockingGaps = gaps.filter(isBlockingGap);
    const decision   = outputData.outputs && outputData.outputs.decision;

    // can_enter_codegen: decision=passed 且无 blocking gap
    const canEnterCodegen = decision === 'passed' && blockingGaps.length === 0;

    log.info('agent_complete', `design-review Agent(${featureId}) 完成`, {
      agent_id:      agentId,
      feature_id:    featureId,
      duration_ms:   dms,
      decision,
      gaps_blocking: blockingGaps.length,
      gaps_warning:  gaps.filter(g => !isBlockingGap(g)).length,
      output_files:  [outputFile],
    });

    return {
      success: true,
      timedOut: false,
      featureId,
      reviewHash,
      designHash,
      decision,
      gaps,
      blockingGaps,
      canEnterCodegen,
      outputData,
      durationMs: dms,
      error: null,
    };
  }

  log.error('agent_failed', `design-review Agent(${featureId}) 超过最大重试次数`, {
    agent_id: agentId, feature_id: featureId,
    max_attempts: maxRetries + 1, last_error: lastError, exit_code: 4,
  });
  return { success: false, timedOut, featureId, error: lastError, durationMs: 0 };
}

// ── 并发 Worker Pool ──────────────────────────────────────────────
async function runAgentsConcurrent({ readyFeatureIds, featureMetaMap, stagesObj, config }) {
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
      const result = await runReviewAgentForFeature({
        featureId: fid, featureMeta, stagesObj, model, timeoutMs, maxRetries,
      });
      results.push(result);
    }
  }

  const concurrency = Math.max(1, Math.min(effectiveParallel, readyFeatureIds.length));
  const workers     = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return { results, stoppedFound };
}

// ── 组级放行逻辑 ──────────────────────────────────────────────────
/**
 * 检查并执行 group release。
 * 对 depGroups 中每个组，若组内所有 feature 都 completed 且 can_enter_codegen=true，
 * 且该 group_id 尚未在 released_groups 中，则 release 该组。
 * 返回 { newlyReleasedGroups, stageCanEnterCodegen }
 */
function checkAndReleaseGroups(dr, depGroups) {
  const featureStatuses = dr.features || {};
  const outputs         = dr.outputs || {};
  const releasedGroups  = outputs.released_groups || [];
  const releasedGroupIds = releasedGroups.map(g => typeof g === 'string' ? g : g.group_id);
  const newlyReleased   = [];

  for (const group of depGroups) {
    const gid     = group.group_id;
    const fids    = group.feature_ids || [];

    if (releasedGroupIds.includes(gid)) continue;

    const allCompleted        = fids.every(fid => featureStatuses[fid] && featureStatuses[fid].status === 'completed');
    const allCanEnterCodegen  = fids.every(fid => featureStatuses[fid] && featureStatuses[fid].can_enter_codegen === true);

    if (allCompleted && allCanEnterCodegen) {
      // 执行 release
      const releasedAt = formatLocalTimeShort();
      const designHashes = {};
      for (const fid of fids) {
        designHashes[fid] = featureStatuses[fid].design_hash || null;
      }

      const releaseEntry = {
        group_id:     gid,
        feature_ids:  fids,
        released_at:  releasedAt,
        design_hashes: designHashes,
      };

      releasedGroups.push(releaseEntry);

      // 更新 outputs
      outputs.released_groups    = releasedGroups;
      outputs.can_enter_codegen  = true;

      // 标记组内每个 feature can_enter_codegen=true（已在 agent 结果处理时设置，此处确认）
      for (const fid of fids) {
        if (featureStatuses[fid]) featureStatuses[fid].can_enter_codegen = true;
      }

      newlyReleased.push(releaseEntry);
      releasedGroupIds.push(gid);

      log.info('group_released', `dependency group ${gid} 已放行，可进入 codegen`, {
        group_id:             gid,
        feature_ids:          fids,
        released_groups_count: releasedGroups.length,
      });
    }
  }

  dr.outputs = outputs;
  return { newlyReleasedGroups: newlyReleased };
}

// ── tick：单轮调度 ────────────────────────────────────────────────
async function doTick(stagesObj, config, featureFilterId) {
  // 若 bootstrap 尚未完成，先执行 bootstrap
  if (!stagesObj.stages || !stagesObj.stages.design_review) {
    log.info('file_updated', 'design-review stage 未 bootstrap，先执行 bootstrap', { status: 'bootstrapping' });
    await doBootstrap(stagesObj, config);
    stagesObj = readStagesJson();
  }

  const dr              = stagesObj.stages.design_review;
  const designStage     = stagesObj.stages.design;
  const depGroups       = (designStage && designStage.inputs && designStage.inputs.dependency_groups) || [];
  const featureStatuses = dr.features || {};
  const targetFeatureIds = getTargetFeatureIds(stagesObj);

  // prd features meta map
  const prdFeatures    = (stagesObj.stages && stagesObj.stages.prd && stagesObj.stages.prd.outputs && stagesObj.stages.prd.outputs.features) || [];
  const featureMetaMap = new Map(prdFeatures.map(f => [f.feature_id, f]));

  // 作用域：单 feature 模式
  const scopeIds = featureFilterId
    ? targetFeatureIds.filter(id => id === featureFilterId)
    : targetFeatureIds;

  // 找就绪 feature：design.features.<id>.status=completed 且 review 未完成/失败
  // 且无 blocking 确定性 gap
  const readyFeatureIds = [];
  const designFeatures  = (designStage && designStage.features) || {};

  for (const fid of scopeIds) {
    const designStatus = designFeatures[fid] && designFeatures[fid].status;
    if (designStatus !== 'completed') continue;

    const reviewStatus = featureStatuses[fid] && featureStatuses[fid].status;
    // 已 completed 或正在 running 的跳过
    if (reviewStatus === 'completed' || reviewStatus === 'running') continue;

    // 有 blocking 确定性 gap 的不入队（但仍可 completed）
    const detGaps = (featureStatuses[fid] && featureStatuses[fid].deterministic_gaps) || [];
    if (detGaps.some(isBlockingGap)) {
      // 直接标 completed + can_enter_codegen=false（无需 Agent）
      if (reviewStatus !== 'completed') {
        const now = formatLocalTimeShort();
        featureStatuses[fid].status           = 'completed';
        featureStatuses[fid].can_enter_codegen = false;
        featureStatuses[fid].completed_at     = now;
        featureStatuses[fid].blocking_gaps    = detGaps.filter(isBlockingGap);
        featureStatuses[fid].decision         = 'failed';
        if (!dr.outputs.blocked_features) dr.outputs.blocked_features = [];
        if (!dr.outputs.blocked_features.includes(fid)) dr.outputs.blocked_features.push(fid);
        log.info('feature_review_complete', `feature ${fid} 因确定性 blocking gap 跳过 Agent，标记为 blocked`, {
          feature_id: fid, group_id: featureStatuses[fid].group_id, decision: 'failed',
          group_all_passed: false,
        });
      }
      continue;
    }

    // 单 feature hash 门控：design.json hash 命中且上次 decision=passed → 跳过 Agent
    if (!forceRerun) {
      const storedDesignHash  = featureStatuses[fid] && featureStatuses[fid].design_hash;
      const currentDesignHash = fileSha256(path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`));
      const storedDecision    = featureStatuses[fid] && featureStatuses[fid].decision;

      if (storedDesignHash && currentDesignHash && storedDesignHash === currentDesignHash && storedDecision === 'passed') {
        // hash 命中，跳过 Agent
        if (reviewStatus !== 'completed') {
          featureStatuses[fid].status = 'completed';
          if (!featureStatuses[fid].can_enter_codegen) featureStatuses[fid].can_enter_codegen = true;
        }
        log.info('agent_skipped', `feature ${fid} design_hash 命中且 decision=passed，跳过 Agent`, {
          agent_id: `design-review-agent-${fid}`, feature_id: fid,
          reason: 'design_hash matched, prior passed',
        });
        continue;
      }
    }

    readyFeatureIds.push(fid);
  }

  // 若有因确定性 gap 被直接标记的 feature，写入 stages.json
  writeStagesJson(stagesObj);

  // 检查整体完成状态：所有 scope feature 的 design 已 completed 且 review 已结束
  const allDone = scopeIds.every(fid => {
    const dfeat       = designFeatures[fid];
    const designStatus = dfeat ? dfeat.status : null;
    if (designStatus !== 'completed') return false;
    const reviewStatus = featureStatuses[fid] ? featureStatuses[fid].status : null;
    return reviewStatus === 'completed' || reviewStatus === 'failed';
  });

  if (readyFeatureIds.length === 0) {
    checkAndReleaseGroups(dr, depGroups);
    writeStagesJson(stagesObj);
    if (allDone) {
      const hasFailed = scopeIds.some(fid => featureStatuses[fid] && featureStatuses[fid].status === 'failed');
      return { allDone: true, hasFailed, timedOutDetected: false };
    }
    return { allDone: false, hasFailed: false, timedOutDetected: false };
  }

  // 批次启动 Agent
  const waveIndex = ((dr.inputs && dr.inputs._tick_wave_index) || 0) + 1;
  if (dr.inputs) dr.inputs._tick_wave_index = waveIndex;
  const batchId = `design-review-tick-${waveIndex}`;

  log.info('agent_batch_start', `design-review Agent 批次开始，共 ${readyFeatureIds.length} 个 feature`, {
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

  // 并发执行 Agent
  const batchT0 = Date.now();
  const { results, stoppedFound } = await runAgentsConcurrent({
    readyFeatureIds, featureMetaMap, stagesObj, config,
  });
  const batchDurationMs = Date.now() - batchT0;

  if (stoppedFound) {
    gracefulStop(readStagesJson());
  }

  // 处理结果
  stagesObj = readStagesJson();
  const drFresh           = stagesObj.stages.design_review;
  const featureStatusFresh = drFresh.features || {};

  const succeededIds   = [];
  const failedIds      = [];
  let timedOutDetected = false;

  for (const r of results) {
    if (r.stopped) continue;
    const completedAtStr = formatLocalTimeShort();
    const fStatus        = featureStatusFresh[r.featureId] || {};

    if (r.success) {
      fStatus.status           = 'completed';
      fStatus.completed_at     = completedAtStr;
      fStatus.review_file      = path.join(projectRoot, '.pipeline', `design-review-${r.featureId}.json`);
      fStatus.review_hash      = r.reviewHash;
      fStatus.design_hash      = r.designHash;
      fStatus.decision         = r.decision;
      fStatus.can_enter_codegen = r.canEnterCodegen;
      fStatus.blocking_gaps    = (r.blockingGaps || []).map(g => ({ field: g.field, message: g.message, severity: g.severity }));
      fStatus.error            = null;

      // 更新 outputs
      if (!drFresh.outputs.blocked_features) drFresh.outputs.blocked_features = [];
      if (!r.canEnterCodegen && !drFresh.outputs.blocked_features.includes(r.featureId)) {
        drFresh.outputs.blocked_features.push(r.featureId);
      }

      succeededIds.push(r.featureId);

      // 决定 group_all_passed
      const groupId = fStatus.group_id;
      const group   = depGroups.find(g => g.group_id === groupId);
      const groupAllPassed = group
        ? group.feature_ids.every(fid => featureStatusFresh[fid] && featureStatusFresh[fid].can_enter_codegen === true)
        : false;

      log.info('feature_review_complete', `feature ${r.featureId} 评审完成`, {
        feature_id:      r.featureId,
        group_id:        groupId || null,
        decision:        r.decision,
        group_all_passed: groupAllPassed,
      });
    } else {
      if (r.timedOut) timedOutDetected = true;
      fStatus.status   = 'failed';
      fStatus.error    = r.error;
      fStatus.completed_at = completedAtStr;
      failedIds.push(r.featureId);

      if (!drFresh.outputs.failed_features) drFresh.outputs.failed_features = [];
      if (!drFresh.outputs.failed_features.includes(r.featureId)) {
        drFresh.outputs.failed_features.push(r.featureId);
      }
    }

    featureStatusFresh[r.featureId] = fStatus;
  }

  // 检查 group release
  const depGroupsFresh = ((stagesObj.stages.design && stagesObj.stages.design.inputs && stagesObj.stages.design.inputs.dependency_groups) || []);
  checkAndReleaseGroups(drFresh, depGroupsFresh);

  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = formatLocalTimeShort();
  writeStagesJson(stagesObj);

  // 日志：batch complete
  const skippedIds = readyFeatureIds.filter(id => !succeededIds.includes(id) && !failedIds.includes(id));
  log.info('agent_batch_complete', 'design-review Agent 批次结束', {
    batch_id:         batchId,
    agents_succeeded: succeededIds,
    agents_failed:    failedIds,
    agents_skipped:   skippedIds,
    duration_ms:      batchDurationMs,
  });

  // 重新检查整体完成状态
  const freshFeatureStatuses = stagesObj.stages.design_review.features || {};
  const freshDesignFeatures  = (stagesObj.stages.design && stagesObj.stages.design.features) || {};
  const allDoneNow = scopeIds.every(fid => {
    const dfeat = freshDesignFeatures[fid];
    if (!dfeat || dfeat.status !== 'completed') return false;
    const rfeat = freshFeatureStatuses[fid];
    return rfeat && (rfeat.status === 'completed' || rfeat.status === 'failed');
  });
  const hasFailed = scopeIds.some(fid => freshFeatureStatuses[fid] && freshFeatureStatuses[fid].status === 'failed');

  return { allDone: allDoneNow, hasFailed, timedOutDetected };
}

// ── 步骤 3：validate + 写完成态 ──────────────────────────────────
async function doValidate(stagesObj, targetFeatureIds) {
  const dr              = stagesObj.stages.design_review;
  const depGroups       = ((stagesObj.stages.design && stagesObj.stages.design.inputs && stagesObj.stages.design.inputs.dependency_groups) || []);
  const featureStatuses = dr.features || {};
  const completedAtStr  = formatLocalTimeShort();
  const startedAt       = dr.started_at ? new Date(dr.started_at).getTime() : Date.now();

  // 检查 group release（确保最终状态正确）
  checkAndReleaseGroups(dr, depGroups);

  const releasedGroupIds  = (dr.outputs.released_groups || []).map(g => typeof g === 'string' ? g : g.group_id);
  const allGroupsReleased = depGroups.every(g => releasedGroupIds.includes(g.group_id));
  const blockedFeatures   = targetFeatureIds.filter(fid => featureStatuses[fid] && !featureStatuses[fid].can_enter_codegen && featureStatuses[fid].status === 'completed');
  const failedFeatures    = targetFeatureIds.filter(fid => featureStatuses[fid] && featureStatuses[fid].status === 'failed');

  // 合并 gaps 到 outputs.gaps
  const allGaps = [];
  for (const fid of targetFeatureIds) {
    const reviewFile = featureStatuses[fid] && featureStatuses[fid].review_file;
    if (reviewFile && fs.existsSync(reviewFile)) {
      try {
        const reviewData = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
        for (const gap of (reviewData.gaps || [])) {
          allGaps.push(Object.assign({}, gap, { feature_id: fid }));
        }
      } catch (_) { /* ignore */ }
    }
    // 也包含 deterministic gaps
    const detGaps = (featureStatuses[fid] && featureStatuses[fid].deterministic_gaps) || [];
    for (const gap of detGaps) {
      if (!allGaps.some(g => g.feature_id === fid && g.message === gap.message)) {
        allGaps.push(Object.assign({}, gap, { feature_id: fid }));
      }
    }
  }

  const blockingCount = allGaps.filter(isBlockingGap).length;
  const warningCount  = allGaps.filter(g => !isBlockingGap(g)).length;

  dr.outputs.gaps            = allGaps;
  dr.outputs.blocking_count  = blockingCount;
  dr.outputs.warning_count   = warningCount;
  dr.outputs.blocked_features = blockedFeatures;
  dr.outputs.failed_features  = failedFeatures;
  dr.outputs.duration_ms     = Date.now() - startedAt;

  // 生成摘要报告
  const reportsDir = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const summaryPath = path.join(reportsDir, 'design-review-summary.md');
  const summaryLines = [
    '# design-review 阶段摘要',
    '',
    `| 指标 | 值 |`,
    `| --- | --- |`,
    `| 已评审 feature | ${targetFeatureIds.length} |`,
    `| 可进入 codegen | ${targetFeatureIds.filter(fid => featureStatuses[fid] && featureStatuses[fid].can_enter_codegen).length} |`,
    `| blocking gap 数 | ${blockingCount} |`,
    `| warning gap 数 | ${warningCount} |`,
    `| 已放行 group | ${releasedGroupIds.length} / ${depGroups.length} |`,
    '',
    '## 已放行 Group',
    '',
    ...releasedGroupIds.map(gid => `- \`${gid}\``),
    '',
    '## 未放行 Group',
    '',
    ...depGroups.filter(g => !releasedGroupIds.includes(g.group_id)).map(g => `- \`${g.group_id}\`（feature: ${g.feature_ids.join(', ')}）`),
  ];
  fs.writeFileSync(summaryPath, summaryLines.join('\n') + '\n', 'utf8');

  if (!allGroupsReleased || failedFeatures.length > 0 || blockedFeatures.length > 0) {
    dr.status       = 'failed';
    dr.completed_at = completedAtStr;
    dr.outputs.decision = 'needs_fix';
    dr.validation   = {
      passed:                  false,
      checked_at:              completedAtStr,
      summary:                 `${failedFeatures.length} 个 feature 失败，${blockedFeatures.length} 个 feature 有 blocking gap`,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    };
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;
    writeStagesJson(stagesObj);

    log.error('validation_fail', 'design-review validate 失败', {
      decision:             'needs_fix',
      blocking_feature_ids: [...failedFeatures, ...blockedFeatures],
      blocking_count:       blockingCount,
      exit_code:            4,
    });
    log.error('stage_failed', 'design-review stage 验证失败', {
      stage:              'design-review',
      step:               'validate',
      exit_code:          4,
      reason:             `${failedFeatures.length} failed, ${blockedFeatures.length} blocked`,
      duration_ms:        dr.outputs.duration_ms,
    });
    process.exit(4);
  }

  dr.status           = 'completed';
  dr.completed_at     = completedAtStr;
  dr.outputs.decision = 'passed';
  dr.validation       = {
    passed:                  true,
    checked_at:              completedAtStr,
    summary:                 '所有 group 已放行，可进入 codegen',
    required_files:          [],
    missing_required_fields: [],
    warnings:                [],
  };
  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;

  const sp   = writeStagesJson(stagesObj);
  const stat = fs.statSync(sp);

  log.info('validation_pass', 'design-review validate 通过', {
    decision:         'passed',
    can_enter_codegen: true,
    gaps_total:       allGaps.length,
    blocking_count:   blockingCount,
    warning_count:    warningCount,
    per_feature_decisions: Object.fromEntries(
      targetFeatureIds.map(fid => [fid, featureStatuses[fid] && featureStatuses[fid].decision])
    ),
  });
  log.info('file_updated', '已写 design-review 完成态', {
    path:               sp,
    size_bytes:         stat.size,
    status:             'completed',
    design_bundle_hash: dr.inputs && dr.inputs.design_bundle_hash,
    features_reviewed:  targetFeatureIds.length,
  });

  await gitStageSync.finalizeStageGit(projectRoot, 'design-review', {
    readStagesJson, writeStagesJson, log,
  });
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  // 0. 启动时检测 stop.signal
  if (checkStopSignal()) gracefulStop(readStagesJson());

  log.info('stage_start', `design-review stage 启动 [${mode}]，项目: ${projectRoot}`, {
    run_id:         runId,
    stage:          'design-review',
    project:        projectRoot,
    started_at:     startedAtStr,
    mode,
    feature_filter: featureFilter || null,
  });

  // 1. 读取 stages.json
  let stagesObj = readStagesJson();
  if (!stagesObj) {
    log.error('stage_failed', 'stages.json 不存在，请先运行 setup', {
      stage: 'design-review', exit_code: 1, reason: 'stages.json missing', duration_ms: 0,
    });
    process.exit(1);
  }

  // 2. 上游门闸：prd_review.outputs.decision=passed
  const prdReviewStage = stagesObj.stages && stagesObj.stages.prd_review;
  const decision       = prdReviewStage && prdReviewStage.outputs && prdReviewStage.outputs.decision;

  if (decision !== 'passed') {
    log.error('stage_failed', `上游门闸未满足：prd_review.outputs.decision=${decision}`, {
      stage:       'design-review',
      exit_code:   1,
      reason:      `prd_review.outputs.decision=${decision || 'missing'}`,
      duration_ms: 0,
    });
    process.exit(1);
  }

  // 2b. 上游门闸：design bootstrap 已完成（dependency_groups 非空）
  const designStage  = stagesObj.stages && stagesObj.stages.design;
  const depGroups    = (designStage && designStage.inputs && designStage.inputs.dependency_groups) || [];

  if (!depGroups || depGroups.length === 0) {
    log.error('stage_failed', '上游门闸未满足：design.inputs.dependency_groups 为空（design bootstrap 未完成）', {
      stage:       'design-review',
      exit_code:   1,
      reason:      'design.inputs.dependency_groups empty, design bootstrap not completed',
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
    log.info('stage_complete', `design-review bootstrap 完成，耗时 ${dms}ms`, {
      stage: 'design-review', duration_ms: dms, exit_code: 0, mode: 'bootstrap',
    });
    process.exit(0);
  }

  // ── tick 模式 ───────────────────────────────────────────────────
  if (mode === 'tick') {
    if (checkStopSignal()) gracefulStop(readStagesJson());

    const { allDone, hasFailed, timedOutDetected } = await doTick(stagesObj, config, featureFilter);
    const dms = Date.now() - startedAt.getTime();

    if (allDone) {
      // 更新 stage 整体状态（tick 模式下仅更新，不 validate）
      stagesObj = readStagesJson();
      const drStage = stagesObj.stages.design_review;
      if (drStage && drStage.status !== 'completed' && drStage.status !== 'failed') {
        const completedAtStr = formatLocalTimeShort();

        // 检查是否有 released group
        const releasedGroupIds = ((drStage.outputs && drStage.outputs.released_groups) || []).map(g => typeof g === 'string' ? g : g.group_id);
        const allGroupsReleased = depGroups.every(g => releasedGroupIds.includes(g.group_id));

        if (!hasFailed && allGroupsReleased) {
          drStage.status       = 'completed';
          drStage.completed_at = completedAtStr;
          drStage.outputs.decision = 'passed';
          drStage.outputs.duration_ms = dms;
          drStage.validation = {
            passed: true, checked_at: completedAtStr,
            summary: '所有 group 已放行', required_files: [],
            missing_required_fields: [], warnings: [],
          };
        } else {
          drStage.status       = hasFailed ? 'failed' : 'running';
          drStage.completed_at = hasFailed ? completedAtStr : null;
          if (hasFailed) drStage.outputs.decision = 'needs_fix';
          drStage.outputs.duration_ms = dms;
        }
        if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;
        writeStagesJson(stagesObj);
        if (!hasFailed && drStage.status === 'completed') {
          await gitStageSync.finalizeStageGit(projectRoot, 'design-review', {
            readStagesJson, writeStagesJson, log,
          });
        }
      }
    }

    log.info('stage_complete', `design-review tick 完成，耗时 ${dms}ms`, {
      stage:        'design-review',
      duration_ms:  dms,
      exit_code:    0,
      mode:         'tick',
      all_done:     allDone,
      has_failed:   hasFailed,
      timed_out:    timedOutDetected,
    });
    process.exit(0);
  }

  // ── 批量模式（默认）────────────────────────────────────────────
  const { targetFeatureIds } = await doBootstrap(stagesObj, config);
  stagesObj = readStagesJson();

  let iterations      = 0;
  const maxIterations = targetFeatureIds.length * ((config.maxRetries || 2) + 3) + 10;

  while (iterations < maxIterations) {
    iterations++;

    if (checkStopSignal()) gracefulStop(readStagesJson());

    stagesObj = readStagesJson();
    const { allDone, hasFailed, timedOutDetected } = await doTick(stagesObj, config, featureFilter);

    if (timedOutDetected) {
      const dms = Date.now() - startedAt.getTime();
      log.error('stage_failed', 'design-review stage 超时', {
        stage: 'design-review', step: 'tick', exit_code: 3, reason: 'agent timeout', duration_ms: dms,
      });
      process.exit(3);
    }

    if (allDone) break;
  }

  // 步骤 3: validate
  stagesObj = readStagesJson();
  await doValidate(stagesObj, targetFeatureIds);

  const dms = Date.now() - startedAt.getTime();
  log.info('stage_complete', `design-review stage 完成，耗时 ${dms}ms`, {
    stage:              'design-review',
    duration_ms:        dms,
    exit_code:          0,
    features_reviewed:  targetFeatureIds.length,
    effective_parallel: config.effectiveParallel,
    decision:           'passed',
  });
  process.exit(0);
}

main().catch(err => {
  console.error(`[FATAL] design-review.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

'use strict';

/**
 * design.cjs — design stage 编排入口
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. 上游门闸：stages.prd_review.outputs.decision=passed → exit 1
 *   2. 检测 stop.signal → exit 5
 *   --bootstrap 模式：
 *     3. 计算 hash，门控判断整体跳过（exit 0 if skipped）
 *     4. 构建 dependency_groups（拓扑排序，循环依赖 → exit 1）
 *     5. 初始化 stages.design 骨架，写 stages.json
 *   --tick 模式：
 *     3. 若 bootstrap 未完成则先执行 bootstrap
 *     4. 检测 stop.signal → exit 5
 *     5. 调度就绪 feature Agent（组感知 + 拓扑排序，受 effective_parallel 限制）
 *     6. 更新 stages.json，exit 0
 *   --feature=<id> 模式：同 tick，但只调度指定 feature
 *   批量模式（无 --tick / --bootstrap）：bootstrap + loop tick + validate
 *   → exit 0 成功 / exit 1 门闸/循环依赖 / exit 3 超时 / exit 4 质量门失败 / exit 5 stop.signal
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

const isBootstrap  = args.bootstrap === true || args.bootstrap === 'true';
const isTick       = args.tick === true || args.tick === 'true';
const featureFilter = args.feature || null;
const forceRerun   = args['force-rerun'] === true || args['force-rerun'] === 'true';

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
const log = createLogger({ projectRoot, stage: 'design', runId });

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
    stage: 'design', reason, stopped_at: stoppedAt,
  });

  if (stagesObj && stagesObj.stages) {
    if (!stagesObj.stages.design) {
      stagesObj.stages.design = { status: 'stopped' };
    } else {
      stagesObj.stages.design.status = 'stopped';
    }
    if (stagesObj.pipeline) {
      stagesObj.pipeline.updated_at = stoppedAt;
      stagesObj.pipeline.stop_info  = { stopped_at: stoppedAt, stopped_stage: 'design', reason };
    }
    writeStagesJson(stagesObj);
  }

  try {
    const sig = path.join(projectRoot, '.pipeline', 'stop.signal');
    if (fs.existsSync(sig)) fs.unlinkSync(sig);
  } catch (_) { /* ignore */ }

  log.info('pipeline_stopped', 'design stage 已优雅停止', {
    stage: 'design', stopped_at: stoppedAt, exit_code: 5,
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
  const timeoutS       = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.design_s) || 1200;
  const maxRetries     = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.design && cfg.pipeline.stages.design.max_retries) || 2;
  const model          = (cfg.pipeline && cfg.pipeline.model) || 'composer-2';
  const stageParallel  = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.design && cfg.pipeline.stages.design.feature_max_parallel) || 3;
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
  const p = path.join(skillsRoot, 'ai-std3', 'schemas', schemaName);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function validateDesignJson(data) {
  try {
    const schema = loadSchema('design.json.schema.json');
    if (!schema) return { valid: true, errors: [] };
    const ajv = getAjv();
    if (!ajv) return { valid: true, errors: [] };
    const validate = ajv.compile(schema);
    const valid = validate(data);
    return { valid, errors: validate.errors || [] };
  } catch (_) {
    return { valid: true, errors: [] };
  }
}

// ── 依赖组构建（有向图拓扑排序 + 连通分量分组）──────────────────
/**
 * 将 features[] 按依赖关系构建连通分量（groups），
 * 组内按有向依赖做拓扑排序（topo_order）。
 * 返回 { groups, cycleFeatureIds }。
 */
function buildDependencyGroups(features) {
  const featureIdSet = new Set(features.map(f => f.feature_id));

  // 无向邻接表（用于连通分量）
  const undirAdj = new Map();
  // 有向依赖：fid → deps[]（fid 依赖 deps）
  const dirDeps  = new Map();

  for (const f of features) {
    undirAdj.set(f.feature_id, new Set());
    dirDeps.set(f.feature_id, []);
  }

  for (const f of features) {
    const deps = (f.dependencies || []).filter(d => featureIdSet.has(d));
    dirDeps.set(f.feature_id, deps);
    for (const dep of deps) {
      undirAdj.get(f.feature_id).add(dep);
      if (undirAdj.has(dep)) undirAdj.get(dep).add(f.feature_id);
    }
  }

  // BFS 求连通分量
  const visited    = new Set();
  const components = [];

  for (const fid of featureIdSet) {
    if (visited.has(fid)) continue;
    const component = [];
    const queue     = [fid];
    visited.add(fid);
    while (queue.length > 0) {
      const cur = queue.shift();
      component.push(cur);
      for (const nb of (undirAdj.get(cur) || [])) {
        if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
      }
    }
    component.sort();
    components.push(component);
  }

  // 对每个连通分量做 Kahn 拓扑排序
  const groups         = [];
  const cycleFeatureIds = [];

  for (const component of components) {
    const compSet = new Set(component);

    // 入度表 + 出边表（component 内部有向图）
    const inDegree = new Map(component.map(fid => [fid, 0]));
    const outEdges = new Map(component.map(fid => [fid, []]));

    for (const fid of component) {
      for (const dep of (dirDeps.get(fid) || []).filter(d => compSet.has(d))) {
        inDegree.set(fid, inDegree.get(fid) + 1);
        outEdges.get(dep).push(fid);
      }
    }

    // Kahn 算法（队列保持字典序以保证稳定性）
    const queue     = component.filter(fid => inDegree.get(fid) === 0).sort();
    const topoOrder = [];

    while (queue.length > 0) {
      queue.sort();
      const cur = queue.shift();
      topoOrder.push(cur);
      for (const next of (outEdges.get(cur) || [])) {
        const deg = inDegree.get(next) - 1;
        inDegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }

    if (topoOrder.length !== component.length) {
      // 存在环
      const inCycle = component.filter(fid => !topoOrder.includes(fid));
      cycleFeatureIds.push(...inCycle);
      continue;
    }

    const groupId = 'group-' + crypto.createHash('sha256')
      .update(component.join(','))
      .digest('hex')
      .slice(0, 8);

    groups.push({
      group_id:               groupId,
      feature_ids:            component,
      topo_order:             topoOrder,
      dependencies_on_groups: [],
    });
  }

  return { groups, cycleFeatureIds };
}

/** 计算 phase_plan 的稳定 SHA-256 哈希 */
function computePhasePlanHash(phasePlan) {
  if (!Array.isArray(phasePlan) || phasePlan.length === 0) return null;
  const sorted = [...phasePlan].sort((a, b) => String(a.phase).localeCompare(String(b.phase)));
  const str = JSON.stringify(sorted.map(p => ({
    phase:       p.phase,
    feature_ids: [...(p.feature_ids || [])].sort(),
  })));
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ── Bootstrap ────────────────────────────────────────────────────
/**
 * 初始化 stages.design 骨架：
 *   - 从 prd.outputs.features[] + prd_review.review.phase_plan 获取 targetFeatureIds
 *   - 构建 dependency_groups（拓扑排序）
 *   - 初始化 feature 状态（pending / 保留 completed/failed / 重置 running zombie）
 *   - 写 stages.json
 *   - 返回 { groups, targetFeatureIds }
 */
async function doBootstrap(stagesObj, config) {
  const startedAtStr = formatLocalTimeShort();

  const prdStage       = stagesObj.stages && stagesObj.stages.prd;
  const prdReviewStage = stagesObj.stages && stagesObj.stages.prd_review;

  const allFeatures   = (prdStage && prdStage.outputs && prdStage.outputs.features) || [];
  if (allFeatures.length === 0) {
    log.error('stage_failed', 'bootstrap: prd.outputs.features[] 为空', {
      stage: 'design', exit_code: 1, reason: 'prd.outputs.features[] is empty', duration_ms: 0,
    });
    process.exit(1);
  }

  // 从 phase_plan 展开待设计 feature_ids
  const phasePlan = (prdReviewStage && prdReviewStage.review && prdReviewStage.review.phase_plan) || [];
  let targetFeatureIds = phasePlan.flatMap(p => p.feature_ids || []);

  // 若 phase_plan 为空，使用所有 prd features（兼容测试 / 单独调用）
  if (targetFeatureIds.length === 0) {
    targetFeatureIds = allFeatures.map(f => f.feature_id);
  }
  targetFeatureIds = [...new Set(targetFeatureIds)];

  // 交叉校验：所有 targetFeatureIds 必须在 prd.outputs.features[] 中
  const allFeatureIdSet = new Set(allFeatures.map(f => f.feature_id));
  const missingIds = targetFeatureIds.filter(id => !allFeatureIdSet.has(id));
  if (missingIds.length > 0) {
    log.error('stage_failed', 'bootstrap: phase_plan 包含未在 prd.outputs.features 中的 feature_id', {
      stage: 'design', exit_code: 1, reason: `missing feature_ids: ${missingIds.join(', ')}`, duration_ms: 0,
    });
    process.exit(1);
  }

  const targetFeatures = allFeatures.filter(f => targetFeatureIds.includes(f.feature_id));

  // 计算 hash
  const phasePlanHashNew = computePhasePlanHash(phasePlan);
  const prdSpecPath      = path.join(projectRoot, 'docs', 'prd-spec.md');
  const prdSpecHashNew   = fileSha256(prdSpecPath);

  const existingDesign = stagesObj.stages && stagesObj.stages.design;

  // hash 门控：phase_plan_hash 命中 + status=completed + 所有 design.json 文件 hash 匹配 → 整体跳过
  if (!forceRerun && existingDesign && existingDesign.status === 'completed') {
    const storedPhasePlanHash = existingDesign.inputs && existingDesign.inputs.phase_plan_hash;
    if (phasePlanHashNew && storedPhasePlanHash && phasePlanHashNew === storedPhasePlanHash) {
      const designFeatures = existingDesign.features || {};
      const allFresh = targetFeatureIds.every(fid => {
        const storedHash  = designFeatures[fid] && designFeatures[fid].design_hash;
        const currentHash = fileSha256(path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`));
        return storedHash && currentHash && storedHash === currentHash;
      });
      if (allFresh) {
        log.info('stage_skipped', 'design hash 门控命中，跳过整段执行', {
          stage: 'design', reason: 'phase_plan_hash matched, all designs fresh', exit_code: 0,
        });
        process.exit(0);
      }
    }
  }

  // 构建依赖组（拓扑排序 + 连通分量）
  const { groups, cycleFeatureIds } = buildDependencyGroups(targetFeatures);

  if (cycleFeatureIds.length > 0) {
    log.error('validation_fail', 'design bootstrap 检测到循环依赖', {
      cycle_feature_ids: cycleFeatureIds, exit_code: 1,
    });
    if (!stagesObj.stages) stagesObj.stages = {};
    stagesObj.stages.design = Object.assign(stagesObj.stages.design || {}, {
      status: 'failed',
      blocking_issues: [`循环依赖：${cycleFeatureIds.join(', ')}`],
    });
    writeStagesJson(stagesObj);
    process.exit(1);
  }

  // feature_id → group_id 映射
  const featureGroupMap = {};
  for (const group of groups) {
    for (const fid of group.feature_ids) featureGroupMap[fid] = group.group_id;
  }

  // 判断 phase_plan_hash 是否发生变化
  const storedPhasePlanHash = existingDesign && existingDesign.inputs && existingDesign.inputs.phase_plan_hash;
  const phasePlanChanged    = !existingDesign || !storedPhasePlanHash || phasePlanHashNew !== storedPhasePlanHash;
  const existingFeatures    = (existingDesign && existingDesign.features) || {};

  // 记录被重置的 zombie running feature（用于日志）
  const zombieResetList = Object.entries(existingFeatures)
    .filter(([, v]) => v && v.status === 'running')
    .map(([k]) => k);

  // 初始化 feature 状态
  const features = {};
  for (const fid of targetFeatureIds) {
    const existing = existingFeatures[fid];
    if (phasePlanChanged) {
      // phase_plan 变化 → 全部重置为 pending
      features[fid] = {
        status: 'pending', group_id: featureGroupMap[fid] || null,
        started_at: null, completed_at: null, attempts: 0,
        design_file: null, design_hash: null, error: null,
      };
    } else if (!existingDesign || !existing) {
      // 首次运行 / 新增 feature
      features[fid] = {
        status: 'pending', group_id: featureGroupMap[fid] || null,
        started_at: null, completed_at: null, attempts: 0,
        design_file: null, design_hash: null, error: null,
      };
    } else {
      // 保留已有状态；将 running zombie 重置为 pending
      const status = existing.status === 'running' ? 'pending' : existing.status;
      features[fid] = Object.assign({}, existing, {
        status,
        group_id:    featureGroupMap[fid] || null,
        started_at:  existing.started_at  || null,
        completed_at:existing.completed_at || null,
        attempts:    existing.attempts    || 0,
        design_file: existing.design_file || null,
        design_hash: existing.design_hash || null,
        error:       existing.error       || null,
      });
    }
  }

  // 写 stages.design
  if (!stagesObj.stages) stagesObj.stages = {};
  const prdReviewOutputHash = fileSha256(path.join(projectRoot, '.pipeline', 'prd-review-output.json'));

  stagesObj.stages.design = {
    status:       'running',
    started_at:   startedAtStr,
    completed_at: null,
    inputs: {
      prd_review_hash:   prdReviewOutputHash,
      phase_plan_hash:   phasePlanHashNew,
      prd_spec_hash:     prdSpecHashNew,
      feature_ids:       targetFeatureIds,
      dependency_groups: groups,
    },
    outputs: {
      design_files:   {},
      design_specs:   [],
      duration_ms:    null,
      timed_out:      false,
      timeout_reason: null,
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
    git_sync: (existingDesign && existingDesign.git_sync) || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  };

  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = startedAtStr;
  const sp   = writeStagesJson(stagesObj);
  const stat = fs.statSync(sp);

  log.info('file_updated', '已写 stages.design bootstrap 骨架', {
    path:                sp,
    size_bytes:          stat.size,
    status:              'running',
    phase_plan_hash_changed: phasePlanChanged,
    zombie_features_reset:   zombieResetList,
  });

  log.info('validation_pass', 'design bootstrap 完成', {
    feature_ids:        targetFeatureIds,
    phase_plan_hash:    phasePlanHashNew,
    groups_count:       groups.length,
    dependency_groups:  groups.map(g => ({ group_id: g.group_id, feature_ids: g.feature_ids })),
    effective_parallel: config.effectiveParallel,
  });

  return { groups, targetFeatureIds };
}

// ── Agent 调用 ────────────────────────────────────────────────────
async function invokeDesignAgent({ featureId, featureMeta, model, timeoutMs }) {
  const agentId    = `design-agent-${featureId}`;
  const promptFile = 'design-spec.md';
  const promptPath = path.join(skillsRoot, 'ai-std3', 'prompts', promptFile);

  if (!fs.existsSync(promptPath)) {
    return { success: false, timedOut: false, error: `Prompt file not found: ${promptPath}`, agentRunId: null };
  }

  let promptContent = fs.readFileSync(promptPath, 'utf8');

  // 依赖 feature 的 design.json 路径
  const depDesignFiles = (featureMeta.dependencies || [])
    .filter(d => fs.existsSync(path.join(projectRoot, 'docs', 'designs', `${d}.design.json`)))
    .map(d => path.join(projectRoot, 'docs', 'designs', `${d}.design.json`));

  // 涉及的 PRD / feature_list 文件
  const clientTargets = featureMeta.client_targets || (featureMeta.client_target ? [featureMeta.client_target] : []);
  const prdFiles = [];
  for (const ct of clientTargets) {
    const pf = path.join(projectRoot, 'docs', `prd-${ct}.json`);
    const fl = path.join(projectRoot, 'docs', `feature_list-${ct}.md`);
    if (fs.existsSync(pf)) prdFiles.push(pf);
    if (fs.existsSync(fl)) prdFiles.push(fl);
  }

  const prdSpecPath = path.join(projectRoot, 'docs', 'prd-spec.md');
  const designDir   = path.join(projectRoot, 'docs', 'designs');
  const outputFile  = path.join(designDir, `${featureId}.design.json`);

  // 注入上下文
  const ctx = [
    `<!-- inject: feature_id=${featureId} -->`,
    `<!-- inject: project_root=${projectRoot} -->`,
    `<!-- inject: feature_meta=${JSON.stringify(featureMeta)} -->`,
    `<!-- inject: output_file=${outputFile} -->`,
    prdFiles.length > 0        ? `<!-- inject: prd_files=${prdFiles.join(',')} -->` : '',
    depDesignFiles.length > 0  ? `<!-- inject: dep_design_files=${depDesignFiles.join(',')} -->` : '',
  ].filter(Boolean).join('\n');

  const finalPrompt = promptContent + '\n\n' + ctx;

  log.info('agent_start', `启动 design Agent: ${agentId}`, {
    agent_id:       agentId,
    feature_id:     featureId,
    prompt:         promptFile,
    input_files:    [prdSpecPath, ...prdFiles, ...depDesignFiles],
    model,
    dependencies:   featureMeta.dependencies || [],
    client_targets: clientTargets,
  });

  fs.mkdirSync(designDir, { recursive: true });

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
async function runDesignAgentForFeature({ featureId, featureMeta, model, timeoutMs, maxRetries }) {
  const agentId    = `design-agent-${featureId}`;
  const outputFile = path.join(projectRoot, 'docs', 'designs', `${featureId}.design.json`);

  let lastError = null;
  let timedOut  = false;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      log.warn('agent_retry', `design Agent(${featureId}) 第 ${attempt} 次重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
    }

    const t0     = Date.now();
    const result = await invokeDesignAgent({ featureId, featureMeta, model, timeoutMs });
    const dms    = Date.now() - t0;

    if (result.timedOut) {
      timedOut  = true;
      lastError = result.error;
      log.error('agent_failed', `design Agent(${featureId}) 超时`, {
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
      log.warn('agent_retry', `design Agent(${featureId}) 输出文件缺失，重试`, {
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
      log.warn('agent_retry', `design Agent(${featureId}) JSON 解析失败，重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
      continue;
    }

    // Ajv schema 校验
    const { valid, errors } = validateDesignJson(outputData);
    if (!valid) {
      const invalidFields = errors.map(e => e.instancePath + ' ' + e.message).join('; ');
      lastError = `Schema validation failed: ${invalidFields}`;
      log.warn('agent_retry', `design Agent(${featureId}) schema 校验失败，重试`, {
        agent_id: agentId, feature_id: featureId, attempt,
        reason: 'schema_validation_failed', invalid_fields: invalidFields,
      });
      if (attempt > maxRetries) break;
      continue;
    }

    // acceptance >= 3 检查
    if (!Array.isArray(outputData.acceptance) || outputData.acceptance.length < 3) {
      lastError = 'acceptance 必须至少包含 3 条验收标准';
      if (attempt > maxRetries) break;
      log.warn('agent_retry', `design Agent(${featureId}) acceptance 不足，重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
      continue;
    }

    // 成功
    const designHash = fileSha256(outputFile);
    log.info('agent_complete', `design Agent(${featureId}) 完成`, {
      agent_id:          agentId,
      feature_id:        featureId,
      duration_ms:       dms,
      output_files:      [outputFile],
      dependencies_count: (featureMeta.dependencies || []).length,
    });
    return { success: true, timedOut: false, featureId, designHash, durationMs: dms, error: null };
  }

  log.error('agent_failed', `design Agent(${featureId}) 超过最大重试次数`, {
    agent_id: agentId, feature_id: featureId,
    max_attempts: maxRetries + 1, last_error: lastError, exit_code: 4,
  });
  return { success: false, timedOut, featureId, error: lastError, durationMs: 0 };
}

// ── 并发 Worker Pool ──────────────────────────────────────────────
async function runAgentsConcurrent({ readyFeatureIds, featuresMap, config }) {
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

      const featureMeta = featuresMap.get(fid);
      if (!featureMeta) {
        results.push({ success: false, timedOut: false, featureId: fid, error: 'feature meta not found' });
        continue;
      }

      const result = await runDesignAgentForFeature({ featureId: fid, featureMeta, model, timeoutMs, maxRetries });
      results.push(result);
    }
  }

  const concurrency = Math.max(1, Math.min(effectiveParallel, readyFeatureIds.length));
  const workers     = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return { results, stoppedFound };
}

// ── tick：单轮调度 ────────────────────────────────────────────────
/**
 * 执行一轮 design Agent 调度：
 *   - 找就绪 feature（pending + 依赖已 completed）
 *   - hash 门控：design.json 存在且 hash 命中 → 标 completed 跳过
 *   - 启动 ≤ effectiveParallel 个 Agent，等待完成
 *   - 更新 stages.json
 *   - 若全部 feature 完成（completed/failed/skipped），更新 stage 整体状态
 *
 * 返回 { allDone, hasFailed, timedOutDetected }
 */
async function doTick(stagesObj, config, featureFilterId) {
  // 若 bootstrap 尚未完成，先执行 bootstrap
  if (!stagesObj.stages || !stagesObj.stages.design) {
    log.info('file_updated', 'design stage 未 bootstrap，先执行 bootstrap', { status: 'bootstrapping' });
    await doBootstrap(stagesObj, config);
    stagesObj = readStagesJson();
  }

  const design          = stagesObj.stages.design;
  const allFeaturesData = (stagesObj.stages.prd && stagesObj.stages.prd.outputs && stagesObj.stages.prd.outputs.features) || [];
  const featuresMap     = new Map(allFeaturesData.map(f => [f.feature_id, f]));
  const featureStatuses = design.features || {};
  const targetFeatureIds = (design.inputs && design.inputs.feature_ids) || Object.keys(featureStatuses);

  // 作用域：单 feature 模式下只处理指定 id
  const scopeIds = featureFilterId
    ? targetFeatureIds.filter(id => id === featureFilterId)
    : targetFeatureIds;

  // 第零步：上轮 tick 被中断时，遗留的 running 无对应 Agent，须重置为 pending 才能再次调度
  const zombieResetList = [];
  for (const fid of scopeIds) {
    if (featureStatuses[fid] && featureStatuses[fid].status === 'running') {
      featureStatuses[fid].status = 'pending';
      zombieResetList.push(fid);
    }
  }
  if (zombieResetList.length > 0) {
    writeStagesJson(stagesObj);
    log.warn('zombie_reset', `design tick 重置 ${zombieResetList.length} 个僵尸 running feature`, {
      feature_ids: zombieResetList,
    });
  }

  // 第一步：对 pending feature 做 hash / 磁盘门控（design.json 已存在且有效 → 标 completed）
  let hashGateChanged = false;
  for (const fid of scopeIds) {
    if (!featureStatuses[fid] || featureStatuses[fid].status !== 'pending') continue;
    if (forceRerun) continue;

    const designFile  = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    if (!fs.existsSync(designFile)) continue;

    const storedHash  = featureStatuses[fid].design_hash;
    const currentHash = fileSha256(designFile);
    if (!currentHash) continue;

    let skipReason = null;
    if (storedHash && storedHash === currentHash) {
      skipReason = 'design_hash matched';
    } else if (!storedHash) {
      try {
        const data = JSON.parse(fs.readFileSync(designFile, 'utf8'));
        const { valid } = validateDesignJson(data);
        if (valid && Array.isArray(data.acceptance) && data.acceptance.length >= 3) {
          skipReason = 'design_file on disk';
        }
      } catch (_) { /* 无效文件，继续走 Agent */ }
    }

    if (skipReason) {
      featureStatuses[fid].status       = 'completed';
      featureStatuses[fid].design_file  = designFile;
      featureStatuses[fid].design_hash  = currentHash;
      featureStatuses[fid].completed_at = featureStatuses[fid].completed_at || formatLocalTimeShort();
      featureStatuses[fid].error        = null;
      hashGateChanged = true;
      log.info('agent_skipped', `feature ${fid} 门控命中，跳过 Agent`, {
        agent_id: `design-agent-${fid}`, feature_id: fid, reason: skipReason,
      });
    }
  }
  if (hashGateChanged) {
    writeStagesJson(stagesObj);
    // 不重新读取 stagesObj：hash 门控的修改已在内存中，保持 design/featureStatuses 引用一致
  }

  // 第二步：找就绪 feature（pending 且所有在本期内的依赖已 completed/skipped）
  const readyFeatureIds = [];
  for (const fid of scopeIds) {
    const featureStatus = (featureStatuses[fid] && featureStatuses[fid].status) || 'pending';
    if (featureStatus !== 'pending') continue;

    const featureMeta = featuresMap.get(fid);
    const deps        = ((featureMeta && featureMeta.dependencies) || []).filter(d => targetFeatureIds.includes(d));
    const allDepsOk   = deps.every(d => {
      const s = featureStatuses[d] && featureStatuses[d].status;
      return s === 'completed' || s === 'skipped';
    });
    if (allDepsOk) readyFeatureIds.push(fid);
  }

  // 检查整体完成状态（无就绪 feature 时）
  const allDone = scopeIds.every(fid => {
    const s = (featureStatuses[fid] && featureStatuses[fid].status) || 'pending';
    return s === 'completed' || s === 'failed' || s === 'skipped';
  });

  if (readyFeatureIds.length === 0) {
    if (allDone) {
      const hasFailed = scopeIds.some(fid => featureStatuses[fid] && featureStatuses[fid].status === 'failed');
      return { allDone: true, hasFailed, timedOutDetected: false };
    }
    // 有 pending feature 但依赖未满足（正常等待下一轮 tick）
    return { allDone: false, hasFailed: false, timedOutDetected: false };
  }

  // 第三步：批次启动 Agent
  const waveIndex = (design.inputs && design.inputs._tick_wave_index || 0) + 1;
  const batchId   = `design-wave-${waveIndex}`;

  log.info('agent_batch_start', `design Agent 批次开始，共 ${readyFeatureIds.length} 个 feature`, {
    batch_id:           batchId,
    wave_index:         waveIndex,
    feature_ids:        readyFeatureIds,
    agents_total:       readyFeatureIds.length,
    effective_parallel: config.effectiveParallel,
  });

  // 标记 running（批次启动前写入）
  const tickStartedAt = formatLocalTimeShort();
  for (const fid of readyFeatureIds) {
    if (!featureStatuses[fid]) featureStatuses[fid] = {};
    featureStatuses[fid].status     = 'running';
    featureStatuses[fid].started_at = tickStartedAt;
    featureStatuses[fid].attempts   = (featureStatuses[fid].attempts || 0) + 1;
  }
  writeStagesJson(stagesObj);

  // 并发执行 Agent
  const batchT0 = Date.now();
  const { results, stoppedFound } = await runAgentsConcurrent({
    readyFeatureIds, featuresMap, config,
  });
  const batchDurationMs = Date.now() - batchT0;

  // 处理 stop signal（在 worker 中检测到）
  if (stoppedFound) {
    gracefulStop(readStagesJson());
  }

  // 处理结果（串行写入，避免并发写 stages.json）
  stagesObj = readStagesJson();
  const designStage     = stagesObj.stages.design;
  const featureStatusesFresh = designStage.features || {};

  const succeededIds = [];
  const failedIds    = [];
  let timedOutDetected = false;

  for (const r of results) {
    if (r.stopped) continue;
    const completedAtStr = formatLocalTimeShort();
    const fStatus        = featureStatusesFresh[r.featureId] || {};

    if (r.success) {
      const designFile = path.join(projectRoot, 'docs', 'designs', `${r.featureId}.design.json`);
      fStatus.status       = 'completed';
      fStatus.completed_at = completedAtStr;
      fStatus.design_file  = designFile;
      fStatus.design_hash  = r.designHash || fileSha256(designFile);
      fStatus.error        = null;

      if (!designStage.outputs) designStage.outputs = { design_files: {}, design_specs: [] };
      if (!designStage.outputs.design_files) designStage.outputs.design_files = {};
      designStage.outputs.design_files[r.featureId] = designFile;

      succeededIds.push(r.featureId);

      log.info('feature_design_ready', `feature ${r.featureId} design 完成，可进入 design-review`, {
        feature_id: r.featureId,
        group_id:   fStatus.group_id || null,
        design_hash: fStatus.design_hash,
      });
    } else {
      if (r.timedOut) timedOutDetected = true;
      fStatus.status = 'failed';
      fStatus.error  = r.error;
      failedIds.push(r.featureId);
    }

    featureStatusesFresh[r.featureId] = fStatus;
  }

  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = formatLocalTimeShort();
  writeStagesJson(stagesObj);

  // 日志：batch complete
  const skippedIds = readyFeatureIds.filter(id => !succeededIds.includes(id) && !failedIds.includes(id));
  log.info('agent_batch_complete', 'design Agent 批次结束', {
    batch_id:         batchId,
    wave_index:       waveIndex,
    agents_succeeded: succeededIds,
    agents_failed:    failedIds,
    agents_skipped:   skippedIds,
    duration_ms:      batchDurationMs,
  });

  // 重新检查是否全部完成
  const freshStatuses  = stagesObj.stages.design.features || {};
  const allDoneNow     = scopeIds.every(fid => {
    const s = (freshStatuses[fid] && freshStatuses[fid].status) || 'pending';
    return s === 'completed' || s === 'failed' || s === 'skipped';
  });
  const hasFailed = scopeIds.some(fid => freshStatuses[fid] && freshStatuses[fid].status === 'failed');

  return { allDone: allDoneNow, hasFailed, timedOutDetected };
}

// ── 步骤 3：validate + 写完成态 ──────────────────────────────────
async function doValidate(stagesObj, targetFeatureIds, config) {
  const design          = stagesObj.stages.design;
  const featureStatuses = design.features || {};
  const completedAtStr  = formatLocalTimeShort();
  const failedFeatureIds = targetFeatureIds.filter(fid =>
    featureStatuses[fid] && featureStatuses[fid].status === 'failed'
  );
  const missingFiles = [];
  const designSpecs  = [];

  for (const fid of targetFeatureIds) {
    const designFile = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);

    if (!fs.existsSync(designFile)) {
      if (featureStatuses[fid] && featureStatuses[fid].status === 'completed') {
        missingFiles.push(designFile);
      }
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(designFile, 'utf8'));
      const { valid, errors } = validateDesignJson(data);

      if (!valid || !Array.isArray(data.acceptance) || data.acceptance.length < 3) {
        if (!failedFeatureIds.includes(fid)) failedFeatureIds.push(fid);
        continue;
      }

      designSpecs.push({
        feature_id:        data.feature_id || fid,
        client_target:     data.client_target,
        phase:             data.phase,
        new_files_count:   (data.file_plan && data.file_plan.new_files  && data.file_plan.new_files.length)   || 0,
        modify_files_count:(data.file_plan && data.file_plan.modify_files && data.file_plan.modify_files.length) || 0,
        design_hash:       fileSha256(designFile),
      });
    } catch (e) {
      if (!failedFeatureIds.includes(fid)) failedFeatureIds.push(fid);
    }
  }

  design.outputs.design_specs = designSpecs;

  if (failedFeatureIds.length > 0 || missingFiles.length > 0) {
    design.status       = 'failed';
    design.completed_at = completedAtStr;
    design.validation   = {
      passed:                  false,
      checked_at:              completedAtStr,
      summary:                 `${failedFeatureIds.length} 个 feature 失败`,
      required_files:          missingFiles,
      missing_required_fields: [],
      warnings:                [],
    };
    if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;
    writeStagesJson(stagesObj);

    log.error('validation_fail', 'design validate 失败', {
      missing: missingFiles, failed_feature_ids: failedFeatureIds,
    });
    log.error('stage_failed', 'design stage 验证失败', {
      stage: 'design', step: 'validate', exit_code: 4,
      reason: `${failedFeatureIds.length} features failed`, duration_ms: 0,
    });
    process.exit(4);
  }

  const startedAt = design.started_at ? new Date(design.started_at).getTime() : Date.now();
  design.status                 = 'completed';
  design.completed_at           = completedAtStr;
  design.outputs.duration_ms    = Date.now() - startedAt;
  design.validation             = {
    passed:                  true,
    checked_at:              completedAtStr,
    summary:                 '所有 feature 设计完成',
    required_files:          [],
    missing_required_fields: [],
    warnings:                [],
  };
  if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;

  const sp   = writeStagesJson(stagesObj);
  const stat = fs.statSync(sp);

  log.info('validation_pass', 'design validate 通过', {
    features_total:    targetFeatureIds.length,
    design_specs_count: designSpecs.length,
  });
  log.info('file_updated', '已写 design 完成态', {
    path:               sp,
    size_bytes:         stat.size,
    status:             'completed',
    phase_plan_hash:    design.inputs && design.inputs.phase_plan_hash,
    features_completed: targetFeatureIds.length,
  });
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  // 0. 启动时检测 stop.signal
  if (checkStopSignal()) gracefulStop(readStagesJson());

  log.info('stage_start', `design stage 启动 [${mode}]，项目: ${projectRoot}`, {
    run_id:         runId,
    stage:          'design',
    project:        projectRoot,
    started_at:     startedAtStr,
    mode,
    feature_filter: featureFilter || null,
  });

  // 1. 读取 stages.json
  let stagesObj = readStagesJson();
  if (!stagesObj) {
    log.error('stage_failed', 'stages.json 不存在，请先运行 setup', {
      stage: 'design', exit_code: 1, reason: 'stages.json missing', duration_ms: 0,
    });
    process.exit(1);
  }

  // 2. 上游门闸：prd_review.outputs.decision=passed
  const prdReviewStage = stagesObj.stages && stagesObj.stages.prd_review;
  const decision       = prdReviewStage && prdReviewStage.outputs && prdReviewStage.outputs.decision;

  if (decision !== 'passed') {
    log.error('stage_failed', `上游门闸未满足：prd_review.outputs.decision=${decision}`, {
      stage:       'design',
      exit_code:   1,
      reason:      `prd_review.outputs.decision=${decision || 'missing'}`,
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
    log.info('stage_complete', `design bootstrap 完成，耗时 ${dms}ms`, {
      stage: 'design', duration_ms: dms, exit_code: 0, mode: 'bootstrap',
    });
    process.exit(0);
  }

  // ── tick 模式 ───────────────────────────────────────────────────
  if (mode === 'tick') {
    if (checkStopSignal()) gracefulStop(readStagesJson());

    const { allDone, hasFailed, timedOutDetected } = await doTick(stagesObj, config, featureFilter);
    const dms = Date.now() - startedAt.getTime();

    if (allDone) {
      // 更新 stage 整体状态
      stagesObj = readStagesJson();
      const ds  = stagesObj.stages.design;
      if (ds && ds.status !== 'completed' && ds.status !== 'failed') {
        const completedAtStr = formatLocalTimeShort();
        ds.status       = hasFailed ? 'failed' : 'completed';
        ds.completed_at = completedAtStr;
        ds.validation   = {
          passed:                  !hasFailed,
          checked_at:              completedAtStr,
          summary:                 hasFailed ? '存在失败的 feature' : '所有 feature 设计完成',
          required_files:          [],
          missing_required_fields: [],
          warnings:                [],
        };
        if (stagesObj.pipeline) stagesObj.pipeline.updated_at = completedAtStr;
        writeStagesJson(stagesObj);
      }
    }

    log.info('stage_complete', `design tick 完成，耗时 ${dms}ms`, {
      stage:        'design',
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
  // 步骤 1: bootstrap
  const { targetFeatureIds } = await doBootstrap(stagesObj, config);
  stagesObj = readStagesJson();

  // 步骤 2: 循环 tick 直到所有 feature 完成
  let iterations      = 0;
  const maxIterations = targetFeatureIds.length * ((config.maxRetries || 2) + 3) + 10;

  while (iterations < maxIterations) {
    iterations++;

    if (checkStopSignal()) gracefulStop(readStagesJson());

    stagesObj = readStagesJson();
    const { allDone, hasFailed, timedOutDetected } = await doTick(stagesObj, config, featureFilter);

    if (timedOutDetected) {
      const dms = Date.now() - startedAt.getTime();
      log.error('stage_failed', 'design stage 超时', {
        stage: 'design', step: 'tick', exit_code: 3, reason: 'agent timeout', duration_ms: dms,
      });
      process.exit(3);
    }

    if (allDone) break;
  }

  // 步骤 3: validate
  stagesObj = readStagesJson();
  await doValidate(stagesObj, targetFeatureIds, config);

  const dms = Date.now() - startedAt.getTime();
  log.info('stage_complete', `design stage 完成，耗时 ${dms}ms`, {
    stage:              'design',
    duration_ms:        dms,
    exit_code:          0,
    features_total:     targetFeatureIds.length,
    effective_parallel: config.effectiveParallel,
  });
  process.exit(0);
}

main().catch(err => {
  console.error(`[FATAL] design.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

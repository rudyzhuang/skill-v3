'use strict';

/**
 * prd.cjs — prd stage 编排入口
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. 上游门闸：stages.setup.status=completed 且 validation.passed=true → exit 1
 *   2. 检测 stop.signal → exit 5
 *   3. hash 门控（stages.prd.status=completed + req_hash 命中 → skipped exit 0）
 *   4. prd-bootstrap：初始化 stages.prd 骨架、拷贝 prd-spec.md 模板
 *   5. Agent-A（prd-spec-author.md）→ 生成 docs/prd-spec.md
 *   6. 解析 client_targets，检测 stop.signal → exit 5
 *   7. Agent-B 并发（prd-client-author.md × N 端）→ prd-<client_target>.json + feature_list-*.md
 *   8. prd-validate：校验产出、聚合 features[] 索引真源、写完成态
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

const { createLogger, formatLocalTimeShort, datetimeFromRunId } = require('../libs/logger.cjs');

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

// ── 生成 run_id ──────────────────────────────────────────────────
function generateRunId() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hr = pad(now.getHours());
  const min = pad(now.getMinutes());
  const sec = pad(now.getSeconds());
  const hex = crypto.randomBytes(4).toString('hex');
  return `${y}-${mo}-${d}_${hr}-${min}-${sec}-${hex}`;
}

const runId = args['run-id'] || generateRunId();

// ── 初始化 Logger ─────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'prd', runId });

// ── client_target 映射表 ──────────────────────────────────────────
const CLIENT_TARGET_MAP = {
  website:  { file: 'prd-web.json',     schema: 'prd-web.json.schema.json',     template: 'prd-web.json.template'     },
  web:      { file: 'prd-web.json',     schema: 'prd-web.json.schema.json',     template: 'prd-web.json.template'     },
  frontend: { file: 'prd-web.json',     schema: 'prd-web.json.schema.json',     template: 'prd-web.json.template'     },
  admin:    { file: 'prd-admin.json',   schema: 'prd-admin.json.schema.json',   template: 'prd-admin.json.template'   },
  backend:  { file: 'prd-backend.json', schema: 'prd-backend.json.schema.json', template: 'prd-backend.json.template' },
  api:      { file: 'prd-backend.json', schema: 'prd-backend.json.schema.json', template: 'prd-backend.json.template' },
  mobile:   { file: 'prd-mobile.json',  schema: 'prd-mobile.json.schema.json',  template: 'prd-mobile.json.template'  },
};

function resolveClientTarget(target) {
  const lower = target.toLowerCase();
  return CLIENT_TARGET_MAP[lower] || {
    file:     `prd-${lower}.json`,
    schema:   'prd-default.json.schema.json',
    template: 'prd-default.json.template',
  };
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
    stage: 'prd', reason, stopped_at: stoppedAt,
  });

  if (stagesObj && stagesObj.stages) {
    if (!stagesObj.stages.prd) {
      stagesObj.stages.prd = buildPrdStageSkeleton({ status: 'stopped', startedAtStr: stoppedAt, reqHash: null, reqMdPath: null });
    } else {
      stagesObj.stages.prd.status = 'stopped';
    }
    stagesObj.pipeline.updated_at = stoppedAt;

    // 写 pipeline.stop_info
    stagesObj.pipeline.stop_info = {
      stopped_at:    stoppedAt,
      stopped_stage: 'prd',
      reason,
    };
    writeStagesJson(stagesObj);
  }

  // 删除 stop.signal（避免下次重跑被误拦截）
  try {
    const signalPath = path.join(projectRoot, '.pipeline', 'stop.signal');
    if (fs.existsSync(signalPath)) fs.unlinkSync(signalPath);
  } catch (_) { /* ignore */ }

  log.info('pipeline_stopped', 'prd stage 已优雅停止', {
    stage: 'prd', stopped_at: stoppedAt, exit_code: 5,
  });
  process.exit(5);
}

/** 构建 stages.prd 初始骨架 */
function buildPrdStageSkeleton({ status, startedAtStr, reqHash, reqMdPath, existing }) {
  const base = existing || {};
  return Object.assign({}, base, {
    status,
    started_at:   startedAtStr || null,
    completed_at: base.completed_at || null,
    inputs: Object.assign({}, base.inputs || {}, {
      req_hash:       reqHash || null,
      prd_spec_hash:  (base.inputs && base.inputs.prd_spec_hash) || null,
      source_req:     reqMdPath || null,
      raw_input_refs: [],
    }),
    outputs: base.outputs || {
      config_dev:     null,
      config_release: null,
      config_env:     null,
      client_targets: [],
      features:       [],
      features_hash:  null,
      features_total: 0,
      duration_ms:    null,
      timed_out:      false,
      timeout_reason: null,
    },
    validation: base.validation || {
      passed:                  false,
      checked_at:              null,
      summary:                 null,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    },
    generated_files: base.generated_files || [],
    blocking_issues: base.blocking_issues || [],
    git_sync: base.git_sync || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  });
}

/** 从 prd-spec.md 解析 client_targets（跳过 HTML 注释块内的行） */
function parseClientTargetsFromSpec(specContent) {
  const targets = [];
  let inSection = false;
  let inComment = false;
  for (const line of specContent.split('\n')) {
    const trimmed = line.trim();

    // HTML 注释块状态追踪
    if (trimmed.includes('<!--')) inComment = true;
    if (trimmed.includes('-->')) { inComment = false; continue; }
    if (inComment) continue;

    if (/^##\s+客户端目标/.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(trimmed)) break;
    if (!inSection) continue;
    // 匹配 "- target" 或 "- target — description" 格式（要求后面是空格、em dash 或行尾）
    const m = trimmed.match(/^-\s+([a-zA-Z][a-zA-Z0-9_-]*)(?:\s|$)/);
    if (m) targets.push(m[1].toLowerCase());
  }
  return [...new Set(targets)];
}

/** 读取配置：timeouts.stages.prd_s（默认 300s）和 max_retries（默认 2） */
function readConfig() {
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { /* ignore */ }
  }
  const timeoutS = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.prd_s) || 300;
  const maxRetries = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.prd && cfg.pipeline.stages.prd.max_retries) || 2;
  const model = (cfg.pipeline && cfg.pipeline.model) || 'composer-2';
  const autoCommit = !!(cfg.git && cfg.git.auto_commit);
  return { timeoutS, maxRetries, model, autoCommit };
}

// ── Ajv 校验 ──────────────────────────────────────────────────────
const { validatePrdClientJson } = require('../libs/ajv-prd-client.cjs');

function validateJson(data, schemaName) {
  return validatePrdClientJson({ skillsRoot, schemaName, data });
}

// ── Agent 调用（通过 @cursor/sdk） ────────────────────────────────
/**
 * 调用 Cursor Agent
 * @param {object} opts
 * @param {string} opts.agentId      - 日志中用的 agent_id
 * @param {string} opts.promptFile   - 相对 ai-std3/prompts/ 的文件名
 * @param {string[]} opts.inputFiles - 传给 Agent 的输入文件路径（记录日志用）
 * @param {string} opts.model        - 模型 id
 * @param {number} opts.timeoutMs    - 超时毫秒
 * @param {string} opts.clientTarget - 端名（Agent-B 时填写）
 * @param {string} opts.cwd          - Agent 工作目录（业务项目根）
 * @param {object} opts.extraContext - 注入 prompt 的额外上下文（clientTarget, contentFile 等）
 * @returns {Promise<{success: boolean, timedOut: boolean, error: string|null, agentRunId: string|null}>}
 */
async function invokeAgent(opts) {
  const {
    agentId, promptFile, inputFiles = [], model, timeoutMs, clientTarget,
    cwd = projectRoot, extraContext = {},
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
    agent_id:     agentId,
    prompt:       promptFile,
    input_files:  inputFiles,
    model,
    ...(clientTarget ? { client_target: clientTarget } : {}),
  });

  const t0 = Date.now();
  let agentRunId = null;

  try {
    // 动态加载 @cursor/sdk（CJS build）
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
      const agent = await Agent.create(agentOptions);
      try {
        const run = await agent.send(finalPrompt);
        agentRunId = run.id || null;
        log.info('agent_start', `Agent 运行 ID: ${agentRunId}`, {
          agent_id: agentId, run_id: agentRunId,
        });

        // 流式输出
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

    const durationMs = Date.now() - t0;

    if (outcome.timedOut) {
      return { success: false, timedOut: true, error: `Agent timeout after ${timeoutMs}ms`, agentRunId };
    }

    return { success: outcome.success, timedOut: false, error: outcome.error || null, agentRunId };

  } catch (err) {
    // CursorAgentError 或其他启动失败
    const durationMs = Date.now() - t0;
    const errMsg = err && err.message ? err.message : String(err);
    return { success: false, timedOut: false, error: errMsg, agentRunId };
  }
}

// ── Agent-A（单次调用 prd-spec-author） ───────────────────────────
async function runAgentA({ model, timeoutMs }) {
  const reqMdPath   = path.join(projectRoot, 'inputs', 'req.md');
  const prdSpecPath = path.join(projectRoot, 'docs', 'prd-spec.md');

  const t0 = Date.now();
  const result = await invokeAgent({
    agentId:    'prd-agent-a',
    promptFile: 'prd-spec-author.md',
    inputFiles: [reqMdPath, prdSpecPath],
    model, timeoutMs,
    cwd: projectRoot,
    extraContext: { req_file: reqMdPath, spec_file: prdSpecPath },
  });

  const durationMs = Date.now() - t0;

  if (result.timedOut) {
    log.error('agent_failed', 'Agent-A 超时', {
      agent_id: 'prd-agent-a', exit_code: 3, reason: result.error, duration_ms: durationMs,
    });
    return { success: false, timedOut: true };
  }

  if (!result.success) {
    log.error('agent_failed', `Agent-A 失败: ${result.error}`, {
      agent_id: 'prd-agent-a', exit_code: 4, reason: result.error, duration_ms: durationMs,
    });
    return { success: false, timedOut: false, error: result.error };
  }

  // 检查 prd-spec.md 是否已更新
  const specExists = fs.existsSync(prdSpecPath);
  const specStat   = specExists ? fs.statSync(prdSpecPath) : null;

  const clientTargets = specExists
    ? parseClientTargetsFromSpec(fs.readFileSync(prdSpecPath, 'utf8'))
    : [];

  log.info('agent_complete', 'Agent-A 完成', {
    agent_id:             'prd-agent-a',
    duration_ms:          durationMs,
    output_files:         [prdSpecPath],
    client_targets_parsed: clientTargets,
  });

  if (specExists) {
    log.info('file_updated', 'prd-spec.md 已更新', {
      path: prdSpecPath, size_bytes: specStat.size,
    });
  }

  return { success: true, timedOut: false, clientTargets };
}

// ── Agent-B（单端，带重试） ───────────────────────────────────────
async function runAgentBForTarget({ clientTarget, model, timeoutMs, maxRetries }) {
  const resolved  = resolveClientTarget(clientTarget);
  const prdFile   = path.join(projectRoot, 'docs', resolved.file);
  const flFile    = path.join(projectRoot, 'docs', `feature_list-${clientTarget}.md`);
  const prdSpec   = path.join(projectRoot, 'docs', 'prd-spec.md');
  const agentId   = `prd-agent-b-${clientTarget}`;

  // 拷贝模板（若目标文件不存在）
  const templatePath = path.join(skillsRoot, 'ai-std3', 'templates', resolved.template);
  if (!fs.existsSync(prdFile) && fs.existsSync(templatePath)) {
    fs.mkdirSync(path.dirname(prdFile), { recursive: true });
    fs.copyFileSync(templatePath, prdFile);
    const stat = fs.statSync(prdFile);
    log.info('file_created', `已从模板创建 ${resolved.file}`, {
      client_target: clientTarget,
      path:          prdFile,
      from_template: resolved.template,
      size_bytes:    stat.size,
    });
  } else if (fs.existsSync(prdFile)) {
    log.info('file_skipped', `${resolved.file} 已存在，跳过模板拷贝`, {
      client_target: clientTarget, path: prdFile,
    });
  }

  // Agent-B 调用（带重试）
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      log.warn('agent_retry', `Agent-B(${clientTarget}) 第 ${attempt - 1} 次重试（第 ${attempt} 次尝试）`, {
        agent_id: agentId, client_target: clientTarget, attempt, reason: lastError,
      });
    }

    const t0 = Date.now();
    const result = await invokeAgent({
      agentId, promptFile: 'prd-client-author.md',
      inputFiles:   [prdSpec, prdFile],
      model, timeoutMs,
      clientTarget, cwd: projectRoot,
      extraContext: {
        client_target: clientTarget,
        content_file:  prdFile,
        feature_list:  flFile,
        schema:        resolved.schema,
      },
    });
    const durationMs = Date.now() - t0;

    if (result.timedOut) {
      log.error('agent_failed', `Agent-B(${clientTarget}) 超时`, {
        agent_id: agentId, client_target: clientTarget,
        max_attempts: maxRetries + 1, last_error: result.error,
      });
      return { success: false, timedOut: true, clientTarget };
    }

    if (!result.success) {
      lastError = result.error;
      if (attempt > maxRetries) break;
      continue;
    }

    // Schema 校验
    if (fs.existsSync(prdFile)) {
      let prdData;
      try { prdData = JSON.parse(fs.readFileSync(prdFile, 'utf8')); }
      catch (e) {
        lastError = `JSON parse error: ${e.message}`;
        if (attempt > maxRetries) break;
        log.warn('agent_retry', `Agent-B(${clientTarget}) JSON 解析失败，重试`, {
          agent_id: agentId, client_target: clientTarget, attempt, reason: lastError,
        });
        continue;
      }

      const { valid, errors } = validateJson(prdData, resolved.schema);
      if (!valid) {
        const invalidFields = errors.map(e => e.instancePath + ' ' + e.message).join('; ');
        lastError = `Schema validation failed: ${invalidFields}`;
        log.warn('agent_retry', `Agent-B(${clientTarget}) schema 校验失败`, {
          agent_id:       agentId,
          client_target:  clientTarget,
          attempt,
          reason:         'schema_validation_failed',
          invalid_fields: invalidFields,
          schema:         resolved.schema,
        });
        if (attempt > maxRetries) break;
        continue;
      }

      // 校验通过
      const flStat  = fs.existsSync(flFile)  ? fs.statSync(flFile)  : null;
      const prdStat = fs.statSync(prdFile);
      const featuresCount = Array.isArray(prdData.features) ? prdData.features.length : 0;

      log.info('agent_complete', `Agent-B(${clientTarget}) 完成`, {
        agent_id:     agentId,
        client_target: clientTarget,
        duration_ms:  durationMs,
        output_files: [prdFile, ...(flStat ? [flFile] : [])],
        features_count: featuresCount,
      });

      if (prdStat) log.info('file_updated', `${resolved.file} 已更新`, { path: prdFile, size_bytes: prdStat.size });
      if (flStat)  log.info('file_updated', `feature_list-${clientTarget}.md 已更新`, { path: flFile, size_bytes: flStat.size });

      return { success: true, timedOut: false, clientTarget };
    } else {
      // Agent 完成但文件不存在，视为失败
      lastError = `Output file not found: ${prdFile}`;
      if (attempt > maxRetries) break;
      log.warn('agent_retry', `Agent-B(${clientTarget}) 输出文件缺失，重试`, {
        agent_id: agentId, client_target: clientTarget, attempt, reason: lastError,
      });
    }
  }

  log.error('agent_failed', `Agent-B(${clientTarget}) 超过最大重试次数`, {
    agent_id:    agentId,
    client_target: clientTarget,
    max_attempts: maxRetries + 1,
    last_error:  lastError,
    exit_code:   4,
  });
  return { success: false, timedOut: false, clientTarget, error: lastError };
}

// ── 聚合 features → 索引真源 ──────────────────────────────────────
const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3'];
const PHASE_ORDER    = ['mvp', 'standard', 'complete', 'future'];

function pickHigherPriority(a, b) {
  return PRIORITY_ORDER.indexOf(a) <= PRIORITY_ORDER.indexOf(b) ? a : b;
}

function pickEarlierPhase(a, b) {
  return PHASE_ORDER.indexOf(a) <= PHASE_ORDER.indexOf(b) ? a : b;
}

/**
 * 从各端 prd-*.json 聚合 features[]
 * @returns {{ features: object[], blockingIssues: string[], warnings: string[] }}
 */
function aggregateFeatures(clientTargets) {
  const featureMap = new Map();
  const blockingIssues = [];
  const warnings = [];

  for (const ct of clientTargets) {
    const resolved = resolveClientTarget(ct);
    const prdFile  = path.join(projectRoot, 'docs', resolved.file);
    if (!fs.existsSync(prdFile)) {
      warnings.push(`${resolved.file} 不存在，跳过该端 feature 聚合`);
      continue;
    }

    let prdData;
    try { prdData = JSON.parse(fs.readFileSync(prdFile, 'utf8')); }
    catch (e) { warnings.push(`${resolved.file} JSON 解析失败: ${e.message}`); continue; }

    const features = Array.isArray(prdData.features) ? prdData.features : [];
    for (const f of features) {
      if (!f.feature_id) { warnings.push(`${resolved.file}: 有 feature 缺少 feature_id`); continue; }

      if (!featureMap.has(f.feature_id)) {
        featureMap.set(f.feature_id, {
          feature_id:     f.feature_id,
          name:           f.name || '',
          priority:       f.priority || 'P3',
          phase:          f.phase   || 'future',
          description:    f.description || '',
          client_targets: [],
          dependencies:   [],
          sources:        {},
        });
      }

      const existing = featureMap.get(f.feature_id);

      // name：取首次非空；若不一致记 warning
      if (f.name && !existing.name) {
        existing.name = f.name;
      } else if (f.name && existing.name && f.name !== existing.name) {
        warnings.push(`feature_id=${f.feature_id}: 不同端 name 不一致（"${existing.name}" vs "${f.name}"），取首次`);
      }

      // priority：取最高级（值最小的下标）
      if (f.priority) {
        const newP = pickHigherPriority(existing.priority, f.priority);
        // 检查差异超过两级
        const diff = Math.abs(PRIORITY_ORDER.indexOf(f.priority) - PRIORITY_ORDER.indexOf(newP === f.priority ? existing.priority : f.priority));
        if (diff > 2) {
          blockingIssues.push(`feature_id=${f.feature_id}: priority 差异超过两级（${existing.priority} vs ${f.priority}）`);
        }
        existing.priority = newP;
      }

      // phase：取最早可交付
      if (f.phase) {
        const origIdx  = PHASE_ORDER.indexOf(existing.phase);
        const thisIdx  = PHASE_ORDER.indexOf(f.phase);
        if (Math.abs(origIdx - thisIdx) > 2) {
          blockingIssues.push(`feature_id=${f.feature_id}: phase 跨度过大（${existing.phase} vs ${f.phase}）`);
        }
        existing.phase = pickEarlierPhase(existing.phase, f.phase);
      }

      // description：取最长非空
      if (f.description && f.description.length > (existing.description || '').length) {
        existing.description = f.description;
      }

      // client_targets：并集
      if (!existing.client_targets.includes(ct)) existing.client_targets.push(ct);

      // dependencies：并集去重
      for (const dep of (Array.isArray(f.dependencies) ? f.dependencies : [])) {
        if (!existing.dependencies.includes(dep)) existing.dependencies.push(dep);
      }

      // sources
      existing.sources[ct] = path.join(projectRoot, 'docs', resolved.file);
    }
  }

  // 所有 features 收集完毕
  const allIds = new Set(featureMap.keys());

  // 依赖验证：检查自环与未知 id
  for (const [fid, f] of featureMap.entries()) {
    for (const dep of f.dependencies) {
      if (dep === fid) {
        blockingIssues.push(`feature_id=${fid}: 依赖自身（自环）`);
      } else if (!allIds.has(dep)) {
        blockingIssues.push(`feature_id=${fid}: 依赖未知 feature_id=${dep}`);
      }
    }
  }

  // 排序：phase 优先，priority 其次，feature_id 字典序
  const sorted = [...featureMap.values()].sort((a, b) => {
    const pd = PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase);
    if (pd !== 0) return pd;
    const pr = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
    if (pr !== 0) return pr;
    return a.feature_id.localeCompare(b.feature_id);
  });

  return { features: sorted, blockingIssues, warnings };
}

/** 计算 features[] 稳定哈希 */
function featuresHash(features) {
  const KEYS = ['feature_id', 'name', 'priority', 'phase', 'description', 'client_targets', 'dependencies', 'sources'];
  const stable = features.map(f => {
    const obj = {};
    for (const k of KEYS) if (f[k] !== undefined) obj[k] = f[k];
    return obj;
  });
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// ── validate：步骤 4 ──────────────────────────────────────────────
function validateOutputs(clientTargets) {
  const missing = [];
  const invalid = [];

  const prdSpecPath = path.join(projectRoot, 'docs', 'prd-spec.md');
  if (!fs.existsSync(prdSpecPath)) missing.push('docs/prd-spec.md');
  else {
    const content = fs.readFileSync(prdSpecPath, 'utf8');
    if (!/^##\s+客户端目标/m.test(content)) invalid.push('prd-spec.md: 缺少 ## 客户端目标 节');
  }

  for (const ct of clientTargets) {
    const resolved = resolveClientTarget(ct);
    const prdFile = path.join(projectRoot, 'docs', resolved.file);
    const flFile  = path.join(projectRoot, 'docs', `feature_list-${ct}.md`);
    if (!fs.existsSync(prdFile)) missing.push(`docs/${resolved.file}`);
    if (!fs.existsSync(flFile))  missing.push(`docs/feature_list-${ct}.md`);
  }

  const configDevPath = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(configDevPath)) {
    missing.push('docs/config.dev.json');
  } else {
    try { JSON.parse(fs.readFileSync(configDevPath, 'utf8')); }
    catch (e) { invalid.push(`config.dev.json: JSON 解析失败: ${e.message}`); }
  }

  return { missing, invalid };
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  // 0. 检测 stop.signal
  if (checkStopSignal()) {
    gracefulStop(readStagesJson());
  }

  // stage_start 日志
  log.info('stage_start', `prd stage 启动，项目: ${projectRoot}`, {
    run_id:    runId,
    stage:     'prd',
    project:   projectRoot,
    started_at: startedAtStr,
  });

  // 1. 上游门闸
  const stages = readStagesJson();
  if (!stages) {
    log.error('stage_failed', 'stages.json 不存在，setup 尚未完成', {
      stage: 'prd', exit_code: 1, reason: 'stages.json missing',
      duration_ms: 0,
    });
    process.exit(1);
  }

  const setupStage = stages.stages && stages.stages.setup;
  if (!setupStage || setupStage.status !== 'completed') {
    log.error('stage_failed', '上游门闸未满足：setup.status 不是 completed', {
      stage: 'prd', exit_code: 1,
      reason: `setup.status=${setupStage ? setupStage.status : 'missing'}`,
      duration_ms: 0,
    });
    process.exit(1);
  }

  if (!setupStage.validation || !setupStage.validation.passed) {
    log.error('stage_failed', '上游门闸未满足：setup.validation.passed 不是 true', {
      stage: 'prd', exit_code: 1, reason: 'setup.validation.passed=false',
      duration_ms: 0,
    });
    process.exit(1);
  }

  // 2. 检测 stop.signal（门闸通过后）
  if (checkStopSignal()) {
    gracefulStop(readStagesJson());
  }

  // 读取配置
  const { timeoutS, maxRetries, model, autoCommit } = readConfig();
  const timeoutMs = timeoutS * 1000;

  // 3. hash 门控
  const reqMdPath = path.join(projectRoot, 'inputs', 'req.md');
  const currentReqHash = fileSha256(reqMdPath);

  if (!forceRerun) {
    const prdStage = stages.stages && stages.stages.prd;
    if (prdStage && prdStage.status === 'completed') {
      const storedHash = prdStage.inputs && prdStage.inputs.req_hash;
      const hit = !!(currentReqHash && storedHash && currentReqHash === storedHash);

      log.info('hash_check', 'hash 门控检查（整段跳过判断）', {
        file:          'req.md',
        stored_hash:   storedHash || null,
        computed_hash: currentReqHash,
        hit,
        updated_stored: false,
        skip_agent_a:   hit,
      });

      if (hit) {
        log.info('stage_skipped', 'prd hash 门控命中，跳过执行', {
          stage:     'prd',
          reason:    'req_hash matched, status=completed',
          exit_code: 0,
        });
        process.exit(0);
      }
    } else {
      log.info('hash_check', 'hash 门控检查（prd 未 completed，不触发整段跳过）', {
        file:          'req.md',
        stored_hash:   (prdStage && prdStage.inputs && prdStage.inputs.req_hash) || null,
        computed_hash: currentReqHash,
        hit:           false,
        updated_stored: false,
        skip_agent_a:   false,
      });
    }
  }

  // 4. prd-bootstrap：初始化 stages.prd 骨架
  // 提前定义 prdSpecPath，供 bootstrap hash_check 日志与后续步骤使用
  const prdSpecPath  = path.join(projectRoot, 'docs', 'prd-spec.md');
  const specTemplate = path.join(skillsRoot, 'ai-std3', 'templates', 'prd-spec.md.template');

  let stagesObj = readStagesJson();
  const existingPrd = stagesObj.stages && stagesObj.stages.prd;

  // 捕获 bootstrap 前的 req_hash（Agent-A skip 比较使用，防止 bootstrap 写入后误命中）
  const reqHashBeforeBootstrap =
    existingPrd && existingPrd.inputs && existingPrd.inputs.req_hash
      ? existingPrd.inputs.req_hash
      : null;

  if (!existingPrd) {
    // 首次：写入 stages.prd 骨架
    if (!stagesObj.stages) stagesObj.stages = {};
    stagesObj.stages.prd = buildPrdStageSkeleton({
      status: 'started', startedAtStr, reqHash: currentReqHash, reqMdPath,
    });
    stagesObj.pipeline.updated_at = startedAtStr;

    const stagesPath = writeStagesJson(stagesObj);
    const stat = fs.statSync(stagesPath);
    log.info('file_created', '已写入 stages.prd 骨架', {
      path: stagesPath, size_bytes: stat.size, from_template: true,
    });
    log.info('hash_check', 'bootstrap：首次计算 req.md SHA-256（首次运行，将运行 Agent-A）', {
      file:           'req.md',
      stored_hash:    null,
      computed_hash:  currentReqHash,
      hit:            false,
      updated_stored: true,
      skip_agent_a:   false,
    });
  } else {
    // 更新 req_hash，设 status=started（bootstrap）
    const oldReqHash = existingPrd.inputs && existingPrd.inputs.req_hash;
    existingPrd.inputs       = existingPrd.inputs || {};
    existingPrd.inputs.req_hash  = currentReqHash;
    existingPrd.inputs.source_req = reqMdPath;
    existingPrd.started_at   = startedAtStr;
    existingPrd.status       = 'started';
    stagesObj.pipeline.updated_at = startedAtStr;

    const stagesPath = writeStagesJson(stagesObj);
    const stat = fs.statSync(stagesPath);
    log.info('file_updated', '已更新 stages.prd（status=started）', {
      path: stagesPath, size_bytes: stat.size,
    });
    const bootstrapHit = !!(currentReqHash && reqHashBeforeBootstrap &&
                            currentReqHash === reqHashBeforeBootstrap);
    log.info('hash_check', 'bootstrap：更新 req_hash（覆盖写入）', {
      file:           'req.md',
      stored_hash:    reqHashBeforeBootstrap || null,
      computed_hash:  currentReqHash,
      hit:            bootstrapHit,
      updated_stored: true,
      skip_agent_a:   bootstrapHit && fs.existsSync(prdSpecPath),
    });
  }

  // 拷贝 prd-spec.md 模板（若不存在）

  if (!fs.existsSync(prdSpecPath)) {
    if (fs.existsSync(specTemplate)) {
      fs.mkdirSync(path.dirname(prdSpecPath), { recursive: true });
      fs.copyFileSync(specTemplate, prdSpecPath);
      const stat = fs.statSync(prdSpecPath);
      log.info('file_created', 'prd-spec.md 已从模板创建', {
        path: prdSpecPath, size_bytes: stat.size, from_template: true,
      });
    } else {
      fs.mkdirSync(path.dirname(prdSpecPath), { recursive: true });
      fs.writeFileSync(prdSpecPath, '# PRD 规格说明\n\n## 客户端目标\n\n## 核心功能\n', 'utf8');
      log.info('file_created', 'prd-spec.md 已创建（无模板）', {
        path: prdSpecPath, size_bytes: fs.statSync(prdSpecPath).size, from_template: false,
      });
    }
  } else {
    log.info('file_skipped', 'prd-spec.md 已存在，跳过模板拷贝', { path: prdSpecPath });
  }

  // 5. Agent-A：生成/更新 prd-spec.md
  // 检查跳过条件：req_hash 命中且 prd-spec.md 已存在
  let clientTargets = [];
  let skipAgentA = false;

  // 在 Agent-A 前捕获"旧的" prd_spec_hash（用于 Agent-B 跳过比较）
  stagesObj = readStagesJson();
  const storedPrdSpecHashBeforeAgentA =
    stagesObj.stages.prd && stagesObj.stages.prd.inputs && stagesObj.stages.prd.inputs.prd_spec_hash
      ? stagesObj.stages.prd.inputs.prd_spec_hash
      : null;

  if (!forceRerun) {
    // 使用 bootstrap 前捕获的 req_hash（非 bootstrap 后写入的新值）进行比较
    const specExists = fs.existsSync(prdSpecPath);
    // req_hash 命中 且 spec 存在（status=completed 已被更早的 hash 门控拦截，到此 status 一定不是 completed）
    // reqHashBeforeBootstrap=null 表示首次运行，一定要跑 Agent-A
    if (!forceRerun && currentReqHash && reqHashBeforeBootstrap &&
        currentReqHash === reqHashBeforeBootstrap && specExists) {
      skipAgentA = true;
    }
  }

  // 写 status=running
  stagesObj = readStagesJson();
  stagesObj.stages.prd.status = 'running';
  stagesObj.pipeline.updated_at = formatLocalTimeShort();
  writeStagesJson(stagesObj);
  log.info('file_updated', '已写 prd status=running', {
    path: path.join(projectRoot, '.pipeline', 'stages.json'), status: 'running',
  });

  if (skipAgentA) {
    log.info('agent_skipped', 'Agent-A 跳过：req_hash 命中且 prd-spec.md 已存在', {
      agent_id: 'prd-agent-a',
      reason:   'req_hash matched, prd-spec exists',
    });
    clientTargets = parseClientTargetsFromSpec(fs.readFileSync(prdSpecPath, 'utf8'));
  } else {
    // 检测 stop.signal（Agent-A 启动前）
    if (checkStopSignal()) { gracefulStop(readStagesJson()); }

    const agentAResult = await runAgentA({ model, timeoutMs });

    if (agentAResult.timedOut) {
      const dms = Date.now() - startedAt.getTime();
      stagesObj = readStagesJson();
      stagesObj.stages.prd.status = 'failed';
      stagesObj.stages.prd.outputs = stagesObj.stages.prd.outputs || {};
      stagesObj.stages.prd.outputs.timed_out = true;
      stagesObj.stages.prd.outputs.timeout_reason = 'agent_a_timeout';
      stagesObj.stages.prd.outputs.duration_ms = dms;
      stagesObj.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stagesObj);

      log.error('stage_failed', 'prd stage 因 Agent-A 超时退出', {
        stage: 'prd', step: 'agent-a', exit_code: 3,
        reason: 'agent_a_timeout', duration_ms: dms,
      });
      process.exit(3);
    }

    if (!agentAResult.success) {
      const dms = Date.now() - startedAt.getTime();
      stagesObj = readStagesJson();
      stagesObj.stages.prd.status = 'failed';
      stagesObj.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stagesObj);

      log.error('stage_failed', `prd stage 因 Agent-A 失败退出: ${agentAResult.error}`, {
        stage: 'prd', step: 'agent-a', exit_code: 4,
        reason: agentAResult.error, duration_ms: dms,
      });
      process.exit(4);
    }

    clientTargets = agentAResult.clientTargets || [];
  }

  // 计算并写入 prd-spec.md SHA-256
  const prdSpecHash = fileSha256(prdSpecPath);
  stagesObj = readStagesJson();
  stagesObj.stages.prd.inputs.prd_spec_hash = prdSpecHash;
  stagesObj.pipeline.updated_at = formatLocalTimeShort();
  writeStagesJson(stagesObj);

  log.info('hash_check', 'prd-spec.md 哈希已计算', {
    file:          'prd-spec.md',
    stored_hash:   null,
    computed_hash: prdSpecHash,
    hit:           false,
  });

  // 如果 client_targets 仍为空，尝试从规格文件解析
  if (clientTargets.length === 0 && fs.existsSync(prdSpecPath)) {
    clientTargets = parseClientTargetsFromSpec(fs.readFileSync(prdSpecPath, 'utf8'));
  }

  if (clientTargets.length === 0) {
    const dms = Date.now() - startedAt.getTime();
    stagesObj = readStagesJson();
    stagesObj.stages.prd.status = 'failed';
    stagesObj.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stagesObj);

    log.error('stage_failed', 'prd-spec.md 中未找到 client_targets，请检查 ## 客户端目标 节', {
      stage: 'prd', step: 'parse-client-targets', exit_code: 4,
      reason: 'no client_targets found in prd-spec.md', duration_ms: dms,
    });
    process.exit(4);
  }

  // 6. 检测 stop.signal（Agent-B 启动前）
  if (checkStopSignal()) { gracefulStop(readStagesJson()); }

  // 7. Agent-B 并发（每端一个）
  // 先检查各端跳过条件（prd_spec_hash 命中 且 文件已存在且 schema 通过 且 feature_list 已存在）
  const skippedTargets   = [];
  const toRunTargets     = [];

  for (const ct of clientTargets) {
    const resolved  = resolveClientTarget(ct);
    const prdFile   = path.join(projectRoot, 'docs', resolved.file);
    const flFile    = path.join(projectRoot, 'docs', `feature_list-${ct}.md`);

    // 与 Agent-A 前的旧 prd_spec_hash 比较（不与刚写入的新值比较）
    // 仅在 skipAgentA=true（Agent-A 已跳过）时旧值与新值相同，hash 才能真正命中
    const specHashHit = prdSpecHash && storedPrdSpecHashBeforeAgentA &&
                        prdSpecHash === storedPrdSpecHashBeforeAgentA;
    const filesExist  = fs.existsSync(prdFile) && fs.existsSync(flFile);

    let schemaOk = false;
    if (filesExist && !forceRerun) {
      try {
        const data = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
        const { valid } = validateJson(data, resolved.schema);
        schemaOk = valid;
      } catch (_) { schemaOk = false; }
    }

    if (!forceRerun && specHashHit && filesExist && schemaOk) {
      skippedTargets.push(ct);
    } else {
      toRunTargets.push(ct);
    }
  }

  // 批次开始
  const batchId = 'prd-agent-b';
  log.info('agent_batch_start', `Agent-B 并发批次开始，共 ${clientTargets.length} 端`, {
    batch_id:      batchId,
    client_targets: clientTargets,
    agents_total:  clientTargets.length,
    agents_skipped: skippedTargets,
  });

  for (const ct of skippedTargets) {
    log.info('agent_skipped', `Agent-B(${ct}) 跳过：prd_spec_hash 命中且文件存在通过校验`, {
      agent_id:      `prd-agent-b-${ct}`,
      client_target: ct,
      reason:        'prd_spec_hash matched, target files exist',
    });
  }

  // 并发运行 toRunTargets
  const batchT0 = Date.now();
  let failedTargets  = [];
  let timedOutExists = false;

  if (toRunTargets.length > 0) {
    const promises = toRunTargets.map(async (ct) => {
      // 单端启动前检查 stop.signal
      if (checkStopSignal()) {
        log.info('pipeline_stop', `检测到 stop.signal，跳过 Agent-B(${ct})`, {
          stage: 'prd', client_target: ct, stopped_at: formatLocalTimeShort(),
        });
        return { success: false, timedOut: false, clientTarget: ct, stopped: true };
      }
      return runAgentBForTarget({ clientTarget: ct, model, timeoutMs, maxRetries });
    });

    const results = await Promise.all(promises);

    for (const r of results) {
      if (r.stopped) {
        gracefulStop(readStagesJson());
      }
      if (!r.success) {
        failedTargets.push(r.clientTarget);
        if (r.timedOut) timedOutExists = true;
      }
    }
  }

  const batchDurationMs = Date.now() - batchT0;
  const succeededTargets = clientTargets.filter(ct => !failedTargets.includes(ct));

  log.info('agent_batch_complete', `Agent-B 批次结束`, {
    batch_id:         batchId,
    agents_succeeded: succeededTargets,
    agents_failed:    failedTargets,
    agents_skipped:   skippedTargets,
    duration_ms:      batchDurationMs,
  });

  if (failedTargets.length > 0) {
    const dms = Date.now() - startedAt.getTime();
    stagesObj = readStagesJson();
    stagesObj.stages.prd.status = 'failed';
    stagesObj.stages.prd.blocking_issues = failedTargets.map(ct => `Agent-B failed for client_target=${ct}`);
    stagesObj.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stagesObj);

    const exitCode = timedOutExists ? 3 : 4;
    log.error('stage_failed', `prd stage 失败，${failedTargets.length} 个端失败`, {
      stage: 'prd', step: 'agent-b', exit_code: exitCode,
      reason: `failed client_targets: ${failedTargets.join(', ')}`,
      failed_client_target: failedTargets.join(', '),
      duration_ms: dms,
    });
    process.exit(exitCode);
  }

  // 8. prd-validate：校验产出 + 聚合 features
  const { missing, invalid } = validateOutputs(clientTargets);

  if (missing.length > 0 || invalid.length > 0) {
    const dms = Date.now() - startedAt.getTime();
    stagesObj = readStagesJson();
    stagesObj.stages.prd.status = 'failed';
    stagesObj.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stagesObj);

    log.error('validation_fail', '产出校验失败', {
      missing, invalid,
    });
    log.error('stage_failed', '产出文件校验失败', {
      stage: 'prd', step: 'validate', exit_code: 4,
      reason: `missing: ${missing.join(', ')} | invalid: ${invalid.join(', ')}`,
      duration_ms: dms,
    });
    process.exit(4);
  }

  // 聚合 features
  const { features, blockingIssues, warnings } = aggregateFeatures(clientTargets);

  if (blockingIssues.length > 0) {
    const dms = Date.now() - startedAt.getTime();
    stagesObj = readStagesJson();
    stagesObj.stages.prd.status = 'failed';
    stagesObj.stages.prd.blocking_issues = blockingIssues;
    stagesObj.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stagesObj);

    log.error('validation_fail', 'feature 聚合冲突或依赖校验失败', {
      conflicts: blockingIssues, blocking_count: blockingIssues.length, warning_count: warnings.length,
    });
    log.error('stage_failed', 'feature 聚合校验未通过', {
      stage: 'prd', step: 'aggregate-features', exit_code: 4,
      reason: blockingIssues.join(' | '),
      duration_ms: Date.now() - startedAt.getTime(),
    });
    process.exit(4);
  }

  if (warnings.length > 0) {
    warnings.forEach(w => log.warn('validation_fail', w, { warning: w }));
  }

  const fHash = featuresHash(features);
  const checks = ['docs/prd-spec.md', ...clientTargets.map(ct => `docs/${resolveClientTarget(ct).file}`), 'docs/config.dev.json'];

  log.info('validation_pass', '产出校验全部通过', {
    checks,
    warnings,
  });

  // 写完成态
  const completedAt    = new Date();
  const completedAtStr = formatLocalTimeShort(completedAt);
  const durationMs     = completedAt.getTime() - startedAt.getTime();

  stagesObj = readStagesJson();
  stagesObj.pipeline.current_stage        = 'prd';
  stagesObj.pipeline.last_completed_stage = 'prd';
  stagesObj.pipeline.updated_at           = completedAtStr;

  const setupOutputs = stagesObj.stages.setup && stagesObj.stages.setup.outputs || {};

  stagesObj.stages.prd = Object.assign(stagesObj.stages.prd || {}, {
    status:       'completed',
    started_at:   startedAtStr,
    completed_at: completedAtStr,
    inputs: {
      req_hash:       currentReqHash,
      prd_spec_hash:  prdSpecHash,
      source_req:     reqMdPath,
      raw_input_refs: [],
    },
    outputs: {
      config_dev:     setupOutputs.config_dev     || null,
      config_release: setupOutputs.config_release || null,
      config_env:     setupOutputs.config_env     || null,
      client_targets: clientTargets,
      features:       features,
      features_hash:  fHash,
      features_total: features.length,
      duration_ms:    durationMs,
      timed_out:      false,
      timeout_reason: null,
    },
    validation: {
      passed:                  true,
      checked_at:              completedAtStr,
      summary:                 null,
      required_files:          checks,
      missing_required_fields: [],
      warnings,
    },
    generated_files: [
      prdSpecPath,
      ...clientTargets.map(ct => path.join(projectRoot, 'docs', resolveClientTarget(ct).file)),
      ...clientTargets.map(ct => path.join(projectRoot, 'docs', `feature_list-${ct}.md`)),
    ].filter(p => fs.existsSync(p)),
    blocking_issues: [],
    git_sync: stagesObj.stages.prd.git_sync || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  });

  const stagesPath = writeStagesJson(stagesObj);
  const stat = fs.statSync(stagesPath);
  log.info('file_updated', '已写 prd 完成态', {
    path:          stagesPath,
    size_bytes:    stat.size,
    status:        'completed',
    req_hash:      currentReqHash,
    prd_spec_hash: prdSpecHash,
    client_targets: clientTargets,
    features_total: features.length,
    features_hash:  fHash,
  });

  log.info('file_updated', 'stages.prd.outputs.features[] 已写入（索引真源）', {
    path:           stagesPath,
    features_total: features.length,
    features_hash:  fHash,
    client_targets: clientTargets,
  });

  log.info('stage_complete', `prd stage 完成，耗时 ${durationMs}ms`, {
    stage:          'prd',
    duration_ms:    durationMs,
    exit_code:      0,
    client_targets: clientTargets,
    features_total: features.length,
  });

  process.exit(0);
}

main().catch(err => {
  console.error(`[FATAL] prd.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

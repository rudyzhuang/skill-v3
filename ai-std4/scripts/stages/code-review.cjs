'use strict';

/**
 * code-review.cjs — code-review stage 编排入口
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. 上游门闸：stages.codegen.status=completed → exit 1
 *   2. 检测 stop.signal → exit 5
 *   3. hash 门控（全段跳过：codegen_commit_hashes 全命中 + code_review completed + decision≠failed → skipped exit 0）
 *   4. bootstrap：初始化/更新 stages.code_review 骨架，写 status=running
 *   5. 确定性预检（不调用 Agent）
 *   6. 并发 Agent 池（code-review-agent.md prompt）→ code-review-<feature_id>.json
 *      - schema 校验 + 合并 deterministic_issues + 派生 decision
 *      - 重试（最多 max_retries 次）
 *   7. validate + finalize：汇总 outputs，生成 code-review-summary.md，写完成态
 *   → exit 0 全通过 / exit 1 门闸 / exit 3 超时 / exit 4 质量门失败 / exit 5 stop.signal
 *
 * 参数：
 *   --project=<路径>    业务项目根（绝对或相对）
 *   --run-id=<id>       run_id（由 run-pipeline 传入；缺失时自动生成）
 *   --feature=<id>      仅重评单个 feature（用于失败重跑）
 *   --force-rerun       强制跳过 hash 门控
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

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

const skillsRoot = process.env.CURSOR_SKILLS_ROOT
  || path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

const forceRerun    = args['force-rerun'] === true || args['force-rerun'] === 'true';
const featureFilter = args['feature'] || null;

// 兼容旧 --code-review-json 参数（已弃用）
if (args['code-review-json'] || process.env.AI_STD4_CODE_REVIEW_JSON) {
  process.stdout.write('[WARN] --code-review-json / AI_STD4_CODE_REVIEW_JSON 已弃用，忽略。\n');
}

// ── 生成 run_id ───────────────────────────────────────────────────
function generateRunId() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${crypto.randomBytes(4).toString('hex')}`;
}

const runId = args['run-id'] || generateRunId();

// ── 初始化 Logger ──────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'code-review', runId });

// ── 工具函数 ──────────────────────────────────────────────────────
/** 计算文件 SHA-256 hex；文件不存在返回 null */
function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** 计算字符串 SHA-256 hex */
function strSha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
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

/** 优雅停止 */
function gracefulStop(stagesObj) {
  const stoppedAt = formatLocalTimeShort();
  const reason    = getStopReason();
  log.info('pipeline_stop', '检测到 stop.signal，开始优雅停止', {
    stage: 'code-review', reason, stopped_at: stoppedAt,
  });

  if (stagesObj && stagesObj.stages) {
    if (!stagesObj.stages.code_review) {
      stagesObj.stages.code_review = { status: 'stopped' };
    } else {
      stagesObj.stages.code_review.status = 'stopped';
    }
    if (stagesObj.pipeline) {
      stagesObj.pipeline.updated_at = stoppedAt;
      stagesObj.pipeline.stop_info  = { stopped_at: stoppedAt, stopped_stage: 'code-review', reason };
    }
    writeStagesJson(stagesObj);
  }

  try {
    const signalPath = path.join(projectRoot, '.pipeline', 'stop.signal');
    if (fs.existsSync(signalPath)) fs.unlinkSync(signalPath);
  } catch (_) { /* ignore */ }

  log.info('pipeline_stopped', 'code-review stage 已优雅停止', {
    stage: 'code-review', stopped_at: stoppedAt, exit_code: 5,
  });
  process.exit(5);
}

// ── 读取配置 ──────────────────────────────────────────────────────
function readConfig() {
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { /* ignore */ }
  }
  const timeoutS = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.code_review_s) || 600;
  const maxRetries = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.code_review && cfg.pipeline.stages.code_review.max_retries) || 2;
  const model      = (cfg.pipeline && cfg.pipeline.model) || 'composer-2';
  const stageMaxParallel  = (cfg.pipeline && cfg.pipeline.stages && cfg.pipeline.stages.code_review && cfg.pipeline.stages.code_review.feature_max_parallel) || 3;
  const globalMaxParallel = (cfg.pipeline && cfg.pipeline.autorun && cfg.pipeline.autorun.feature_max_parallel) || 3;
  const effectiveParallel = Math.min(stageMaxParallel, globalMaxParallel);
  return { timeoutS, maxRetries, model, effectiveParallel };
}

// ── 从 codegen feature 数据中提取 commit ─────────────────────────
/** 兼容 commit / last_commit 两种字段名 */
function getFeatureCommit(featureData) {
  return featureData.commit || featureData.last_commit || null;
}

/** 兼容 worktree_path 字段及默认路径 */
function getWorktreePath(featureData, featureId) {
  if (featureData.worktree_path) return featureData.worktree_path;
  return path.join(projectRoot, '.pipeline', 'worktrees', `v3-${featureId}`);
}

// ── 收集 codegen 目标 features ───────────────────────────────────
/**
 * 从 stages.codegen 中收集已完成的 feature 列表
 * 优先读 outputs.feature_artifacts[]，其次读 features.<id>（status=completed）
 */
function collectCodegenFeatures(codegenStage) {
  const features = {};

  // 从 features.<id> 读取
  if (codegenStage.features && typeof codegenStage.features === 'object') {
    for (const [fid, fdata] of Object.entries(codegenStage.features)) {
      if (fdata && fdata.status === 'completed') {
        features[fid] = fdata;
      }
    }
  }

  // 从 outputs.feature_artifacts[] 补充/覆盖
  if (codegenStage.outputs && Array.isArray(codegenStage.outputs.feature_artifacts)) {
    for (const artifact of codegenStage.outputs.feature_artifacts) {
      if (artifact && artifact.feature_id && artifact.status === 'completed') {
        features[artifact.feature_id] = Object.assign({}, features[artifact.feature_id] || {}, artifact);
      }
    }
  }

  return features;
}

// ── hash 门控辅助 ─────────────────────────────────────────────────
/**
 * 计算 review_bundle_hash
 * = SHA-256(JSON.stringify(按 feature_id 字典序排列的 `${fid}:${commit}:${design_hash}` 数组))
 */
function computeReviewBundleHash(features) {
  const entries = Object.keys(features)
    .sort()
    .map(fid => {
      const commit      = getFeatureCommit(features[fid]) || '';
      const designHash  = features[fid].design_hash || '';
      return `${fid}:${commit}:${designHash}`;
    });
  return strSha256(JSON.stringify(entries));
}

/**
 * 构建 codegen_commit_hashes: { feature_id: commit }
 */
function buildCommitHashes(features) {
  const result = {};
  for (const [fid, fdata] of Object.entries(features)) {
    result[fid] = getFeatureCommit(fdata) || null;
  }
  return result;
}

// ── Ajv 校验 ──────────────────────────────────────────────────────
let _ajv = null;
function getAjv() {
  if (_ajv) return _ajv;
  const Ajv        = require('ajv');
  const addFormats = require('ajv-formats');
  _ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(_ajv);
  return _ajv;
}

function loadSchema(schemaName) {
  const p = path.join(skillsRoot, 'ai-std4', 'schemas', schemaName);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function validateJson(data, schemaName) {
  const schema = loadSchema(schemaName);
  if (!schema) return { valid: true, errors: [] };
  const ajv      = getAjv();
  const validate = ajv.compile(schema);
  const valid    = validate(data);
  return { valid, errors: validate.errors || [] };
}

// ── code-review 范围收敛（diff / 预检）──────────────────────────────
const DIFF_MAX_BYTES              = 4 * 1024 * 1024;
const DIFF_PATHSPEC_BATCH         = 80;
const FILES_CHANGED_RAW_WARN      = 200;
const FILES_CHANGED_SCOPE_CAP     = 500;
const FILE_PLAN_WARN_SAMPLE       = 12;
const DETERMINISTIC_ISSUES_CAP    = 64;
const REVIEW_NOISE_PATH_RE        = /^(\.pipeline\/|logs\/|node_modules\/|vendor\/|\.git\/|dist\/|build\/|\.codegen-)/;

function normalizeChangedPath(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    return String(entry.path || entry.file || '').trim();
  }
  return '';
}

function isReviewNoisePath(p) {
  return !p || REVIEW_NOISE_PATH_RE.test(p) || p === '.codegen-resume-context.json';
}

/** 从 design.json file_plan 提取路径（支持 { path, role } 对象） */
function getFilePlanPathSet(designData) {
  const allowed = new Set();
  if (!designData || !designData.file_plan) return allowed;
  const lists = [
    ...(designData.file_plan.new_files || []),
    ...(designData.file_plan.modify_files || []),
  ];
  for (const entry of lists) {
    const p = normalizeChangedPath(entry);
    if (p) allowed.add(p);
  }
  return allowed;
}

/**
 * 收敛 codegen files_changed（去重、过滤噪声；超大列表优先 file_plan）
 * @returns {{ paths: string[], totalRaw: number, truncated: boolean, strategy: string|null }}
 */
function scopeFilesChangedForReview(featureData, designData) {
  const rawList = featureData.files_changed || [];
  const unique  = [];
  const seen    = new Set();
  for (const entry of rawList) {
    const p = normalizeChangedPath(entry);
    if (!p || seen.has(p) || isReviewNoisePath(p)) continue;
    seen.add(p);
    unique.push(p);
  }

  const filePlan = getFilePlanPathSet(designData);
  const totalRaw = rawList.length;

  if (unique.length <= FILES_CHANGED_SCOPE_CAP) {
    return { paths: unique, totalRaw, truncated: false, strategy: null };
  }

  if (filePlan.size > 0) {
    const inPlan = unique.filter(p => filePlan.has(p));
    const paths  = (inPlan.length > 0 ? inPlan : [...filePlan]).slice(0, FILES_CHANGED_SCOPE_CAP);
    return {
      paths,
      totalRaw,
      truncated: true,
      strategy:  inPlan.length > 0 ? 'file_plan_intersection' : 'file_plan_fallback',
    };
  }

  return {
    paths:     unique.slice(0, FILES_CHANGED_SCOPE_CAP),
    totalRaw,
    truncated: true,
    strategy:  'cap',
  };
}

function capDeterministicIssues(issues, maxCount = DETERMINISTIC_ISSUES_CAP) {
  if (!issues || issues.length <= maxCount) return issues || [];
  const critical = issues.filter(i => i.severity === 'critical');
  const warnings = issues.filter(i => i.severity !== 'critical');
  const out      = [...critical];
  const room     = Math.max(0, maxCount - out.length);
  if (warnings.length <= room) {
    out.push(...warnings);
    return out;
  }
  out.push(...warnings.slice(0, Math.max(0, room - 1)));
  out.push({
    severity:      'warning',
    category:      'other',
    file:          null,
    line:          null,
    message:       `另有 ${warnings.length - Math.max(0, room - 1)} 条 warning 已省略（避免预检爆炸）`,
    suggested_fix: null,
    source:        'deterministic',
  });
  return out;
}

function resolveDiffBaseCommit(worktreePath) {
  try {
    return execSync('git rev-parse HEAD~1', {
      cwd: worktreePath, encoding: 'utf8', maxBuffer: 1024 * 1024,
    }).trim();
  } catch (_) {
    return execSync('git rev-list --max-parents=0 HEAD', {
      cwd: worktreePath, encoding: 'utf8', maxBuffer: 1024 * 1024,
    }).trim();
  }
}

/** git diff 直接写入文件，避免 exec 缓冲区 ENOBUFS */
function appendGitDiffRange(worktreePath, baseCommit, diffPath, pathspecs, { append } = {}) {
  const flag = append ? 'a' : 'w';
  const fd   = fs.openSync(diffPath, flag);
  try {
    const args = ['diff', '--no-ext-diff', `${baseCommit}..HEAD`];
    if (pathspecs && pathspecs.length > 0) {
      args.push('--', ...pathspecs);
    }
    const r = spawnSync('git', args, {
      cwd:        worktreePath,
      stdio:      ['ignore', fd, 'pipe'],
      encoding:   'utf8',
      maxBuffer:  512 * 1024,
    });
    if (r.status !== 0 && r.stderr) {
      fs.writeSync(fd, `# git diff stderr: ${r.stderr.trim()}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function truncateDiffFileIfNeeded(diffPath, maxBytes = DIFF_MAX_BYTES) {
  const stat = fs.statSync(diffPath);
  if (stat.size <= maxBytes) return { truncated: false, size_bytes: stat.size };
  const fd = fs.openSync(diffPath, 'r+');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, 0);
    const tail = Buffer.from(
      `\n\n# --- diff truncated at ${maxBytes} bytes (total ${stat.size}) ---\n`,
      'utf8'
    );
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, buf);
    fs.writeSync(fd, tail);
  } finally {
    fs.closeSync(fd);
  }
  return { truncated: true, size_bytes: maxBytes, original_size: stat.size };
}

// ── 确定性预检 ────────────────────────────────────────────────────
/**
 * 对单个 feature 做确定性预检，返回 { blocking: bool, issues: [...] }
 * blocking=true 时该 feature 不入 Agent 池
 */
function runDeterministicChecks({ featureId, featureData, worktreePath, designData }) {
  const issues   = [];
  let   blocking = false;

  const commit = getFeatureCommit(featureData);
  const scoped = scopeFilesChangedForReview(featureData, designData);
  const paths  = scoped.paths;

  if (paths.length === 0) {
    issues.push({
      severity: 'critical',
      category: 'other',
      file:     null,
      line:     null,
      message:  `feature ${featureId}: codegen 变更文件集为空或均为噪声路径（empty commit）`,
      suggested_fix: '请重新执行 codegen，确保有实际代码变更',
      source: 'deterministic',
    });
    blocking = true;
  } else if (scoped.truncated && scoped.totalRaw > FILES_CHANGED_RAW_WARN) {
    issues.push({
      severity: 'warning',
      category: 'other',
      file:     null,
      line:     null,
      message:  `files_changed 原始 ${scoped.totalRaw} 条，预检收敛为 ${paths.length} 条（${scoped.strategy || 'cap'}）`,
      suggested_fix: 'codegen 宜只记录本 feature 相关路径；当前按 file_plan 抽样预检',
      source: 'deterministic',
    });
  }

  if (commit && fs.existsSync(worktreePath)) {
    try {
      const headCommit = execSync('git rev-parse HEAD', {
        cwd: worktreePath, encoding: 'utf8', maxBuffer: 1024 * 1024,
      }).trim();
      if (headCommit !== commit) {
        issues.push({
          severity: 'critical',
          category: 'consistency',
          file:     null,
          line:     null,
          message:  `feature ${featureId}: worktree HEAD(${headCommit}) 与 codegen commit(${commit}) 不一致（worktree HEAD drifted）`,
          suggested_fix: '请重新执行 codegen 或 reset worktree',
          source: 'deterministic',
        });
        blocking = true;
      }
    } catch (_) { /* worktree 可能不存在 */ }
  }

  if (designData) {
    const allowedFiles = getFilePlanPathSet(designData);

    if (allowedFiles.size > 0 && paths.length > 0) {
      const outOfPlan = paths.filter(p => !allowedFiles.has(p));
      for (const fname of outOfPlan.slice(0, FILE_PLAN_WARN_SAMPLE)) {
        issues.push({
          severity: 'warning',
          category: 'file_plan',
          file:     fname,
          line:     null,
          message:  `文件 ${fname} 不在 design.json file_plan 范围内（越界变更）`,
          suggested_fix: '确认该文件是否应在 file_plan 中声明',
          source: 'deterministic',
        });
      }
      if (outOfPlan.length > FILE_PLAN_WARN_SAMPLE) {
        issues.push({
          severity: 'warning',
          category: 'file_plan',
          file:     null,
          line:     null,
          message:  `另有 ${outOfPlan.length - FILE_PLAN_WARN_SAMPLE} 个越界文件未逐条列出`,
          suggested_fix: null,
          source: 'deterministic',
        });
      }
    }

    const apiOutline = designData.api_outline || [];
    if (Array.isArray(apiOutline) && paths.length > 0) {
      for (const api of apiOutline) {
        const apiPath = api.path || api.endpoint || '';
        if (!apiPath) continue;
        const hitInFiles = paths.some(fname => fname.includes(apiPath) || apiPath.includes(fname));
        if (!hitInFiles) {
          issues.push({
            severity: 'warning',
            category: 'api_outline',
            file:     null,
            line:     null,
            message:  `api_outline 路径 "${apiPath}" 未在收敛后的 files_changed 中命中（需 Agent 进一步确认）`,
            suggested_fix: null,
            source: 'deterministic',
          });
        }
      }
    }
  }

  return { blocking, issues: capDeterministicIssues(issues) };
}

// ── 生成 diff 文件 ─────────────────────────────────────────────────
function generateDiffFile(featureId, featureData, worktreePath, scopedPaths) {
  const diffPath = path.join(projectRoot, '.pipeline', `code-review-${featureId}.diff`);

  if (!fs.existsSync(worktreePath)) {
    fs.writeFileSync(diffPath, `# worktree not found: ${worktreePath}\n`, 'utf8');
    log.warn('file_created', `worktree 不存在，写空 diff: ${diffPath}`, {
      feature_id: featureId, path: diffPath, worktree_path: worktreePath,
    });
    return diffPath;
  }

  const paths = Array.isArray(scopedPaths) ? scopedPaths.filter(Boolean) : [];

  try {
    const baseCommit = resolveDiffBaseCommit(worktreePath);
    fs.writeFileSync(
      diffPath,
      `# code-review diff feature=${featureId} base=${baseCommit}\n`,
      'utf8'
    );

    if (paths.length === 0) {
      appendGitDiffRange(worktreePath, baseCommit, diffPath, [], { append: true });
    } else {
      for (let i = 0; i < paths.length; i += DIFF_PATHSPEC_BATCH) {
        const batch = paths.slice(i, i + DIFF_PATHSPEC_BATCH);
        appendGitDiffRange(worktreePath, baseCommit, diffPath, batch, { append: true });
      }
    }

    const trunc = truncateDiffFileIfNeeded(diffPath);
    log.info('file_created', `已生成 diff 文件：code-review-${featureId}.diff`, {
      feature_id:     featureId,
      path:           diffPath,
      size_bytes:     trunc.size_bytes,
      pathspec_count: paths.length,
      truncated:      trunc.truncated || false,
      original_size:  trunc.original_size || trunc.size_bytes,
    });
  } catch (err) {
    fs.writeFileSync(diffPath, `# git diff failed: ${err.message}\n`, 'utf8');
    log.warn('file_created', `git diff 失败，写错误 diff: ${diffPath}`, {
      feature_id: featureId, path: diffPath, error: err.message,
    });
  }

  return diffPath;
}

// ── 派生 decision ─────────────────────────────────────────────────
function deriveDecision(criticalIssues, warnings, checklistFailed) {
  if (criticalIssues > 0) return 'failed';
  if (warnings > 0)       return 'passed_with_warnings';
  if (checklistFailed > 0) return 'passed_with_warnings';
  return 'passed';
}

// ── Agent 调用 ────────────────────────────────────────────────────
async function invokeAgent(opts) {
  const {
    agentId, promptFile, inputFiles = [], model, timeoutMs,
    featureId, cwd = projectRoot, extraContext = {}, logExtraMeta = {},
  } = opts;

  const promptPath = path.join(skillsRoot, 'ai-std4', 'prompts', promptFile);
  let promptContent = '';
  if (fs.existsSync(promptPath)) {
    promptContent = fs.readFileSync(promptPath, 'utf8');
  } else {
    return {
      success: false, timedOut: false,
      error: `Prompt file not found: ${promptPath}`, agentRunId: null,
    };
  }

  const contextLines = Object.entries(extraContext)
    .map(([k, v]) => `\n<!-- inject: ${k}=${v} -->`).join('');
  const finalPrompt = promptContent + contextLines;

  log.info('agent_start', `启动 Agent: ${agentId}`, {
    agent_id:    agentId,
    feature_id:  featureId,
    prompt:      promptFile,
    input_files: inputFiles,
    model,
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
      const agent = await Agent.create(agentOptions);
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
          success:    result.status === 'finished',
          error:      result.status !== 'finished' ? `Agent run status: ${result.status}` : null,
          agentRunId,
        };
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

// ── 单 feature Agent 评审（带重试）──────────────────────────────
async function runCodeReviewAgentForFeature({
  featureId, featureData, designData, worktreePath, diffPath,
  deterministicIssues, model, timeoutMs, maxRetries, stagesObj,
}) {
  const outputFile = path.join(projectRoot, '.pipeline', `code-review-${featureId}.json`);
  const agentId    = `code-review-agent-${featureId}`;
  const t0         = Date.now();

  // 按 feature 哈希门控：commit_reviewed 匹配 + review_hash 匹配 + decision≠failed → 跳过
  const existingFeature = stagesObj.stages.code_review &&
                          stagesObj.stages.code_review.features &&
                          stagesObj.stages.code_review.features[featureId];
  const commit = getFeatureCommit(featureData);

  if (!forceRerun && existingFeature && existingFeature.commit_reviewed === commit) {
    const existingReviewHash = existingFeature.review_hash;
    const currentReviewHash  = fileSha256(outputFile);
    if (
      existingReviewHash && currentReviewHash &&
      existingReviewHash === currentReviewHash &&
      existingFeature.decision !== 'failed'
    ) {
      log.info('agent_skipped', `Agent(${featureId}) 跳过：commit_reviewed + review_hash 命中`, {
        agent_id:   agentId,
        feature_id: featureId,
        reason:     'commit_reviewed + review_hash matched, prior decision retained',
      });
      return {
        success: true, skipped: true, timedOut: false,
        featureId, decision: existingFeature.decision,
        criticalIssues: existingFeature.critical_issues || 0,
        warnings:       existingFeature.warnings || 0,
        attemptsUsed:   existingFeature.attempts_used || 1,
        durationMs:     0,
      };
    }
  }

  const codegen = stagesObj.stages.codegen;
  const hangHistory    = (codegen.features && codegen.features[featureId] && codegen.features[featureId].hang_history) || [];
  const attemptsInCodegen = (codegen.features && codegen.features[featureId] && codegen.features[featureId].attempts_used) || 0;

  const designFile       = path.join(projectRoot, 'docs', 'designs', `${featureId}.design.json`);
  const scenariosFile    = path.join(projectRoot, 'docs', 'ui-scenarios', `${featureId}.scenarios.yaml`);
  const inputFiles       = [worktreePath, diffPath, designFile];
  if (fs.existsSync(scenariosFile)) inputFiles.push(scenariosFile);

  const codegenContext = {
    feature_id:           featureId,
    commit:               commit || '',
    files_changed_count:  featureData.files_changed_count || (featureData.files_changed || []).length,
    attempts_used:        attemptsInCodegen,
    hang_kinds:           JSON.stringify(hangHistory.map(h => h.kind || h.type || 'unknown')),
    worktree_path:        worktreePath,
    diff_file:            diffPath,
    design_file:          designFile,
    output_file:          outputFile,
    deterministic_issues: JSON.stringify(deterministicIssues),
  };

  let lastError    = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    attemptsUsed = attempt;

    if (attempt > 1) {
      log.warn('agent_retry', `Agent(${featureId}) 第 ${attempt} 次尝试`, {
        agent_id:   agentId,
        feature_id: featureId,
        attempt,
        reason:     lastError,
      });
    }

    const result = await invokeAgent({
      agentId,
      promptFile:  'code-review-agent.md',
      inputFiles,
      model,
      timeoutMs,
      featureId,
      cwd: projectRoot,
      extraContext: codegenContext,
      logExtraMeta: {
        deterministic_issues_count: deterministicIssues.length,
      },
    });
    const durationMs = Date.now() - t0;

    if (result.timedOut) {
      if (attempt <= maxRetries) {
        log.warn('agent_retry', `Agent(${featureId}) 超时，第 ${attempt} 次重试`, {
          agent_id: agentId, feature_id: featureId, attempt,
          reason: 'timeout', timed_out: true,
        });
        lastError = result.error;
        continue;
      }
      log.error('agent_failed', `Agent(${featureId}) 超时，已超过最大重试次数`, {
        agent_id:     agentId,
        feature_id:   featureId,
        exit_code:    3,
        reason:       result.error,
        timed_out:    true,
        attempts_used: attemptsUsed,
      });
      return {
        success: false, skipped: false, timedOut: true,
        featureId, error: result.error, attemptsUsed, durationMs,
      };
    }

    if (!result.success) {
      lastError = result.error || 'Agent failed';
      if (attempt > maxRetries) break;
      log.warn('agent_retry', `Agent(${featureId}) 失败，第 ${attempt} 次重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
      continue;
    }

    // 读取输出文件
    if (!fs.existsSync(outputFile)) {
      lastError = `Output file not found: ${outputFile}`;
      if (attempt > maxRetries) break;
      log.warn('agent_retry', `Agent(${featureId}) 输出文件缺失，重试`, {
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
      log.warn('agent_retry', `Agent(${featureId}) JSON 解析失败，重试`, {
        agent_id: agentId, feature_id: featureId, attempt, reason: lastError,
      });
      continue;
    }

    // Schema 校验
    const { valid, errors } = validateJson(outputData, 'code-review-feature-output.schema.json');
    if (!valid) {
      const invalidFields = errors.map(e => e.instancePath + ' ' + e.message);
      lastError = `Schema validation failed: ${invalidFields.join('; ')}`;
      log.warn('agent_retry', `Agent(${featureId}) schema 校验失败`, {
        agent_id:      agentId,
        feature_id:    featureId,
        attempt,
        invalid_fields: invalidFields,
      });
      if (attempt > maxRetries) break;
      continue;
    }

    // 检查 deterministic_issues 是否被复述（若有 blocking 项）
    const blockingDeterministic = deterministicIssues.filter(i => i.severity === 'critical');
    if (blockingDeterministic.length > 0) {
      const agentIssues = (outputData.review && outputData.review.issues) || [];
      const deterministicInAgent = agentIssues.filter(i => i.source === 'deterministic');
      const missingKeys = blockingDeterministic
        .filter(di => !deterministicInAgent.some(ai =>
          ai.message && ai.message.includes(di.message.substring(0, 30))
        ))
        .map(di => di.message.substring(0, 60));

      if (missingKeys.length > 0 && attempt <= maxRetries) {
        log.warn('agent_retry', `Agent(${featureId}) 遗漏 deterministic_issues，重试`, {
          agent_id:          agentId,
          feature_id:        featureId,
          attempt,
          reason:            'missing deterministic_issues',
          missing_issue_keys: missingKeys,
        });
        lastError = `Missing deterministic_issues: ${missingKeys.join('; ')}`;
        continue;
      }
    }

    // 合并 deterministic_issues 入 review.issues（去重）
    const agentIssues = (outputData.review && outputData.review.issues) || [];
    const mergedIssues = [...agentIssues];

    for (const di of deterministicIssues) {
      const key = `${di.category}|${di.file || ''}|${di.message.substring(0, 30)}`;
      const existIdx = mergedIssues.findIndex(ai => {
        const aiKey = `${ai.category}|${ai.file || ''}|${ai.message.substring(0, 30)}`;
        return aiKey === key;
      });
      if (existIdx >= 0) {
        // 取更严重的 severity
        const SEV = { critical: 3, warning: 2, info: 1 };
        const existSev  = SEV[mergedIssues[existIdx].severity] || 0;
        const newSev    = SEV[di.severity] || 0;
        if (newSev > existSev) mergedIssues[existIdx].severity = di.severity;
      } else {
        mergedIssues.push(di);
      }
    }

    outputData.review.issues = mergedIssues;

    // 重算 critical_issues / warnings
    const criticalIssues = mergedIssues.filter(i => i.severity === 'critical').length;
    const warnings       = mergedIssues.filter(i => i.severity === 'warning').length;
    const checklistFailed = (outputData.outputs && outputData.outputs.checklist_failed) || 0;
    const checklistPassed = (outputData.outputs && outputData.outputs.checklist_passed) || 0;

    // 派生 decision（脚本重算，覆盖 Agent 自报）
    const derivedDecision = deriveDecision(criticalIssues, warnings, checklistFailed);
    outputData.outputs.decision        = derivedDecision;
    outputData.outputs.critical_issues = criticalIssues;
    outputData.outputs.warnings        = warnings;

    // 写回合并后的 JSON
    fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2) + '\n', 'utf8');
    const reviewHash = fileSha256(outputFile);

    log.info('agent_complete', `Agent(${featureId}) 完成`, {
      agent_id:      agentId,
      feature_id:    featureId,
      duration_ms:   durationMs,
      decision:      derivedDecision,
      critical_issues: criticalIssues,
      warnings,
      checklist_passed: checklistPassed,
      checklist_failed: checklistFailed,
      output_files:  [`code-review-${featureId}.json`],
    });

    log.info('feature_review_complete', `feature ${featureId} 评审完成`, {
      feature_id:      featureId,
      decision:        derivedDecision,
      critical_issues: criticalIssues,
      warnings,
      checklist_passed: checklistPassed,
      checklist_failed: checklistFailed,
    });

    return {
      success: true, skipped: false, timedOut: false,
      featureId, decision: derivedDecision, criticalIssues, warnings,
      checklistPassed, checklistFailed,
      attemptsUsed, durationMs, reviewHash,
      commit, totalIssues: mergedIssues.length,
    };
  }

  // 超出重试次数
  const durationMs = Date.now() - t0;
  log.error('agent_failed', `Agent(${featureId}) 超出最大重试次数`, {
    agent_id:      agentId,
    feature_id:    featureId,
    exit_code:     4,
    reason:        lastError,
    timed_out:     false,
    attempts_used: attemptsUsed,
  });
  return {
    success: false, skipped: false, timedOut: false,
    featureId, error: lastError, attemptsUsed, durationMs,
  };
}

/** 将单 feature 评审结果写入 stages.code_review.features（供看板实时展示） */
async function persistCodeReviewFeatureProgress(progress, featureId, result) {
  const now = formatLocalTimeShort();
  if (result.stopped) {
    return progress.patchFeature('code_review', featureId, { status: 'stopped' });
  }
  if (result.skipped) {
    return progress.patchFeature('code_review', featureId, {
      status:         'completed',
      decision:       result.decision || 'passed',
      completed_at:   now,
      attempts_used:  result.attemptsUsed || 1,
    });
  }
  if (result.success) {
    return progress.patchFeature('code_review', featureId, {
      status:           'completed',
      decision:         result.decision,
      completed_at:     now,
      attempts_used:    result.attemptsUsed || 1,
      critical_issues:  result.criticalIssues || 0,
      warnings:         result.warnings || 0,
      total_issues:     (result.criticalIssues || 0) + (result.warnings || 0),
      timed_out:        false,
      error:            null,
    });
  }
  return progress.patchFeature('code_review', featureId, {
    status:        'failed',
    decision:      'failed',
    completed_at:  now,
    attempts_used: result.attemptsUsed || 0,
    timed_out:     !!result.timedOut,
    error:         result.error || null,
  });
}

// ── 并发 Worker 池 ────────────────────────────────────────────────
async function runAgentsConcurrent({
  featureIds, featureMap, designMap,
  model, timeoutMs, maxRetries, effectiveParallel, stagesObj, progress,
}) {
  const results    = [];
  let   index      = 0;
  let   timedOutExists = false;

  const batchId = `code-review-batch-1`;
  log.info('agent_batch_start', `code-review Agent 批次开始，共 ${featureIds.length} features`, {
    batch_id:         batchId,
    feature_ids:      featureIds,
    agents_total:     featureIds.length,
    agents_skipped:   [],
    effective_parallel: effectiveParallel,
  });

  const batchT0 = Date.now();

  async function worker() {
    while (index < featureIds.length) {
      const featureId = featureIds[index++];

      if (checkStopSignal()) {
        results.push({ success: false, timedOut: false, featureId, stopped: true });
        continue;
      }

      const featureData        = featureMap[featureId];
      const worktreePath       = getWorktreePath(featureData, featureId);
      const designData         = designMap[featureId] || null;
      const scoped = scopeFilesChangedForReview(featureData, designData);

      // 确定性预检（基于收敛后的 paths，避免 file_plan 对象比较导致万级 warning）
      const { blocking, issues } = runDeterministicChecks({
        featureId, featureData, worktreePath, designData,
      });
      const deterministicIssues = [...issues];

      if (blocking) {
        log.error('agent_failed', `feature ${featureId} 确定性预检阻塞，跳过 Agent`, {
          agent_id:   `code-review-agent-${featureId}`,
          feature_id: featureId,
          exit_code:  4,
          reason:     `deterministic blocking: ${issues.map(i => i.message).join('; ')}`,
          timed_out:  false,
          attempts_used: 0,
        });
        const blockResult = {
          success: false, skipped: false, timedOut: false,
          featureId, decision: 'failed', criticalIssues: issues.filter(i => i.severity === 'critical').length,
          warnings: issues.filter(i => i.severity === 'warning').length,
          attemptsUsed: 0, durationMs: 0,
          error: `deterministic blocking issues: ${issues.map(i => i.message).join('; ')}`,
          deterministicBlocking: true,
        };
        if (progress) {
          await progress.patchFeature('code_review', featureId, {
            status: 'running', started_at: formatLocalTimeShort(),
          });
          await persistCodeReviewFeatureProgress(progress, featureId, blockResult);
        }
        results.push(blockResult);
        continue;
      }

      if (progress) {
        await progress.patchFeature('code_review', featureId, {
          status: 'running', started_at: formatLocalTimeShort(),
        });
      }

      // 生成 diff 文件（按收敛路径写盘，避免全仓 diff ENOBUFS）
      const diffPath = generateDiffFile(featureId, featureData, worktreePath, scoped.paths);

      const result = await runCodeReviewAgentForFeature({
        featureId, featureData, designData, worktreePath, diffPath,
        deterministicIssues, model, timeoutMs, maxRetries, stagesObj,
      });

      if (result.timedOut) timedOutExists = true;
      if (progress) await persistCodeReviewFeatureProgress(progress, featureId, result);
      results.push(result);
    }
  }

  const concurrency = Math.min(effectiveParallel, featureIds.length);
  const workers     = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  const batchDurationMs  = Date.now() - batchT0;
  const succeededFeatures = results.filter(r => r.success).map(r => r.featureId);
  const failedFeatures    = results.filter(r => !r.success).map(r => r.featureId);

  log.info('agent_batch_complete', 'code-review Agent 批次结束', {
    batch_id:          batchId,
    agents_succeeded:  succeededFeatures,
    agents_failed:     failedFeatures,
    agents_skipped:    results.filter(r => r.skipped).map(r => r.featureId),
    duration_ms:       batchDurationMs,
  });

  return { results, timedOutExists };
}

// ── 生成 code-review-summary.md ───────────────────────────────────
function generateSummaryReport({ features, featureResults, decision, criticalIssuesTotal, warningsTotal }) {
  const checkedAt = formatLocalTimeShort();
  let   md = `# Code Review 评审报告\n\n`;
  md += `## 概述\n\n`;
  md += `| 项 | 值 |\n| --- | --- |\n`;
  md += `| **评审时间** | ${checkedAt} |\n`;
  md += `| **整体决策** | ${decision === 'passed' ? '✓ PASSED' : decision === 'passed_with_warnings' ? '⚠ PASSED_WITH_WARNINGS' : '✗ FAILED'} |\n`;
  md += `| **Feature 总数** | ${Object.keys(features).length} |\n`;
  md += `| **Critical Issues** | ${criticalIssuesTotal} |\n`;
  md += `| **Warnings** | ${warningsTotal} |\n\n`;

  md += `## Feature 评审结果\n\n`;
  md += `| Feature | 决策 | Critical | Warnings | Checklist 通过率 | 关键 Issue |\n`;
  md += `| --- | --- | --- | --- | --- | --- |\n`;

  for (const [fid, fr] of Object.entries(featureResults)) {
    const checklistTotal  = (fr.checklistPassed || 0) + (fr.checklistFailed || 0);
    const checklistRate   = checklistTotal > 0 ? `${fr.checklistPassed || 0}/${checklistTotal}` : 'n/a';
    const decisionIcon    = fr.decision === 'passed' ? '✓' : fr.decision === 'passed_with_warnings' ? '⚠' : '✗';
    const keyIssue        = fr.error ? fr.error.substring(0, 80) : (fr.decision === 'passed' ? '无' : `${fr.criticalIssues || 0} critical issue(s)`);
    md += `| ${fid} | ${decisionIcon} ${fr.decision || 'failed'} | ${fr.criticalIssues || 0} | ${fr.warnings || 0} | ${checklistRate} | ${keyIssue} |\n`;
  }
  md += '\n';

  const failedFids = Object.entries(featureResults).filter(([, r]) => r.decision === 'failed').map(([fid]) => fid);
  if (failedFids.length > 0) {
    md += `## 失败 Feature 列表\n\n`;
    for (const fid of failedFids) {
      const fr = featureResults[fid];
      md += `### ${fid}\n\n`;
      md += `- **决策**: ${fr.decision}\n`;
      md += `- **Critical Issues**: ${fr.criticalIssues || 0}\n`;
      md += `- **错误**: ${fr.error || '见评审 JSON 文件'}\n\n`;

      // 读取评审 JSON 中的 issues
      const reviewFile = path.join(projectRoot, '.pipeline', `code-review-${fid}.json`);
      if (fs.existsSync(reviewFile)) {
        try {
          const reviewData = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
          const issues = (reviewData.review && reviewData.review.issues) || [];
          const criticals = issues.filter(i => i.severity === 'critical');
          if (criticals.length > 0) {
            md += `**Critical Issues**：\n`;
            for (const issue of criticals) {
              md += `- [${issue.category}] ${issue.message}\n`;
              if (issue.file) md += `  - 文件: ${issue.file}\n`;
            }
            md += '\n';
          }
        } catch (_) { /* ignore */ }
      }
    }
  }

  md += `---\n\n*由 ai-std4 code-review stage 自动生成（${checkedAt}）*\n`;
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

  log.info('stage_start', `code-review stage 启动，项目: ${projectRoot}`, {
    run_id:     runId,
    stage:      'code-review',
    project:    projectRoot,
    started_at: startedAtStr,
  });

  // 1. 上游门闸：codegen.status=completed
  let stagesObj = readStagesJson();
  if (!stagesObj) {
    log.error('stage_failed', 'stages.json 不存在，codegen 尚未完成', {
      stage: 'code-review', exit_code: 1, reason: 'stages.json missing', duration_ms: 0,
    });
    process.exit(1);
  }

  const codegenStage = stagesObj.stages && stagesObj.stages.codegen;
  if (!codegenStage || codegenStage.status !== 'completed') {
    log.error('stage_failed', '上游门闸未满足：codegen.status 不是 completed', {
      stage:      'code-review',
      exit_code:  1,
      reason:     `codegen.status=${codegenStage ? codegenStage.status : 'missing'}`,
      duration_ms: 0,
    });
    process.exit(1);
  }

  // 2. 检测 stop.signal（门闸通过后）
  if (checkStopSignal()) {
    gracefulStop(readStagesJson());
  }

  // 读取配置
  const { timeoutS, maxRetries, model, effectiveParallel } = readConfig();
  const timeoutMs = timeoutS * 1000;

  // 收集 codegen 已完成的 features
  let codegenFeatures = collectCodegenFeatures(codegenStage);

  // 应用 --feature 过滤
  if (featureFilter) {
    if (codegenFeatures[featureFilter]) {
      codegenFeatures = { [featureFilter]: codegenFeatures[featureFilter] };
    } else {
      log.error('stage_failed', `--feature=${featureFilter} 不在 codegen completed 列表中`, {
        stage: 'code-review', exit_code: 1, reason: `feature ${featureFilter} not in codegen.features`,
      });
      process.exit(1);
    }
  }

  const featureIds = Object.keys(codegenFeatures).sort();

  if (featureIds.length === 0) {
    log.error('stage_failed', 'codegen 没有已完成的 features', {
      stage: 'code-review', exit_code: 1, reason: 'no completed features in codegen',
    });
    process.exit(1);
  }

  // 3. hash 门控（全段跳过判断）
  if (!forceRerun) {
    const codeReviewStage = stagesObj.stages && stagesObj.stages.code_review;
    if (
      codeReviewStage &&
      codeReviewStage.status === 'completed' &&
      codeReviewStage.outputs &&
      codeReviewStage.outputs.decision !== 'failed'
    ) {
      const storedHashes = (codeReviewStage.inputs && codeReviewStage.inputs.codegen_commit_hashes) || {};
      const storedBundleHash  = codeReviewStage.inputs && codeReviewStage.inputs.review_bundle_hash;
      const computedBundleHash = computeReviewBundleHash(codegenFeatures);

      // 检查每个 feature 的 commit 是否匹配
      let allHashesHit = featureIds.length > 0;
      for (const fid of featureIds) {
        const currentCommit = getFeatureCommit(codegenFeatures[fid]);
        const storedCommit  = storedHashes[fid];
        const hit           = !!(currentCommit && storedCommit && currentCommit === storedCommit);
        log.info('hash_check', `hash 门控：feature ${fid}`, {
          feature_id:    fid,
          stored_hash:   storedCommit || null,
          computed_hash: currentCommit,
          hit,
        });
        if (!hit) allHashesHit = false;
      }

      const bundleHashHit = storedBundleHash && storedBundleHash === computedBundleHash;
      log.info('hash_check', 'review_bundle_hash 比对', {
        stored_hash:   storedBundleHash || null,
        computed_hash: computedBundleHash,
        hit:           !!bundleHashHit,
      });

      if (allHashesHit) {
        log.info('stage_skipped', 'code-review hash 门控命中，跳过执行', {
          stage:     'code-review',
          reason:    'review_bundle_hash matched, prior decision retained',
          exit_code: 0,
        });
        process.exit(0);
      }
    }
  }

  // 4. bootstrap：初始化/更新 stages.code_review 骨架
  stagesObj = readStagesJson();
  if (!stagesObj.stages) stagesObj.stages = {};

  const existingCodeReview = stagesObj.stages.code_review;
  const reviewBundleHash   = computeReviewBundleHash(codegenFeatures);
  const commitHashes       = buildCommitHashes(codegenFeatures);

  if (!existingCodeReview) {
    // 初始化骨架
    const featuresInit = {};
    for (const fid of featureIds) {
      featuresInit[fid] = {
        status:          'pending',
        decision:        'pending',
        started_at:      null,
        completed_at:    null,
        attempts_used:   0,
        commit_reviewed: null,
        review_hash:     null,
        review_file:     path.join(projectRoot, '.pipeline', `code-review-${fid}.json`),
        critical_issues: 0,
        warnings:        0,
        total_issues:    0,
        timed_out:       false,
        error:           null,
      };
    }

    stagesObj.stages.code_review = {
      status:      'running',
      started_at:  startedAtStr,
      completed_at: null,
      inputs: {
        review_bundle_hash:   reviewBundleHash,
        codegen_commit_hashes: commitHashes,
        requires_stage:       'codegen',
      },
      outputs: {
        decision:              'pending',
        feature_reviews:       [],
        passed_features:       [],
        failed_features:       [],
        critical_issues_total: 0,
        warnings_total:        0,
        duration_ms:           null,
        timed_out:             false,
        timeout_reason:        null,
      },
      features:        featuresInit,
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
      git_sync: {
        initial_pushed_at:       null,
        docs_pipeline_pushed_at: null,
        last_commit:             null,
        last_push_status:        null,
      },
    };

    const sp   = writeStagesJson(stagesObj);
    const stat = fs.statSync(sp);
    log.info('file_created', '已写入 stages.code_review 骨架', {
      path: sp, size_bytes: stat.size, status: 'running',
      effective_parallel:   effectiveParallel,
      pending_feature_ids:  featureIds,
      zombie_features_reset: [],
    });
  } else {
    // 更新现有骨架
    const zombieReset = [];

    if (!existingCodeReview.features) existingCodeReview.features = {};
    for (const fid of featureIds) {
      if (!existingCodeReview.features[fid]) {
        existingCodeReview.features[fid] = {
          status:          'pending',
          decision:        'pending',
          started_at:      null,
          completed_at:    null,
          attempts_used:   0,
          commit_reviewed: null,
          review_hash:     null,
          review_file:     path.join(projectRoot, '.pipeline', `code-review-${fid}.json`),
          critical_issues: 0,
          warnings:        0,
          total_issues:    0,
          timed_out:       false,
          error:           null,
        };
      } else if (existingCodeReview.features[fid].status === 'running') {
        existingCodeReview.features[fid].status = 'pending';
        zombieReset.push(fid);
      }
    }

    existingCodeReview.status     = 'running';
    existingCodeReview.started_at = startedAtStr;
    if (!existingCodeReview.inputs) existingCodeReview.inputs = {};
    existingCodeReview.inputs.review_bundle_hash   = reviewBundleHash;
    existingCodeReview.inputs.codegen_commit_hashes = commitHashes;

    const sp   = writeStagesJson(stagesObj);
    const stat = fs.statSync(sp);
    log.info('file_updated', '已更新 stages.code_review（status=running）', {
      path: sp, size_bytes: stat.size, status: 'running',
      effective_parallel:    effectiveParallel,
      pending_feature_ids:   featureIds,
      zombie_features_reset: zombieReset,
    });
  }

  log.info('hash_check', 'review_bundle_hash 已计算', {
    review_bundle_hash: reviewBundleHash,
    stored_hash:        null,
    computed_hash:      reviewBundleHash,
    hit:                false,
  });

  // 5. 加载 design.json（供确定性预检使用）
  const designMap = {};
  for (const fid of featureIds) {
    const designFile = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);
    if (fs.existsSync(designFile)) {
      try {
        designMap[fid] = JSON.parse(fs.readFileSync(designFile, 'utf8'));
      } catch (_) { designMap[fid] = null; }
    }
  }

  // 检测 stop.signal（Agent 批次启动前）
  if (checkStopSignal()) {
    gracefulStop(readStagesJson());
  }

  // 6. 并发 Agent 池
  const featureProgress = createStagesJsonWriteQueue(projectRoot, {
    touchUpdatedAt: formatLocalTimeShort,
  });
  const { results, timedOutExists } = await runAgentsConcurrent({
    featureIds,
    featureMap:         codegenFeatures,
    designMap,
    model,
    timeoutMs,
    maxRetries,
    effectiveParallel,
    stagesObj:          readStagesJson(),
    progress:           featureProgress,
  });

  // 检测是否有 stop.signal
  for (const r of results) {
    if (r.stopped) {
      gracefulStop(readStagesJson());
    }
  }

  // 7. validate + finalize
  stagesObj = readStagesJson();
  const completedAt    = new Date();
  const completedAtStr = formatLocalTimeShort(completedAt);
  const durationMs     = completedAt.getTime() - startedAt.getTime();

  // 汇总结果
  const featureResultMap  = {};
  const failedFeatureIds  = [];
  const passedFeatureIds  = [];
  let   criticalTotal     = 0;
  let   warningsTotal     = 0;
  let   hasTimedOut       = timedOutExists;
  let   hasRealFailure    = false;

  for (const r of results) {
    featureResultMap[r.featureId] = r;

    if (r.success || r.skipped) {
      const decision = r.decision || 'passed';
      if (decision === 'failed') {
        failedFeatureIds.push(r.featureId);
        hasRealFailure = true;
      } else {
        passedFeatureIds.push(r.featureId);
      }
      criticalTotal += r.criticalIssues || 0;
      warningsTotal += r.warnings       || 0;
    } else {
      failedFeatureIds.push(r.featureId);
      if (r.timedOut) hasTimedOut = true;
      else            hasRealFailure = true;
    }
  }

  // 更新 stages.code_review.features
  for (const r of results) {
    const fid = r.featureId;
    if (!stagesObj.stages.code_review.features) {
      stagesObj.stages.code_review.features = {};
    }
    if (!stagesObj.stages.code_review.features[fid]) {
      stagesObj.stages.code_review.features[fid] = {};
    }
    const fEntry = stagesObj.stages.code_review.features[fid];

    if (r.stopped) {
      fEntry.status = 'stopped';
    } else if (r.skipped) {
      fEntry.status        = 'completed';
      fEntry.decision      = r.decision;
      fEntry.attempts_used = r.attemptsUsed || 1;
    } else if (r.success) {
      fEntry.status          = 'completed';
      fEntry.decision        = r.decision;
      fEntry.started_at      = startedAtStr;
      fEntry.completed_at    = completedAtStr;
      fEntry.attempts_used   = r.attemptsUsed || 1;
      fEntry.commit_reviewed = r.commit || getFeatureCommit(codegenFeatures[fid]) || null;
      fEntry.review_hash     = r.reviewHash || null;
      fEntry.review_file     = path.join(projectRoot, '.pipeline', `code-review-${fid}.json`);
      fEntry.critical_issues = r.criticalIssues || 0;
      fEntry.warnings        = r.warnings || 0;
      fEntry.total_issues    = r.totalIssues || 0;
      fEntry.timed_out       = false;
      fEntry.error           = null;
    } else {
      fEntry.status          = 'failed';
      fEntry.decision        = 'failed';
      fEntry.started_at      = startedAtStr;
      fEntry.completed_at    = completedAtStr;
      fEntry.attempts_used   = r.attemptsUsed || 0;
      fEntry.timed_out       = r.timedOut || false;
      fEntry.error           = r.error || null;
      if (r.timedOut) fEntry.critical_issues = 0;
    }
  }

  // 派生 stage 级 decision
  let stageDecision;
  if (failedFeatureIds.length === 0 && criticalTotal === 0) {
    stageDecision = warningsTotal > 0 ? 'passed_with_warnings' : 'passed';
  } else {
    stageDecision = 'failed';
  }

  // 构建 feature_reviews[]
  const featureReviews = [];
  for (const fid of featureIds) {
    const r         = featureResultMap[fid] || {};
    const reviewFile = path.join(projectRoot, '.pipeline', `code-review-${fid}.json`);
    let checklistPassed = r.checklistPassed || 0;
    let checklistFailed = r.checklistFailed || 0;
    let issuesSummary   = '';
    if (fs.existsSync(reviewFile)) {
      try {
        const rd = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
        checklistPassed = (rd.outputs && rd.outputs.checklist_passed) || checklistPassed;
        checklistFailed = (rd.outputs && rd.outputs.checklist_failed) || checklistFailed;
        const issues    = (rd.review && rd.review.issues) || [];
        issuesSummary   = issues.slice(0, 3).map(i => `[${i.severity}] ${i.message.substring(0, 50)}`).join('; ');
      } catch (_) { /* ignore */ }
    }
    featureReviews.push({
      feature_id:       fid,
      decision:         r.success || r.skipped ? (r.decision || 'failed') : 'failed',
      critical_issues:  r.criticalIssues || 0,
      warnings:         r.warnings || 0,
      checklist_passed: checklistPassed,
      checklist_failed: checklistFailed,
      issues_summary:   issuesSummary,
      commit_reviewed:  r.commit || getFeatureCommit(codegenFeatures[fid]) || null,
    });
  }

  // 更新 stages.code_review.outputs
  stagesObj.stages.code_review.status       = stageDecision === 'failed' ? 'failed' : 'completed';
  stagesObj.stages.code_review.started_at   = startedAtStr;
  stagesObj.stages.code_review.completed_at = completedAtStr;
  stagesObj.stages.code_review.outputs = {
    decision:              stageDecision,
    feature_reviews:       featureReviews,
    passed_features:       passedFeatureIds,
    failed_features:       failedFeatureIds,
    critical_issues_total: criticalTotal,
    warnings_total:        warningsTotal,
    duration_ms:           durationMs,
    timed_out:             hasTimedOut,
    timeout_reason:        hasTimedOut ? 'One or more feature review agents timed out' : null,
  };

  stagesObj.stages.code_review.validation = {
    passed:                  stageDecision !== 'failed',
    checked_at:              completedAtStr,
    summary:                 stageDecision === 'failed'
      ? `${failedFeatureIds.length} feature(s) failed code review`
      : `All features passed code review`,
    required_files:          [],
    missing_required_fields: [],
    warnings:                warningsTotal > 0 ? [`${warningsTotal} total warning(s) across all features`] : [],
  };

  if (stagesObj.pipeline) {
    stagesObj.pipeline.updated_at = completedAtStr;
    if (stageDecision !== 'failed') {
      stagesObj.pipeline.current_stage        = 'code-review';
      stagesObj.pipeline.last_completed_stage = 'code-review';
    }
  }

  const sp   = writeStagesJson(stagesObj);
  const stat = fs.statSync(sp);

  if (stageDecision === 'failed') {
    log.error('validation_fail', `code-review stage 门闸未通过`, {
      decision:             stageDecision,
      failed_feature_ids:   failedFeatureIds,
      critical_issues_total: criticalTotal,
      exit_code:            hasTimedOut ? 3 : 4,
    });
  } else {
    log.info('validation_pass', `code-review stage 门闸通过`, {
      decision:              stageDecision,
      critical_issues_total: criticalTotal,
      warnings_total:        warningsTotal,
    });
  }

  log.info('file_updated', '已写 code-review 完成态', {
    path:                  sp,
    size_bytes:            stat.size,
    status:                stagesObj.stages.code_review.status,
    decision:              stageDecision,
    critical_issues_total: criticalTotal,
  });

  // 生成 code-review-summary.md
  const reportsDir = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const summaryPath = path.join(reportsDir, 'code-review-summary.md');
  const summaryContent = generateSummaryReport({
    features:            codegenFeatures,
    featureResults:      featureResultMap,
    decision:            stageDecision,
    criticalIssuesTotal: criticalTotal,
    warningsTotal,
  });
  fs.writeFileSync(summaryPath, summaryContent, 'utf8');
  log.info('file_created', '已生成 code-review-summary.md', { path: summaryPath });

  // 更新 generated_files
  stagesObj = readStagesJson();
  stagesObj.stages.code_review.generated_files = [summaryPath];
  writeStagesJson(stagesObj);

  // 退出
  if (stageDecision === 'failed') {
    const exitCode = hasTimedOut ? 3 : 4;
    log.error('stage_failed', `code-review stage 失败，exitCode=${exitCode}`, {
      stage:       'code-review',
      step:        'finalize',
      exit_code:   exitCode,
      reason:      `decision=${stageDecision}, failed_features=${failedFeatureIds.join(', ')}`,
      duration_ms: durationMs,
    });
    process.exit(exitCode);
  }

  log.info('stage_complete', `code-review stage 完成，耗时 ${durationMs}ms`, {
    stage:                'code-review',
    duration_ms:          durationMs,
    exit_code:            0,
    decision:             stageDecision,
    critical_issues_total: criticalTotal,
  });
  process.exit(0);
}

main().catch(err => {
  console.error(`[FATAL] code-review.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

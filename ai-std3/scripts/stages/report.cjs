'use strict';

/**
 * report.cjs — report stage（流水线最后一站）
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. 读取 stages.json（缺失 → exit 1）
 *   2. 初始化 stages.report 骨架，写 status=running
 *   3. 汇总所有 stage 状态，计算 overall
 *   4. 提取错误日志摘录（report-log-extract）
 *   5. has_errors=true 且未 --skip-agent → 调用 Agent（report-author.md）
 *   6. 渲染 pipeline-report.md
 *   7. 更新 stages.report outputs，写 pipeline.pipeline_complete_at
 *   8. stdout 输出 overall / report_path / pipeline_complete
 *   → exit 0（尽力而为，即使 overall=failed 也返回 0）
 *      exit 1（stages.json 缺失或致命写盘错误）
 *      exit 5（stop.signal）
 *
 * 参数：
 *   --project=<路径>         业务项目根（绝对或相对）
 *   --run-id=<id>            run_id（由 run-pipeline 传入）
 *   --session-id=<id>        会话 ID（缺省自动生成）
 *   --datetime=<YYYY-MM-DD_HH-mm-ss>  与日志文件名一致（缺省从 pipeline.run_started_at 推导）
 *   --failure-reason=<str>   编排器捕获的 stderr 一行摘要
 *   --from-stage=<stage>     续跑时使用，写入报告「本次自 <stage> 接上」
 *   --skip-agent             跳过 Agent，仅用模板填失败节
 *   --no-teardown            不调用 pipeline-teardown（调试用）
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { createLogger, formatLocalTimeShort } = require('../libs/logger.cjs');

// ── 核心 stage 列表（与阶段链一致）────────────────────────────────
const CORE_STAGES = [
  'setup', 'prd', 'prd_review', 'design', 'design_review',
  'create_ui_scenarios', 'codegen', 'code_review', 'merge_push',
  'build', 'deploy', 'ui_e2e',
];

// 关键路径 stage（失败 → overall=failed）
const CRITICAL_STAGES = ['codegen', 'code_review', 'merge_push', 'build'];

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

const skipAgent   = args['skip-agent'] === true || args['skip-agent'] === 'true';
const noTeardown  = args['no-teardown'] === true || args['no-teardown'] === 'true';
const failureReason = args['failure-reason'] || null;
const fromStage     = args['from-stage']     || null;

// ── 生成 run_id ───────────────────────────────────────────────────
function generateRunId() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${crypto.randomBytes(4).toString('hex')}`;
}

const runId     = args['run-id']      || generateRunId();
const sessionId = args['session-id']  || crypto.randomBytes(4).toString('hex');

// ── 初始化 Logger ─────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'report', runId });

// ── stages.json 读写 ──────────────────────────────────────────────
const stagesJsonPath = path.join(projectRoot, '.pipeline', 'stages.json');

function readStagesJson() {
  if (!fs.existsSync(stagesJsonPath)) return null;
  try { return JSON.parse(fs.readFileSync(stagesJsonPath, 'utf8')); } catch (_) { return null; }
}

function writeStagesJson(obj) {
  const dir = path.join(projectRoot, '.pipeline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stagesJsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return stagesJsonPath;
}

// ── 工具函数 ──────────────────────────────────────────────────────
function sha256str(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function safeGet(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// ── datetime 推导（与日志文件名一致）──────────────────────────────
function deriveDatetime(stagesJson) {
  if (args.datetime && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(args.datetime)) {
    return args.datetime;
  }
  const runStartedAt = safeGet(stagesJson, 'pipeline', 'run_started_at') || '';
  if (runStartedAt) {
    const match = runStartedAt.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}_${match[4]}-${match[5]}-${match[6]}`;
    }
  }
  return log.datetime;
}

// ── overall 推导 ──────────────────────────────────────────────────
/**
 * 按规范优先级推导 overall 状态：
 *   1. stopped  → pipeline.stop_info 存在 或 任一核心 stage status=stopped
 *   2. blocked  → merge_push conflict_features[] 非空 / deploy decision=blocked / 任一 stage exit_code=9 / deploy.outputs.blocked_reason 非空
 *   3. failed   → --failure-reason 非空 / 任一关键 stage failed / 任一核心 stage completed 但 validation.passed=false
 *   4. partial  → ui_e2e 未完成 / 有非关键 stage failed / 不符合 success 条件
 *   5. success  → 全部核心 stage ∈ {completed, skipped} 且无失败
 *   6. partial  → 其余
 */
function computeOverall(stages, pipeline, configDev) {
  // 1. stopped
  if (pipeline && pipeline.stop_info) return 'stopped';
  for (const sk of CORE_STAGES) {
    if (safeGet(stages, sk, 'status') === 'stopped') return 'stopped';
  }

  // 2. blocked
  const conflictFeatures = safeGet(stages, 'merge_push', 'outputs', 'conflict_features') || [];
  if (Array.isArray(conflictFeatures) && conflictFeatures.length > 0) return 'blocked';

  const deployDecision = safeGet(stages, 'deploy', 'outputs', 'decision');
  if (deployDecision === 'blocked') return 'blocked';

  const deployBlockedReason = safeGet(stages, 'deploy', 'outputs', 'blocked_reason');
  if (deployBlockedReason) return 'blocked';

  // 检查任一核心 stage exit_code=9
  for (const sk of CORE_STAGES) {
    if (safeGet(stages, sk, 'outputs', 'exit_code') === 9) return 'blocked';
    if (safeGet(stages, sk, 'exit_code') === 9) return 'blocked';
  }

  // 3. failed
  if (failureReason) return 'failed';

  for (const sk of CRITICAL_STAGES) {
    if (safeGet(stages, sk, 'status') === 'failed') return 'failed';
  }
  // 任一核心 stage completed 但 validation.passed=false
  for (const sk of CORE_STAGES) {
    if (
      safeGet(stages, sk, 'status') === 'completed' &&
      safeGet(stages, sk, 'validation', 'passed') === false
    ) return 'failed';
  }

  // 4. partial — ui_e2e 未完成
  const ui_e2e_enabled = safeGet(configDev, 'ui_e2e', 'enabled');
  const ui_e2e_status  = safeGet(stages, 'ui_e2e', 'status');
  if (
    ui_e2e_enabled === true &&
    ui_e2e_status !== undefined &&
    !['completed', 'skipped', 'failed'].includes(ui_e2e_status)
  ) return 'partial';

  // 任一非关键 stage failed → partial
  for (const sk of CORE_STAGES) {
    if (!CRITICAL_STAGES.includes(sk) && safeGet(stages, sk, 'status') === 'failed') {
      return 'partial';
    }
  }

  // 5. success
  const allOk = CORE_STAGES.every(sk => {
    const st = safeGet(stages, sk, 'status');
    return st === undefined || st === null || ['completed', 'skipped'].includes(st);
  });
  if (allOk) return 'success';

  // 6. partial（兜底）
  return 'partial';
}

// ── 错误日志摘录 ──────────────────────────────────────────────────
const ERROR_EVENTS = new Set([
  'stage_failed', 'agent_failed', 'agent_timeout', 'agent_stall_detected',
  'validation_fail', 'build_target_failed', 'git_push_failed',
  'http_smoke_failed', 'ui_scenario_failed', 'pipeline_stop', 'pipeline_stopped',
]);

const MAX_EXCERPT_BYTES = 256 * 1024; // 256 KiB
const MAX_LINE_CHARS    = 500;

/**
 * 从日志行判断是否需要纳入摘录
 * 格式：[时间] [LEVEL] [stage] event | msg | {JSON}
 */
function shouldIncludeLine(line) {
  const m = line.match(/^\[.*?\]\s+\[(ERROR|WARN)\]\s+/);
  if (m) return true;
  // 检查 event 字段
  const parts = line.split(' | ');
  if (parts.length >= 1) {
    const prefix = parts[0];
    const eventMatch = prefix.match(/\]\s+([\w_]+)\s*$/);
    if (eventMatch && ERROR_EVENTS.has(eventMatch[1])) return true;
  }
  return false;
}

/**
 * 遍历日志目录，收集错误/警告行，写入摘录文件
 * @returns {string} excerpt 文件路径（若无内容则为 null）
 */
function extractErrorLogs(datetime) {
  const logsRoot     = path.join(projectRoot, 'logs');
  const excerptPath  = path.join(projectRoot, '.pipeline', 'reports', `.report-error-excerpt-${datetime}.txt`);
  ensureDir(excerptPath);

  const lines = [];

  function scanLogFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const raw of content.split('\n')) {
        const line = raw.slice(0, MAX_LINE_CHARS);
        if (line && shouldIncludeLine(line)) {
          lines.push(line);
        }
      }
    } catch (_) { /* 忽略单个文件读取错误 */ }
  }

  // 全局日志
  const globalLog = path.join(logsRoot, `${datetime}.log`);
  scanLogFile(globalLog);

  // stage 日志
  const stagesLogDir = path.join(logsRoot, 'stages');
  if (fs.existsSync(stagesLogDir)) {
    try {
      for (const stageName of fs.readdirSync(stagesLogDir)) {
        const stageDir = path.join(stagesLogDir, stageName);
        if (fs.statSync(stageDir).isDirectory()) {
          for (const fname of fs.readdirSync(stageDir)) {
            if (fname.endsWith('.log')) {
              scanLogFile(path.join(stageDir, fname));
            }
          }
        }
      }
    } catch (_) { /* 忽略目录枚举错误 */ }
  }

  // feature 日志
  const featuresLogDir = path.join(logsRoot, 'features');
  if (fs.existsSync(featuresLogDir)) {
    try {
      for (const featureId of fs.readdirSync(featuresLogDir)) {
        const featureDir = path.join(featuresLogDir, featureId);
        if (fs.statSync(featureDir).isDirectory()) {
          for (const fname of fs.readdirSync(featureDir)) {
            if (fname.endsWith('.log')) {
              scanLogFile(path.join(featureDir, fname));
            }
          }
        }
      }
    } catch (_) { /* 忽略 */ }
  }

  if (lines.length === 0) return null;

  // 去重
  const uniqueLines = [...new Set(lines)];

  // 体积上限：按时间倒序保留最新行
  let content = uniqueLines.join('\n') + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_EXCERPT_BYTES) {
    const reversed = [...uniqueLines].reverse();
    const kept = [];
    let size = 0;
    for (const l of reversed) {
      const lineBytes = Buffer.byteLength(l + '\n', 'utf8');
      if (size + lineBytes > MAX_EXCERPT_BYTES - 200) break;
      kept.push(l);
      size += lineBytes;
    }
    const header = `truncated: true\n（以下仅保留最新 ${kept.length} / ${uniqueLines.length} 条错误行）\n\n`;
    content = header + kept.reverse().join('\n') + '\n';
  }

  try {
    fs.writeFileSync(excerptPath, content, 'utf8');
    return excerptPath;
  } catch (_) {
    return null;
  }
}

// ── 聚合 collect JSON ────────────────────────────────────────────
function buildCollect(stagesData, overall, features, summary, datetime) {
  const stages   = stagesData.stages || {};
  const pipeline = stagesData.pipeline || {};

  const stagesSnapshot = CORE_STAGES.map(sk => ({
    stage:      sk,
    status:     safeGet(stages, sk, 'status') || 'pending',
    duration_ms: (() => {
      const started   = safeGet(stages, sk, 'started_at');
      const completed = safeGet(stages, sk, 'completed_at');
      if (started && completed) {
        const ms = new Date(completed) - new Date(started);
        return isNaN(ms) ? null : ms;
      }
      return null;
    })(),
    validation_summary: safeGet(stages, sk, 'validation', 'summary') || null,
  }));

  const failedTasks = CORE_STAGES
    .filter(sk => safeGet(stages, sk, 'status') === 'failed')
    .map(sk => ({
      stage:    sk,
      reason:   safeGet(stages, sk, 'outputs', 'error') || safeGet(stages, sk, 'validation', 'summary') || '未知原因',
      log_hint: `logs/stages/${sk}/`,
    }));

  const featureMatrix = features.map(f => ({
    feature_id:  f.feature_id,
    name:        f.name || f.feature_id,
    design:      safeGet(stages, 'design', 'features', f.feature_id, 'status') || '—',
    design_review: safeGet(stages, 'design_review', 'features', f.feature_id, 'status') || '—',
    codegen:     safeGet(stages, 'codegen', 'features', f.feature_id, 'status') || '—',
    code_review: safeGet(stages, 'code_review', 'features', f.feature_id, 'status') || '—',
    ui_e2e:      safeGet(stages, 'ui_e2e', 'features', f.feature_id, 'status') || '—',
  }));

  return {
    overall,
    run: {
      session_id:  sessionId,
      datetime,
      started_at:  safeGet(pipeline, 'run_started_at') || null,
      from_stage:  fromStage,
    },
    project: {
      name:         safeGet(pipeline, 'project', 'name') || path.basename(projectRoot),
      root_path:    projectRoot,
      final_commit: safeGet(stages, 'merge_push', 'outputs', 'final_commit') || null,
    },
    stages:          stagesSnapshot,
    failed_tasks:    failedTasks,
    feature_matrix:  featureMatrix,
    summary,
  };
}

// ── Agent 调用（report-author）─────────────────────────────────────
async function invokeReportAgent(collectJsonPath, excerptPath, datetime) {
  const promptPath   = path.join(skillsRoot, 'ai-std3', 'prompts', 'report-author.md');
  const agentOutPath = path.join(projectRoot, '.pipeline', 'reports', `.report-agent-${datetime}.md`);
  const agentId      = `report-author-${sessionId}`;
  const timeoutMs    = 300_000; // 300s

  if (!fs.existsSync(promptPath)) {
    log.warn('agent_skipped', 'report-author.md prompt 文件不存在，跳过 Agent', {
      reason:      'prompt_not_found',
      prompt_path: promptPath,
    });
    return { skipped: true, agentOutPath: null };
  }

  let promptContent = fs.readFileSync(promptPath, 'utf8');
  // 注入上下文
  promptContent += `\n\n<!-- inject: collect_json=${collectJsonPath} -->`;
  promptContent += `\n<!-- inject: error_excerpt=${excerptPath || '(无错误摘录)'} -->`;
  if (failureReason) {
    promptContent += `\n<!-- inject: failure_reason=${failureReason} -->`;
  }
  promptContent += `\n<!-- inject: output_path=${agentOutPath} -->`;

  const inputFiles = [collectJsonPath];
  if (excerptPath && fs.existsSync(excerptPath)) inputFiles.push(excerptPath);

  log.info('agent_start', `启动 report-author Agent: ${agentId}`, {
    agent_id:      agentId,
    prompt:        'report-author.md',
    input_files:   inputFiles,
    excerpt_bytes: excerptPath && fs.existsSync(excerptPath)
      ? fs.statSync(excerptPath).size
      : 0,
  });

  try {
    const { Agent } = require('@cursor/sdk');
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      log.warn('agent_skipped', 'CURSOR_API_KEY 未设置，跳过 Agent', {
        reason: 'no_api_key',
      });
      return { skipped: true, agentOutPath: null };
    }

    // 设置环境变量供 Agent 读取
    process.env.AI_STD3_REPORT_AGENT_OUTPUT = agentOutPath;
    process.env.AI_STD3_PROJECT             = projectRoot;
    process.env.AI_STD3_SESSION_ID          = sessionId;

    const agentOptions = {
      apiKey,
      model: { id: 'composer-2' },
      local: { cwd: projectRoot },
    };

    const runPromise = (async () => {
      const agent = Agent.create(agentOptions);
      try {
        const run = await agent.send(promptContent);
        if (run.supports && run.supports('stream')) {
          for await (const event of run.stream()) {
            if (event.type === 'assistant') {
              for (const block of ((event.message && event.message.content) || [])) {
                if (block.type === 'text') process.stdout.write(block.text);
              }
            }
          }
        }
        const result = await run.wait();
        return { success: result.status === 'finished', error: result.status !== 'finished' ? result.status : null };
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
      log.warn('agent_skipped', 'report-author Agent 超时，降级为模板', {
        reason:      'report_agent_timeout',
        timeout_ms:  timeoutMs,
      });
      return { skipped: true, agentOutPath: null };
    }

    if (!outcome.success) {
      log.warn('agent_skipped', `report-author Agent 失败: ${outcome.error}，降级为模板`, {
        reason: outcome.error || 'agent_failed',
      });
      return { skipped: true, agentOutPath: null };
    }

    log.info('agent_complete', 'report-author Agent 完成', {
      agent_id:     agentId,
      output_files: [agentOutPath],
    });

    return { skipped: false, agentOutPath: fs.existsSync(agentOutPath) ? agentOutPath : null };

  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log.warn('agent_skipped', `report-author Agent 调用异常: ${msg}，降级为模板`, {
      reason: msg,
    });
    return { skipped: true, agentOutPath: null };
  }
}

// ── 读取 Agent 产出（失败与原因、建议下一步）──────────────────────
function parseAgentOutput(agentOutPath) {
  if (!agentOutPath || !fs.existsSync(agentOutPath)) return null;
  try {
    return fs.readFileSync(agentOutPath, 'utf8');
  } catch (_) { return null; }
}

// ── 渲染 pipeline-report.md ───────────────────────────────────────
function renderReport(opts) {
  const {
    stagesData, overall, collect, features, summary,
    agentContent, subReports, datetime,
  } = opts;

  const stages   = stagesData.stages || {};
  const pipeline = stagesData.pipeline || {};
  const now      = formatLocalTimeShort();

  const projectName    = safeGet(pipeline, 'project', 'name') || path.basename(projectRoot);
  const finalCommit    = safeGet(stages, 'merge_push', 'outputs', 'final_commit') || '（未合并）';
  const gitRemote      = safeGet(pipeline, 'project', 'git_remote') || '（未知）';
  const deployServices = safeGet(stages, 'deploy', 'outputs', 'services') || [];
  const ui_e2e_passed  = safeGet(stages, 'ui_e2e', 'outputs', 'passed_scenarios') || 0;
  const ui_e2e_total   = safeGet(stages, 'ui_e2e', 'outputs', 'total_scenarios')  || 0;
  const ui_e2e_failed  = safeGet(stages, 'ui_e2e', 'outputs', 'failed_scenarios') || 0;
  const ui_e2e_blocked = safeGet(stages, 'ui_e2e', 'outputs', 'blocked_features') || [];

  // overall 人话
  const overallLabel = {
    success: '全部成功',
    partial: '部分完成',
    failed:  '失败',
    blocked: '阻断（需人工处理）',
    stopped: '已停止',
  }[overall] || overall;

  const overallMainCause = failureReason
    ? `主因：${failureReason}`
    : overall === 'success'
      ? '所有关键阶段均通过'
      : (() => {
          const failedStages = CORE_STAGES.filter(sk => safeGet(stages, sk, 'status') === 'failed');
          if (failedStages.length > 0) return `失败阶段：${failedStages.join('、')}`;
          const stopInfo = safeGet(pipeline, 'stop_info');
          if (stopInfo) return `停止于阶段 ${stopInfo.stopped_stage || '未知'}，原因：${stopInfo.reason || '用户请求'}`;
          return '';
        })();

  // 阶段状态表
  const STAGE_LABEL = {
    setup:               'setup（初始化）',
    prd:                 'prd（需求文档）',
    prd_review:          'prd-review（需求评审）',
    design:              'design（设计）',
    design_review:       'design-review（设计评审）',
    create_ui_scenarios: 'create-ui-scenarios（UI 场景）',
    codegen:             'codegen（代码生成）',
    code_review:         'code-review（代码评审）',
    merge_push:          'merge_push（合并推送）',
    build:               'build（构建）',
    deploy:              'deploy（部署）',
    ui_e2e:              'ui_e2e（UI 端到端）',
  };

  const STATUS_LABEL = {
    completed:           '已完成',
    failed:              '失败',
    skipped:             '已跳过',
    stopped:             '已停止',
    running:             '运行中',
    started:             '已启动',
    pending_user_input:  '等待用户输入',
    pending:             '待执行',
  };

  function fmtDuration(ms) {
    if (!ms) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
  }

  function stageDurationMs(sk) {
    const started   = safeGet(stages, sk, 'started_at');
    const completed = safeGet(stages, sk, 'completed_at');
    if (started && completed) {
      const ms = new Date(completed) - new Date(started);
      return isNaN(ms) ? null : ms;
    }
    return null;
  }

  const stageRows = CORE_STAGES.map(sk => {
    const status   = safeGet(stages, sk, 'status') || 'pending';
    const durMs    = stageDurationMs(sk);
    const label    = STATUS_LABEL[status] || status;
    const summary_ = safeGet(stages, sk, 'validation', 'summary') || '';
    return `| ${STAGE_LABEL[sk] || sk} | ${label} | ${fmtDuration(durMs)} | ${summary_} |`;
  }).join('\n');

  // feature 状态映射
  const STATUS_ICON = { completed: '✓', failed: '✗', skipped: '↷', stopped: '◈', running: '⟳', pending: '○' };
  function icon(v) { return STATUS_ICON[v] || (v === '—' ? '—' : '?'); }

  const featureRows = features.length > 0
    ? features.map(f => {
        const fid = f.feature_id;
        const d   = safeGet(stages, 'design',        'features', fid, 'status') || '—';
        const dr  = safeGet(stages, 'design_review',  'features', fid, 'status') || '—';
        const cg  = safeGet(stages, 'codegen',        'features', fid, 'status') || '—';
        const cr  = safeGet(stages, 'code_review',    'features', fid, 'status') || '—';
        const sc  = safeGet(stages, 'create_ui_scenarios', 'features', fid, 'status') || '—';
        const e2e = safeGet(stages, 'ui_e2e',         'features', fid, 'status') || '—';
        return `| ${f.feature_id} | ${f.name || f.feature_id} | ${icon(d)} | ${icon(dr)} | ${icon(cg)} | ${icon(cr)} | ${icon(sc)} | ${icon(e2e)} |`;
      }).join('\n')
    : '| — | — | — | — | — | — | — | — |';

  // 完成事项 bullets
  const completedBullets = [];
  if (safeGet(stages, 'prd_review', 'outputs', 'decision') === 'passed') {
    completedBullets.push('PRD 评审通过');
  }
  if (safeGet(stages, 'codegen', 'status') === 'completed') {
    const ok = features.filter(f => safeGet(stages, 'codegen', 'features', f.feature_id, 'status') === 'completed').length;
    completedBullets.push(`代码生成完成（${ok}/${features.length} 个 feature）`);
  }
  if (safeGet(stages, 'merge_push', 'status') === 'completed') {
    completedBullets.push(`已合并至主干，提交 \`${finalCommit}\``);
  }
  if (safeGet(stages, 'build', 'status') === 'completed') {
    completedBullets.push('构建成功');
  }
  if (Array.isArray(deployServices) && deployServices.length > 0) {
    for (const svc of deployServices) {
      if (svc.url) completedBullets.push(`${svc.name || svc.target} 已部署：${svc.url}`);
    }
  }
  if (ui_e2e_total > 0) {
    completedBullets.push(`UI 场景 ${ui_e2e_passed}/${ui_e2e_total} 通过`);
  }

  const completedSection = completedBullets.length > 0
    ? completedBullets.map(b => `- ${b}`).join('\n')
    : '- （本次无已完成的关键事项）';

  // 未完成事项 bullets
  const failedBullets = CORE_STAGES
    .filter(sk => safeGet(stages, sk, 'status') === 'failed')
    .map(sk => {
      const reason = safeGet(stages, sk, 'outputs', 'error')
        || safeGet(stages, sk, 'validation', 'summary')
        || '详见日志';
      return `- 【${sk}】失败：${reason}（日志：\`logs/stages/${sk}/\`）`;
    });

  const stoppedInfo = safeGet(pipeline, 'stop_info');
  if (stoppedInfo) {
    failedBullets.push(`- 流水线停止于阶段 \`${stoppedInfo.stopped_stage || '未知'}\`，原因：${stoppedInfo.reason || '用户请求'}（时间：${stoppedInfo.stopped_at || '未知'}）`);
  }
  if (failureReason) {
    failedBullets.push(`- 编排器捕获失败：${failureReason}`);
  }

  // 如有 Agent 产出，将 "失败与原因" 和 "建议的下一步" 从 agentContent 中提取并嵌入对应章节
  let agentFailureSection = '';
  let agentNextStepsSection = '';
  if (agentContent) {
    const failureMatch  = agentContent.match(/##\s*失败与原因[\s\S]*?(?=##|$)/);
    const nextStepMatch = agentContent.match(/##\s*建议的下一步[\s\S]*?(?=##|$)/);
    if (failureMatch) {
      agentFailureSection = '\n\n' + failureMatch[0].trim();
    }
    if (nextStepMatch) {
      agentNextStepsSection = nextStepMatch[0].replace(/^##\s*建议的下一步/, '').trim();
    }
  }

  const failedSection = failedBullets.length > 0
    ? failedBullets.join('\n') + agentFailureSection
    : overall === 'success'
      ? '- 无阻塞项'
      : '- （无额外失败信息）' + agentFailureSection;

  // 建议的下一步
  let nextSteps = '';
  if (agentNextStepsSection) {
    nextSteps = agentNextStepsSection;
  } else {
    const tips = [];
    if (overall === 'success') {
      tips.push('1. 访问上方部署地址验证功能');
      tips.push('2. 查阅 `.pipeline/reports/` 下各子报告了解详情');
    } else {
      const failedSks = CORE_STAGES.filter(sk => safeGet(stages, sk, 'status') === 'failed');
      if (failedSks.length > 0) {
        failedSks.forEach((sk, i) => {
          tips.push(`${i + 1}. 修复 ${sk} 后重跑：\`node ai-std3/scripts/run-pipeline.cjs --project=${projectRoot} --from-stage=${sk.replace(/_/g, '-')}\``);
        });
      } else if (stoppedInfo) {
        tips.push(`1. 续跑：\`node ai-std3/scripts/run-pipeline.cjs --project=${projectRoot} --from-stage=${(stoppedInfo.stopped_stage || 'setup').replace(/_/g, '-')}\``);
      } else {
        tips.push('1. 查阅 `.pipeline/reports/` 下各子报告了解详情，再决定是否续跑');
      }
    }
    nextSteps = tips.join('\n');
  }

  // 部署与构建
  const deploySection = deployServices.length > 0
    ? deployServices.map(s => `- **${s.name || s.target}**：${s.url || '（URL 未知）'}`).join('\n')
    : '（本次未涉及）';

  const buildArtifacts = safeGet(stages, 'build', 'outputs', 'artifacts') || [];
  const buildSection   = Array.isArray(buildArtifacts) && buildArtifacts.length > 0
    ? buildArtifacts.map(a => `- ${a.name || a.target}：\`${a.path || '—'}\``).join('\n')
    : '（本次未涉及）';

  // UI E2E
  const snapshotDir   = path.join(projectRoot, '.pipeline', 'logs', 'snapshots');
  const ui_e2eSection = ui_e2e_total > 0
    ? [
        `- 通过 ${ui_e2e_passed} / ${ui_e2e_total} 个场景`,
        ui_e2e_failed > 0  ? `- 失败场景数：${ui_e2e_failed}` : '',
        ui_e2e_blocked.length > 0 ? `- 阻断 feature：${ui_e2e_blocked.join('、')}` : '',
        fs.existsSync(snapshotDir) ? `- 截图目录：\`.pipeline/logs/snapshots/\`` : '',
      ].filter(Boolean).join('\n')
    : '（本次未涉及）';

  // 子报告与日志
  const subReportRows = subReports
    .filter(r => r.exists)
    .map(r => `| ${r.stage} | \`${path.relative(projectRoot, r.path)}\` |`)
    .join('\n') || '（无）';

  const fromStageNote = fromStage ? `\n> **续跑模式**：本次自 \`${fromStage}\` 阶段接上。` : '';

  const md = `# 流水线执行报告 — ${projectName}

> 生成于 ${now} · 会话 ${sessionId} · 执行批次 ${datetime}
${fromStageNote}

## 一句话结论

**${overallLabel}**${overallMainCause ? `：${overallMainCause}` : ''}

## 这次跑了什么

- **项目路径**：\`${projectRoot}\`
- **Git 远程**：${gitRemote}
- **最终提交**：${finalCommit}
- **Feature 数**：${features.length} 个${fromStage ? `（续跑自 ${fromStage}）` : ''}
- **覆盖端**：${(safeGet(stagesData, 'stages', 'prd', 'outputs', 'client_targets') || []).join('、') || '（未知）'}

## 各阶段完成情况

| 阶段 | 状态 | 耗时 | 说明 |
| --- | --- | --- | --- |
${stageRows}

## 已完成的事项

${completedSection}

## 未完成或出错的事项

${failedSection}

## 功能（Feature）一览

| Feature ID | 功能名 | 设计 | 设计评审 | 代码 | 代码评审 | UI 场景 | UI 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${featureRows}

## 部署与访问地址

${deploySection}

## 构建产物

${buildSection}

## UI 端到端（若启用）

${ui_e2eSection}

## 相关日志与详细报告

| 类型 | 路径 |
| --- | --- |
| 全局日志 | \`logs/${datetime}.log\` |
${subReportRows}

## 建议的下一步

${nextSteps}
`;

  return md;
}

// ── 获取 feature 列表 ────────────────────────────────────────────
function getFeatures(stagesData) {
  return (safeGet(stagesData, 'stages', 'prd', 'outputs', 'features') || []);
}

// ── 计算 summary ─────────────────────────────────────────────────
function computeSummary(stagesData, features) {
  const stages = stagesData.stages || {};

  const total_features     = features.length;
  const completed_features = features.filter(f =>
    safeGet(stages, 'codegen', 'features', f.feature_id, 'status') === 'completed'
  ).length;
  const failed_features    = features.filter(f =>
    safeGet(stages, 'codegen', 'features', f.feature_id, 'status') === 'failed'
  ).length;
  const skipped_features   = features.filter(f => {
    const st = safeGet(stages, 'codegen', 'features', f.feature_id, 'status');
    return st === 'skipped' || (st === undefined && safeGet(stages, 'design_review', 'features', f.feature_id, 'can_enter_codegen') === false);
  }).length;

  const total_scenarios  = safeGet(stages, 'ui_e2e', 'outputs', 'total_scenarios')  || 0;
  const passed_scenarios = safeGet(stages, 'ui_e2e', 'outputs', 'passed_scenarios') || 0;
  const failed_scenarios = safeGet(stages, 'ui_e2e', 'outputs', 'failed_scenarios') || 0;

  return {
    total_features,
    completed_features,
    failed_features,
    skipped_features,
    total_scenarios,
    passed_scenarios,
    failed_scenarios,
  };
}

// ── 子报告路径 ────────────────────────────────────────────────────
function getSubReports() {
  const reportsDir = path.join(projectRoot, '.pipeline', 'reports');
  return [
    { stage: 'prd-review',          path: path.join(reportsDir, 'prd-implementation-summary.md') },
    { stage: 'design-review',       path: path.join(reportsDir, 'design-review-summary.md') },
    { stage: 'codegen',             path: path.join(reportsDir, 'codegen-summary.md') },
    { stage: 'code-review',         path: path.join(reportsDir, 'code-review-summary.md') },
    { stage: 'create-ui-scenarios', path: path.join(reportsDir, 'create-ui-scenarios-summary.md') },
    { stage: 'build',               path: path.join(reportsDir, 'build-summary.md') },
    { stage: 'deploy',              path: path.join(reportsDir, 'deploy-summary.md') },
  ].map(r => ({ ...r, exists: fs.existsSync(r.path) }));
}

// ── 主函数 ────────────────────────────────────────────────────────
async function main() {
  const startedAt  = new Date();
  const startedStr = formatLocalTimeShort(startedAt);

  // 0. 检测 stop.signal
  const stopSignalPath = path.join(projectRoot, '.pipeline', 'stop.signal');
  if (fs.existsSync(stopSignalPath)) {
    log.info('pipeline_stop', '检测到 stop.signal，report stage 退出', {
      stage:       'report',
      reason:      (() => {
        try { return JSON.parse(fs.readFileSync(stopSignalPath, 'utf8')).reason; } catch (_) { return 'unknown'; }
      })(),
      stopped_at:  formatLocalTimeShort(),
    });
    process.exit(5);
  }

  // 1. 读取 stages.json
  let stagesData = readStagesJson();
  if (!stagesData) {
    process.stderr.write(`[report] 致命：stages.json 不存在：${stagesJsonPath}\n`);
    process.exit(1);
  }

  // 确保 stages / pipeline 节存在
  stagesData.stages   = stagesData.stages   || {};
  stagesData.pipeline = stagesData.pipeline || {};

  const datetime = deriveDatetime(stagesData);

  // 计算 stages.json 快照 hash（用于 inputs 字段）
  const snapshotHash = sha256str(JSON.stringify(stagesData));

  // log stage_start
  log.info('stage_start', 'report stage 启动', {
    run_id:     runId,
    stage:      'report',
    project:    projectRoot,
    session_id: sessionId,
    started_at: startedStr,
    has_stop_signal: false,
  });

  // 2. 写入 status=running
  stagesData.stages.report = Object.assign(stagesData.stages.report || {}, {
    status:     'running',
    started_at: startedStr,
  });
  try { writeStagesJson(stagesData); } catch (_) { /* 非致命 */ }

  // 3. 计算 overall
  const configDev = (() => {
    try {
      const p = path.join(projectRoot, 'docs', 'config.dev.json');
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    } catch (_) { return {}; }
  })();

  const features  = getFeatures(stagesData);
  const summary   = computeSummary(stagesData, features);
  const overall   = computeOverall(stagesData.stages, stagesData.pipeline, configDev);

  // has_errors：overall != success 时有失败/阻塞需要分析
  const has_errors = overall !== 'success';

  // 4. 错误日志摘录
  const reportsDir = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  let excerptPath = null;
  if (has_errors) {
    excerptPath = extractErrorLogs(datetime);
    if (excerptPath) {
      log.info('file_created', '错误日志摘录已写入', {
        path:       excerptPath,
        size_bytes: fs.statSync(excerptPath).size,
      });
    }
  }

  // 5. 写 collect JSON
  const subReports = getSubReports();
  const collect    = buildCollect(stagesData, overall, features, summary, datetime);
  const collectJsonPath = path.join(reportsDir, `.report-collect-${datetime}.json`);
  try {
    fs.writeFileSync(collectJsonPath, JSON.stringify(collect, null, 2) + '\n', 'utf8');
    log.info('file_created', '聚合摘要 JSON 已写入', {
      path:       collectJsonPath,
      size_bytes: fs.statSync(collectJsonPath).size,
    });
  } catch (e) {
    log.warn('file_created', `聚合摘要 JSON 写入失败: ${e.message}`, { path: collectJsonPath });
  }

  // 6. Agent（仅 has_errors 且非 skip_agent 且非 stop.signal）
  let agentContent    = null;
  let agentOutputPath = null;

  // stop.signal 存在时不启动新 Agent
  const stopSignalNow = fs.existsSync(stopSignalPath);

  if (has_errors && !skipAgent && !stopSignalNow) {
    const agentResult = await invokeReportAgent(collectJsonPath, excerptPath, datetime);
    agentOutputPath   = agentResult.agentOutPath;
    agentContent      = parseAgentOutput(agentOutputPath);
  } else {
    const skipReason = !has_errors
      ? 'no_errors'
      : skipAgent
        ? 'skip_agent'
        : 'stop_signal_active';
    log.info('agent_skipped', 'report-author Agent 已跳过', { reason: skipReason });
  }

  // 7. 渲染报告
  const reportMd = renderReport({
    stagesData,
    overall,
    collect,
    features,
    summary,
    agentContent,
    subReports,
    datetime,
  });

  const reportPath = path.join(reportsDir, 'pipeline-report.md');
  try {
    fs.writeFileSync(reportPath, reportMd, 'utf8');
    log.info('file_created', '流水线报告已生成', {
      path:       reportPath,
      overall,
      size_bytes: Buffer.byteLength(reportMd, 'utf8'),
    });
  } catch (e) {
    process.stderr.write(`[report] 写入报告失败: ${e.message}\n`);
    process.exit(1);
  }

  // 8. 更新 stages.report 与 pipeline.pipeline_complete_at
  const completedAt  = new Date();
  const completedStr = formatLocalTimeShort(completedAt);
  const duration_ms  = completedAt - startedAt;

  const failedStages = CORE_STAGES.filter(sk =>
    safeGet(stagesData, 'stages', sk, 'status') === 'failed'
  );

  stagesData.stages.report = {
    status:       'completed',
    started_at:   startedStr,
    completed_at: completedStr,
    inputs: {
      stages_snapshot_hash: snapshotHash,
    },
    outputs: {
      overall,
      report_path:      reportPath,
      summary,
      failed_stages:    failedStages,
      duration_ms,
      timed_out:        false,
      timeout_reason:   null,
      ...(agentOutputPath ? { agent_report_path: agentOutputPath } : {}),
      ...(excerptPath     ? { error_excerpt_path: excerptPath }   : {}),
    },
    validation: {
      passed:                true,
      checked_at:            completedStr,
      summary:               null,
      required_files:        [],
      missing_required_fields: [],
      warnings:              [],
    },
    generated_files: [reportPath],
    blocking_issues: [],
    git_sync: {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  };

  stagesData.pipeline.pipeline_complete_at = completedStr;
  stagesData.pipeline.current_stage        = 'report';
  stagesData.pipeline.updated_at           = completedStr;

  try {
    writeStagesJson(stagesData);
  } catch (e) {
    process.stderr.write(`[report] 写入 stages.json 失败: ${e.message}\n`);
    process.exit(1);
  }

  // stage_complete 日志
  log.info('stage_complete', 'report stage 完成', {
    overall,
    duration_ms,
    failed_tasks_count: failedStages.length,
  });

  // stdout（CI / 看板）
  process.stdout.write(`[report] overall=${overall} path=${reportPath}\n`);
  process.stdout.write(`[report] pipeline_complete=true\n`);

  process.exit(0);
}

main().catch(err => {
  const msg = err && err.message ? err.message : String(err);
  process.stderr.write(`[report] 未捕获异常: ${msg}\n`);
  if (err && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});

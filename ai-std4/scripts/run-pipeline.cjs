'use strict';

/**
 * run-pipeline.cjs — ai-std4 流水线主调度入口
 *
 * 调用形态：
 *   node ai-std4/scripts/run-pipeline.cjs \
 *     --project=<路径>            # 业务项目根（必须；或 AI_STD4_PROJECT 环境变量；或 cwd）
 *     [--from-stage=<stage>]      # 续跑起点（含），同时清除残留 stop.signal
 *     [--to-stage=<stage>]        # 续跑终点（含）
 *     [--force-rerun=<stage>]     # 强制重跑单 stage（跳过 hash 门控）
 *     [--run-id=<id>]             # 指定 run_id（缺失时自动生成）
 *     [--no-dash]                 # 禁止自动启动看板
 *     [--no-teardown]             # report 后不执行 pipeline-teardown
 *
 * 退出码：
 *   0  success / partial
 *   1  report 未生成或配置错误
 *   4  failed
 *   5  stopped（stop.signal 触发）
 *   9  blocked
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const { createLogger, formatLocalTimeShort } = require('./libs/logger.cjs');
const { loadProjectEnv, getSkillsRoot } = require('./libs/pipeline-config.cjs');

/** 每次 recovery 前加载最新 pipeline-recovery（Agent 可能在上一轮修改了该文件） */
function loadPipelineRecovery() {
  const recoveryPath = path.join(__dirname, 'libs', 'pipeline-recovery.cjs');
  try {
    const resolved = require.resolve(recoveryPath);
    delete require.cache[resolved];
  } catch (_) { /* first load */ }
  return require(recoveryPath);
}

// ── 参数解析 ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    })
);

// 项目路径（优先级：--project > AI_STD4_PROJECT > cwd）
const projectRoot = args.project
  ? path.resolve(String(args.project))
  : process.env.AI_STD4_PROJECT
    ? path.resolve(process.env.AI_STD4_PROJECT)
    : process.cwd();

const fromStage  = args['from-stage']  ? String(args['from-stage'])  : null;
const toStage    = args['to-stage']    ? String(args['to-stage'])    : null;
const forceRerun = args['force-rerun'] ? String(args['force-rerun']) : null;
const noDash     = args['no-dash']     === true || args['no-dash']     === 'true';
const noTeardown = args['no-teardown'] === true || args['no-teardown'] === 'true';

// ── run_id 生成 ───────────────────────────────────────────────────
function generateRunId() {
  const now = new Date();
  const p   = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_` +
         `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}-` +
         crypto.randomBytes(4).toString('hex');
}
const runId = args['run-id'] ? String(args['run-id']) : generateRunId();

// ── 路径常量 ──────────────────────────────────────────────────────
const SCRIPTS_DIR    = __dirname;                               // ai-std4/scripts/
const STAGES_DIR     = path.join(SCRIPTS_DIR, 'stages');        // ai-std4/scripts/stages/
const pipelineDir    = path.join(projectRoot, '.pipeline');
const stopSignalPath = path.join(pipelineDir, 'stop.signal');
const stagesJsonPath = path.join(pipelineDir, 'stages.json');

// ── stage → 脚本文件名映射 ────────────────────────────────────────
const stageScripts = {
  setup:                 'setup.cjs',
  prd:                   'prd.cjs',
  'prd-review':          'prd-review.cjs',
  design:                'design.cjs',
  'design-review':       'design-review.cjs',
  'create-ui-scenarios': 'create-ui-scenarios.cjs',
  codegen:               'codegen.cjs',
  'code-review':         'code-review.cjs',
  merge_push:            'merge-push.cjs',
  build:                 'build.cjs',
  deploy:                'deploy.cjs',
  ui_e2e:                'ui-e2e.cjs',
  report:                'report.cjs',
};

// 扁平 stage 顺序（仅用于 from/to stage 索引比较）
const STAGE_ORDER = [
  'setup', 'prd', 'prd-review',
  'design', 'design-review',
  'create-ui-scenarios', 'codegen',
  'code-review', 'merge_push', 'build', 'deploy', 'ui_e2e', 'report',
];

// 执行管道步骤（含复合阶段 design_phase / build_phase）
// design_phase ≡ design + design-review
// build_phase  ≡ create-ui-scenarios + codegen
const PIPELINE_STEPS = [
  'setup', 'prd', 'prd-review',
  'design_phase',
  'build_phase',
  'code-review', 'merge_push', 'build', 'deploy', 'ui_e2e', 'report',
];

// ── Logger（需先确保目录存在）────────────────────────────────────
fs.mkdirSync(pipelineDir, { recursive: true });
const log = createLogger({ projectRoot, stage: 'pipeline', runId });

// ── from / to stage 过滤工具 ─────────────────────────────────────
function stageIdx(name) {
  const i = STAGE_ORDER.indexOf(name);
  return i === -1 ? Infinity : i;
}

/** 返回复合步骤中最早覆盖的 stage 索引 */
function stepStartIdx(step) {
  if (step === 'design_phase') return Math.min(stageIdx('design'), stageIdx('design-review'));
  if (step === 'build_phase')  return Math.min(stageIdx('codegen'), stageIdx('create-ui-scenarios'));
  return stageIdx(step);
}

/** 返回复合步骤中最晚覆盖的 stage 索引 */
function stepEndIdx(step) {
  if (step === 'design_phase') return Math.max(stageIdx('design'), stageIdx('design-review'));
  if (step === 'build_phase')  return Math.max(stageIdx('codegen'), stageIdx('create-ui-scenarios'));
  return stageIdx(step);
}

const fromIdx = fromStage ? stageIdx(fromStage) : -1;
const toIdx   = toStage   ? stageIdx(toStage)   : Infinity;

/** 是否跳过此步骤（完全在 from/to 窗口之外） */
function shouldSkipStep(step) {
  // 步骤所有 stage 均在 fromStage 之前
  if (fromStage !== null && stepEndIdx(step) < fromIdx) return true;
  // 步骤所有 stage 均在 toStage 之后
  if (toStage !== null && stepStartIdx(step) > toIdx)   return true;
  return false;
}

/** 此步骤执行后是否应停止（已覆盖 toStage） */
function isLastStep(step) {
  if (toStage === null) return false;
  return stepEndIdx(step) >= toIdx;
}

// ── stages.json 读写 ──────────────────────────────────────────────
function readStagesJson() {
  if (!fs.existsSync(stagesJsonPath)) return null;
  try { return JSON.parse(fs.readFileSync(stagesJsonPath, 'utf8')); } catch (_) { return null; }
}

function writeStagesJson(obj) {
  fs.mkdirSync(pipelineDir, { recursive: true });
  fs.writeFileSync(stagesJsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ── stop.signal 检查（检测到信号则写日志并 exit 5）───────────────
function checkStopSignal(currentStep) {
  if (!fs.existsSync(stopSignalPath)) return;

  let reason = 'unknown';
  try {
    reason = JSON.parse(fs.readFileSync(stopSignalPath, 'utf8')).reason || 'unknown';
  } catch (_) { /* ignore */ }

  const stoppedAt = formatLocalTimeShort();
  log.info('pipeline_stop', `检测到 stop.signal，流水线编排层停止（step: ${currentStep}）`, {
    stage:      currentStep,
    reason,
    stopped_at: stoppedAt,
  });

  const stages = readStagesJson();
  if (stages) {
    if (!stages.pipeline) stages.pipeline = {};
    stages.pipeline.stop_info  = { stopped_at: stoppedAt, stopped_stage: currentStep, reason };
    stages.pipeline.updated_at = stoppedAt;
    writeStagesJson(stages);
  }

  log.info('pipeline_stopped', '流水线编排层已优雅停止', {
    stage:      currentStep,
    stopped_at: stoppedAt,
    exit_code:  5,
  });
  process.exit(5);
}

// ── 子进程调用 ────────────────────────────────────────────────────
/** 构建传给 stage 脚本的通用参数（含 --force-rerun 条件注入） */
function makeArgs(stageName, extra = []) {
  const base = [`--project=${projectRoot}`, `--run-id=${runId}`];
  if (forceRerun && forceRerun === stageName) base.push('--force-rerun');
  return [...base, ...extra];
}

/**
 * 同步（阻塞）执行 stage 脚本，返回退出码
 * @param {string} scriptFile - stages/ 下的文件名，如 'setup.cjs'
 * @param {string[]} argv     - 完整参数数组（含 --project / --run-id 等）
 */
function runSync(scriptFile, argv = []) {
  const scriptPath = path.join(STAGES_DIR, scriptFile);
  const result = spawnSync(process.execPath, [scriptPath, ...argv], {
    stdio: 'inherit',
    env:   process.env,
    cwd:   projectRoot,
  });
  if (result.error) {
    log.error('stage_failed', `无法启动子进程 ${scriptFile}: ${result.error.message}`, {
      stage: scriptFile, error: result.error.message, exit_code: 1,
    });
    return 1;
  }
  return result.status !== null && result.status !== undefined ? result.status : 1;
}

/**
 * 异步执行 stage 脚本，返回 Promise<number>（退出码）
 */
function runAsync(scriptFile, argv = []) {
  return new Promise(resolve => {
    const scriptPath = path.join(STAGES_DIR, scriptFile);
    const child = spawn(process.execPath, [scriptPath, ...argv], {
      stdio: 'inherit',
      env:   process.env,
      cwd:   projectRoot,
    });
    child.on('error', err => {
      log.error('stage_failed', `无法启动子进程 ${scriptFile}: ${err.message}`, {
        stage: scriptFile, error: err.message, exit_code: 1,
      });
      resolve(1);
    });
    child.on('close', code => resolve(code !== null ? code : 1));
  });
}

/**
 * recovery 后在子进程重跑复合 step，避免父进程 require 缓存旧版 run-pipeline.cjs
 *（例如 build_phase 轮询间隔修复后须重新加载编排逻辑）。
 */
/** 复合 step 名 → STAGE_ORDER 中的续跑锚点（from/to 过滤仅识别扁平 stage） */
function compositeStepResumeAnchor(step) {
  if (step === 'design_phase') return 'design';
  if (step === 'build_phase') return 'codegen';
  return step;
}

function spawnCompositeStepSubprocess(step) {
  const scriptPath = path.join(SCRIPTS_DIR, 'run-pipeline.cjs');
  const anchor = compositeStepResumeAnchor(step);
  const argv = [
    `--project=${projectRoot}`,
    `--run-id=${runId}`,
    `--from-stage=${anchor}`,
    `--to-stage=${anchor}`,
    '--no-dash',
    '--no-teardown',
  ];
  if (forceRerun && forceRerun === step) argv.push(`--force-rerun=${forceRerun}`);

  log.info('recovery_step_subprocess', `复合 step ${step} 在子进程重跑以加载最新编排脚本`, {
    stage:  step,
    script: scriptPath,
    argv:   argv.join(' '),
  });

  const result = spawnSync(process.execPath, [scriptPath, ...argv], {
    stdio: 'inherit',
    env:   process.env,
    cwd:   projectRoot,
  });
  if (result.error) {
    log.error('stage_failed', `无法启动 recovery 子进程 ${step}: ${result.error.message}`, {
      stage: step, error: result.error.message, exit_code: 1,
    });
    return 1;
  }
  return result.status !== null && result.status !== undefined ? result.status : 1;
}

// ── design_phase 复合编排（§3.1）─────────────────────────────────
/**
 * design + design-review 复合阶段：
 *   1. bootstrap design & design-review（各一次）
 *   2. tick 循环直到 design_review.status ∈ {completed, failed, stopped}
 */
async function runDesignPhase() {
  const dArgs  = makeArgs('design');
  const drArgs = makeArgs('design-review');

  // bootstrap design
  let code = runSync(stageScripts.design, [...dArgs, '--bootstrap']);
  if (code === 5) return 5;
  if (code !== 0) {
    log.error('stage_failed', `design --bootstrap 退出码 ${code}，design_phase 中止`, {
      stage: 'design', exit_code: code, phase: 'design_phase',
    });
    return code;
  }

  // bootstrap design-review
  code = runSync(stageScripts['design-review'], [...drArgs, '--bootstrap']);
  if (code === 5) return 5;
  if (code !== 0) {
    log.error('stage_failed', `design-review --bootstrap 退出码 ${code}，design_phase 中止`, {
      stage: 'design-review', exit_code: code, phase: 'design_phase',
    });
    return code;
  }

  // tick 循环
  const MAX_ITER = 500;
  for (let i = 0; i < MAX_ITER; i++) {
    checkStopSignal('design_phase');

    code = runSync(stageScripts.design, [...dArgs, '--tick']);
    if (code === 5) return 5;
    if (code !== 0) {
      log.warn('stage_failed', `design --tick 返回非零退出码 ${code}，继续下一轮`, {
        stage: 'design', exit_code: code, phase: 'design_phase',
      });
    }

    code = runSync(stageScripts['design-review'], [...drArgs, '--tick']);
    if (code === 5) return 5;
    if (code !== 0) {
      log.warn('stage_failed', `design-review --tick 返回非零退出码 ${code}，继续下一轮`, {
        stage: 'design-review', exit_code: code, phase: 'design_phase',
      });
    }

    // NOTE: scheduleDownstreamForReleasedGroups()（§3.1 优化项）
    // 当前为串行实现：design_phase 全部完成后才进入 build_phase。
    // 完整并发实现需在此处读取 released_groups[] 并提前入队
    // codegen / create-ui-scenarios——属于高级优化，不影响正确性。

    const stages   = readStagesJson();
    const drStatus = stages && stages.stages && stages.stages.design_review &&
                     stages.stages.design_review.status;

    if (['completed', 'failed', 'stopped'].includes(drStatus)) {
      log.info('stage_complete', `design_phase 完成，design_review.status=${drStatus}`, {
        stage: 'design_phase', design_review_status: drStatus, iterations: i + 1,
      });
      if (drStatus === 'stopped') return 5;
      if (drStatus === 'failed')  return 4;
      return 0;
    }

    if (designReviewHasInFlightFeatures(stages)) {
      const pollMs = resolveDesignPhasePollMs();
      log.info('design_phase_poll', `design-review 有在途 Agent，等待 ${pollMs}ms 后下一轮 tick`, {
        phase: 'design_phase', poll_ms: pollMs, iteration: i + 1,
      });
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  log.error('stage_failed', `design_phase tick 循环超出最大迭代次数（${MAX_ITER}）`, {
    stage: 'design_phase', exit_code: 3, max_iterations: MAX_ITER,
  });
  return 3;
}

/** build_phase tick 轮询间隔（codegen --tick 仅收割 worker；在途 Agent 需等待） */
function resolveBuildPhasePollMs() {
  const n = Number(process.env.PIPELINE_BUILD_PHASE_POLL_MS);
  if (Number.isFinite(n) && n >= 500) return Math.floor(n);
  return 5000;
}

/** design_phase tick 轮询间隔（design-review Agent 单轮可达 15min+，避免紧循环重复 tick） */
function resolveDesignPhasePollMs() {
  const n = Number(process.env.PIPELINE_DESIGN_PHASE_POLL_MS);
  if (Number.isFinite(n) && n >= 500) return Math.floor(n);
  return 30000;
}

function designReviewHasInFlightFeatures(stages) {
  const dr = stages && stages.stages && stages.stages.design_review;
  if (!dr || !dr.features) return false;
  return Object.values(dr.features).some(f => f && f.status === 'running');
}

// ── build_phase 复合编排（§3.2）──────────────────────────────────
/**
 * codegen + create-ui-scenarios 并行双 track：
 *   1. bootstrap 并行执行
 *   2. tick 循环（并行）直到两者均达终态
 */
async function runBuildPhase() {
  const cgArgs  = makeArgs('codegen');
  const uisArgs = makeArgs('create-ui-scenarios');

  // bootstrap（并行）
  const [cgBoot, uisBoot] = await Promise.all([
    runAsync(stageScripts.codegen,               [...cgArgs,  '--bootstrap']),
    runAsync(stageScripts['create-ui-scenarios'], [...uisArgs, '--bootstrap']),
  ]);

  if (cgBoot === 5 || uisBoot === 5) return 5;
  if (cgBoot !== 0) {
    log.error('stage_failed', `codegen --bootstrap 退出码 ${cgBoot}，build_phase 中止`, {
      stage: 'codegen', exit_code: cgBoot, phase: 'build_phase',
    });
    return cgBoot;
  }
  if (uisBoot !== 0) {
    log.error('stage_failed', `create-ui-scenarios --bootstrap 退出码 ${uisBoot}，build_phase 中止`, {
      stage: 'create-ui-scenarios', exit_code: uisBoot, phase: 'build_phase',
    });
    return uisBoot;
  }

  // tick 循环（并行）
  const MAX_ITER = 500;
  for (let i = 0; i < MAX_ITER; i++) {
    checkStopSignal('build_phase');

    const [cgTick, uisTick] = await Promise.all([
      runAsync(stageScripts.codegen,               [...cgArgs,  '--tick']),
      runAsync(stageScripts['create-ui-scenarios'], [...uisArgs, '--tick']),
    ]);

    if (cgTick === 5 || uisTick === 5) return 5;
    if (cgTick !== 0) {
      const lvl = cgTick === 4 ? 'error' : 'warn';
      log[lvl]('stage_failed', `codegen --tick 返回非零退出码 ${cgTick}`, {
        stage: 'codegen', exit_code: cgTick, phase: 'build_phase',
        note: cgTick === 4 ? 'feature 级失败已落盘，将尽快结束 build_phase' : '继续下一轮 tick',
      });
    }
    if (uisTick !== 0) {
      const lvl = uisTick === 4 ? 'error' : 'warn';
      log[lvl]('stage_failed', `create-ui-scenarios --tick 返回非零退出码 ${uisTick}`, {
        stage: 'create-ui-scenarios', exit_code: uisTick, phase: 'build_phase',
        note: uisTick === 4 ? 'agent/校验失败，将尽快结束 build_phase' : '继续下一轮 tick',
      });
    }

    const stages    = readStagesJson();
    const cgStatus  = stages && stages.stages && stages.stages.codegen &&
                      stages.stages.codegen.status;
    const uisStatus = stages && stages.stages && stages.stages.create_ui_scenarios &&
                      stages.stages.create_ui_scenarios.status;

    const cgDone  = ['completed', 'failed', 'stopped'].includes(cgStatus);
    const uisDone = ['completed', 'failed', 'skipped', 'stopped'].includes(uisStatus);

    if (cgDone && uisDone) {
      log.info('stage_complete',
        `build_phase 完成，codegen=${cgStatus}, create-ui-scenarios=${uisStatus}`, {
          stage: 'build_phase',
          codegen_status:             cgStatus,
          create_ui_scenarios_status: uisStatus,
          iterations: i + 1,
        });
      if (cgStatus === 'stopped' || uisStatus === 'stopped') return 5;
      if (cgStatus === 'failed'  || uisStatus === 'failed')  return 4;
      return 0;
    }

    // 避免无间隔空转：单轮 tick ~数 ms，500 次仅十余秒即 exit 3，无法等待在途 codegen worker
    const pollMs = resolveBuildPhasePollMs();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  log.error('stage_failed', `build_phase tick 循环超出最大迭代次数（${MAX_ITER}）`, {
    stage: 'build_phase', exit_code: 3, max_iterations: MAX_ITER,
  });
  return 3;
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  // 记录 pipeline 启动信息到 stages.json（若已存在）
  const initStages = readStagesJson();
  if (initStages) {
    if (!initStages.pipeline) initStages.pipeline = {};
    Object.assign(initStages.pipeline, {
      run_id:        runId,
      started_at:    startedAtStr,
      updated_at:    startedAtStr,
      current_stage: null,
    });
    writeStagesJson(initStages);
  }

  const skillsRoot = getSkillsRoot();
  const envLoad    = loadProjectEnv(projectRoot);
  if (envLoad.loaded) {
    log.info('file_updated', `已加载项目环境: ${envLoad.path}`, {
      path: envLoad.path,
    });
  }

  log.info('stage_start', `run-pipeline 启动，项目: ${projectRoot}`, {
    run_id:       runId,
    stage:        'pipeline',
    project:      projectRoot,
    skills_root:  skillsRoot,
    started_at:   startedAtStr,
    from_stage:   fromStage,
    to_stage:     toStage,
    force_rerun:  forceRerun,
    node_version: process.version,
  });

  // 续跑时清除残留 stop.signal（避免误拦截）
  if (fromStage && fs.existsSync(stopSignalPath)) {
    try {
      fs.unlinkSync(stopSignalPath);
      log.info('file_updated', '续跑（--from-stage）：已清除残留 stop.signal', {
        path:       stopSignalPath,
        from_stage: fromStage,
      });
    } catch (err) {
      log.warn('stage_failed', `清除 stop.signal 失败: ${err.message}`, {
        stage: 'pipeline', error: err.message,
      });
    }
  }

  // 自动启动看板（非 CI / NO_COLOR / --no-dash 环境）
  const isCI = !!(process.env.CI || process.env.NO_COLOR || noDash);
  if (!isCI) {
    const dashScript = path.join(SCRIPTS_DIR, 'run-dash.cjs');
    if (fs.existsSync(dashScript)) {
      try {
        const dashProc = spawn(
          process.execPath,
          [dashScript, `--project=${projectRoot}`, '--auto-launched'],
          { stdio: 'ignore', detached: true, env: process.env }
        );
        dashProc.unref();
        // 写 run-dash.pid 供 pipeline-teardown.cjs 收尾时查找
        try {
          fs.writeFileSync(
            path.join(pipelineDir, 'run-dash.pid'),
            String(dashProc.pid),
            'utf8'
          );
        } catch (_) { /* 写失败不影响流水线 */ }
        log.info('stage_start', `已自动启动 run-dash 看板（pid: ${dashProc.pid}）`, {
          stage:      'pipeline',
          dash_script: dashScript,
          dash_pid:   dashProc.pid,
        });
      } catch (err) {
        log.warn('stage_failed', `run-dash 自动启动失败（不影响流水线）: ${err.message}`, {
          stage: 'pipeline', error: err.message,
        });
      }
    }
  }

  /** 执行单个 pipeline step，返回退出码 */
  async function executeStep(step) {
    if (step === 'design_phase') return runDesignPhase();
    if (step === 'build_phase')  return runBuildPhase();
    return runSync(stageScripts[step], makeArgs(step));
  }

  // ── 执行管道 ──────────────────────────────────────────────────
  let lastExitCode    = 0;
  let reportCompleted = false;
  let pipelineBlocked = false;

  for (const step of PIPELINE_STEPS) {
    // from/to 过滤
    if (shouldSkipStep(step)) {
      log.info('stage_skipped', `跳过 step: ${step}（from-stage=${fromStage}, to-stage=${toStage}）`, {
        stage:      step,
        reason:     'from_to_stage_filter',
        from_stage: fromStage,
        to_stage:   toStage,
      });
      continue;
    }

    // 每个 step 进入前检查 stop.signal
    checkStopSignal(step);

    // 更新 stages.json 的 current_stage
    const cs = readStagesJson();
    if (cs) {
      if (!cs.pipeline) cs.pipeline = {};
      cs.pipeline.current_stage = step;
      cs.pipeline.updated_at    = formatLocalTimeShort();
      writeStagesJson(cs);
    }

    log.info('stage_start', `开始执行 step: ${step}`, {
      stage:  step,
      run_id: runId,
    });

    let exitCode = await executeStep(step);

    lastExitCode = exitCode;

    if (step === 'report' && exitCode === 0) {
      reportCompleted = true;
    }

    log.info(
      exitCode === 0 ? 'stage_complete' : 'stage_failed',
      `step ${step} 结束，退出码: ${exitCode}`,
      { stage: step, exit_code: exitCode }
    );

    // stop.signal 触发的停止（exit 5 来自 stage 内部或编排层）
    if (exitCode === 5) {
      log.info('pipeline_stopped', `step ${step} 以 exit 5 停止，流水线退出`, {
        stage: step, exit_code: 5,
      });
      process.exit(5);
    }

    // §3.4 编排级自动修复（report 不触发；setup 退出码 2 等在 recovery 内过滤）
    if (exitCode !== 0 && step !== 'report') {
      const recoveryResult = await loadPipelineRecovery().handleStepFailure({
        projectRoot,
        skillsRoot,
        runId,
        step,
        exitCode,
        log,
        readStagesJson,
        writeStagesJson,
        rerunStep: () => (
          step === 'build_phase' || step === 'design_phase'
            ? spawnCompositeStepSubprocess(step)
            : executeStep(step)
        ),
      });
      lastExitCode = recoveryResult.exitCode;
      if (recoveryResult.stopPipeline) {
        if (recoveryResult.exitCode === 5) {
          process.exit(5);
        }
        pipelineBlocked = true;
        log.error('pipeline_blocked', `recovery 判定 blocked，停止后续 step（stage=${step}）`, {
          stage: step, exit_code: 9,
        });
        break;
      }
      if (lastExitCode === 0 && step === 'report') {
        reportCompleted = true;
      }
    }

    // 达到 --to-stage 终点，停止管道
    if (isLastStep(step)) {
      log.info('stage_complete', `已达到 --to-stage=${toStage}，流水线结束`, {
        stage: step, to_stage: toStage,
      });
      break;
    }

    // 其余非零退出码：继续执行后续 stage（各 stage 自行处理门闸）
    // report 总是运行；其它 stage 的门闸检查会迅速失败并退出
  }

  // ── pipeline-teardown（§3.3）──────────────────────────────────
  if (!noTeardown) {
    const teardownScript = path.join(SCRIPTS_DIR, 'pipeline-teardown.cjs');
    if (fs.existsSync(teardownScript)) {
      log.info('pipeline_teardown_start', '开始执行 pipeline-teardown', {
        session_id: runId,
        targets:    ['run-dash', 'design_phase', 'build_phase', 'stage_processes'],
      });
      const t0 = Date.now();
      const td = spawnSync(
        process.execPath,
        [teardownScript, `--project=${projectRoot}`, `--session-id=${runId}`],
        { stdio: 'inherit', env: process.env, cwd: projectRoot }
      );
      log.info('pipeline_teardown_complete', 'pipeline-teardown 执行完成', {
        exit_code:   td.status || 0,
        duration_ms: Date.now() - t0,
        errors:      [],
      });
    }
  }

  // 写 pipeline_complete_at
  const completeAt  = formatLocalTimeShort();
  const durationMs  = Date.now() - startedAt.getTime();
  const finalStages = readStagesJson();
  if (finalStages) {
    if (!finalStages.pipeline) finalStages.pipeline = {};
    finalStages.pipeline.pipeline_complete_at = completeAt;
    finalStages.pipeline.updated_at           = completeAt;
    writeStagesJson(finalStages);
  }

  // ── 推导进程退出码（§3.3）──────────────────────────────────────
  let processExitCode;

  if (pipelineBlocked) {
    processExitCode = 9;
  } else if (toStage) {
    // 部分续跑：使用最后一个 step 的退出码
    processExitCode = lastExitCode;
  } else {
    const reportOutputs = finalStages &&
                          finalStages.stages &&
                          finalStages.stages.report &&
                          finalStages.stages.report.outputs;
    const overall       = reportOutputs && reportOutputs.overall;

    if (!reportCompleted || !overall) {
      processExitCode = 1; // report 未生成或 overall 缺失
    } else {
      switch (overall) {
        case 'success':
        case 'partial':  processExitCode = 0; break;
        case 'failed':   processExitCode = 4; break;
        case 'blocked':  processExitCode = 9; break;
        case 'stopped':  processExitCode = 5; break;
        default:         processExitCode = 1; break;
      }
    }
  }

  log.info('pipeline_complete', '流水线执行完成', {
    overall:           (finalStages && finalStages.stages && finalStages.stages.report &&
                        finalStages.stages.report.outputs &&
                        finalStages.stages.report.outputs.overall) || null,
    duration_ms:       durationMs,
    report_path:       path.join(pipelineDir, 'reports'),
    process_exit_code: processExitCode,
  });

  process.exit(processExitCode);
}

main().catch(err => {
  console.error(`[FATAL] run-pipeline.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

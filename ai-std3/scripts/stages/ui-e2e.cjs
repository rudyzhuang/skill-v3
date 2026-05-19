'use strict';

/**
 * ui-e2e.cjs — ui_e2e stage 编排入口
 *
 * 职责：在 create_ui_scenarios + deploy 均就绪后，按场景 YAML 驱动 MCP（Browser/Dart）
 * 执行 UI 验收，失败时触发分诊（ui-e2e-triage）与 feature 修复子链。
 *
 * 上游门闸（同时满足）：
 *   1. stages.deploy.status ∈ {completed, skipped}
 *   2. stages.create_ui_scenarios.status ∈ {completed, skipped}
 *   3. require_deploy_smoke_passed=true（默认）时须 deploy.outputs.inline_smoke_passed=true
 *
 * 整段跳过：pipeline.stages.ui_e2e.enabled=false → status=skipped，exit 0
 *
 * 参数：
 *   --project=<路径>           业务项目根（绝对或相对），默认 AI_STD3_PROJECT 或 cwd
 *   --run-id=<id>              run_id（由 run-pipeline 传入）
 *   --feature=<feature_id>     只跑该 feature 下的场景
 *   --scenario=<scenario_id>   只跑单场景（调试）
 *   --skip-repair-chain        分诊后只记结论，不自动子链
 *   --force-rerun              跳过 hash 门控，强制重跑
 *   --use-sdk-scenarios        场景执行回退 SDK Agent（默认使用 ui-e2e-runner MCP runner）
 *
 * 退出码：
 *   0  全部目标场景通过（或整段 skipped）
 *   1  上游门闸未满足 / PID 锁占用 / scenario_id 重复
 *   3  单场景超时且无其它失败
 *   4  分诊/子链用尽仍有失败场景
 *   5  stop.signal
 *   9  decision=blocked（须人工介入）
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { createLogger, formatLocalTimeShort } = require('../libs/logger.cjs');
const {
  loadProjectEnv,
  getSkillsRoot,
  readConfigJson: readPipelineConfigJson,
  resolvePipelineModel,
} = require('../libs/pipeline-config.cjs');
const { invokeSdkAgent } = require('../libs/invoke-sdk-agent.cjs');
const {
  runScenarioWithRunner,
  preflightBrowser,
  preflightDart,
  resetMobileSessions,
} = require('../libs/ui-e2e-runner.cjs');
const { ensureDevicesForScenarios } = require('../libs/ui-e2e-mobile-device.cjs');
const { publishSkillPrompts } = require('../libs/skill-prompt-publish.cjs');

// ── 解析参数 ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || true];
    })
);

const projectRoot       = args.project
  ? path.resolve(args.project)
  : process.env.AI_STD3_PROJECT
    ? path.resolve(process.env.AI_STD3_PROJECT)
    : process.cwd();

const runId             = args['run-id'] || null;
const featureFilter     = args.feature   || null;
const scenarioFilter    = args.scenario  || null;
const skipRepairChain   = args['skip-repair-chain'] === true || args['skip-repair-chain'] === 'true';
const forceRerun        = args['force-rerun'] === true || args['force-rerun'] === 'true';
const useSdkScenarios   =
  args['use-sdk-scenarios'] === true ||
  args['use-sdk-scenarios'] === 'true' ||
  process.env.AI_STD3_UI_E2E_SDK_SCENARIOS === '1';
const configName        = (args.config === 'release') ? 'release' : 'dev';

// ── Logger ────────────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'ui_e2e', runId });

// ── stages.json 读写 ──────────────────────────────────────────────
function readStagesJson() {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeStagesJson(obj) {
  const dir = path.join(projectRoot, '.pipeline');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'stages.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return p;
}

// ── 配置读取 ──────────────────────────────────────────────────────
function readConfigJson() {
  const p = path.join(projectRoot, 'docs', `config.${configName}.json`);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return {}; }
}

function readConfigEnv() {
  const p = path.join(projectRoot, 'docs', 'config.env');
  const env = {};
  if (!fs.existsSync(p)) return env;
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      env[key] = val;
    }
  } catch (_) {}
  return env;
}

// ── 获取 ui_e2e 配置（支持两个位置：pipeline.stages.ui_e2e 与 ui_e2e） ──
function getUiE2eCfg(config) {
  const fromPipeline = (config.pipeline && config.pipeline.stages && config.pipeline.stages.ui_e2e) || {};
  const fromRoot     = config.ui_e2e || {};
  // 合并，pipeline 层优先（测试用的配置放在 pipeline.stages.ui_e2e）
  return Object.assign({}, fromRoot, fromPipeline);
}

// ── PID 锁 ────────────────────────────────────────────────────────
const locksDir    = path.join(projectRoot, '.pipeline', 'locks');
const pidLockPath = path.join(locksDir, 'ui_e2e.pid');

function acquirePidLock() {
  fs.mkdirSync(locksDir, { recursive: true });
  if (fs.existsSync(pidLockPath)) {
    const existingPid = parseInt(fs.readFileSync(pidLockPath, 'utf8').trim(), 10);
    try {
      process.kill(existingPid, 0);
      return { ok: false, existingPid };
    } catch (_) {
      fs.unlinkSync(pidLockPath);
    }
  }
  fs.writeFileSync(pidLockPath, String(process.pid), 'utf8');
  return { ok: true };
}

function releasePidLock() {
  try {
    if (fs.existsSync(pidLockPath)) {
      const pid = fs.readFileSync(pidLockPath, 'utf8').trim();
      if (pid === String(process.pid)) fs.unlinkSync(pidLockPath);
    }
  } catch (_) {}
}

// ── stop.signal ───────────────────────────────────────────────────
const stopSignalPath = path.join(projectRoot, '.pipeline', 'stop.signal');

function getStopReason() {
  if (!fs.existsSync(stopSignalPath)) return null;
  try { return JSON.parse(fs.readFileSync(stopSignalPath, 'utf8')).reason || 'unknown'; }
  catch (_) { return 'unknown'; }
}

// ── 简易 YAML 解析（仅用于 scenarios.yaml 结构） ─────────────────
function loadScenariosYaml(yamlPath) {
  if (!fs.existsSync(yamlPath)) return null;
  try {
    // 优先使用 js-yaml
    const yaml = require('js-yaml');
    return yaml.load(fs.readFileSync(yamlPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ── 文件 SHA-256 ──────────────────────────────────────────────────
function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ── 场景队列构建 ──────────────────────────────────────────────────
function buildScenarioQueue(stages, config) {
  const queue = [];
  const seenIds = new Set();

  // 获取 feature 列表（从 prd 或 create_ui_scenarios）
  const prdFeatures = (stages.stages &&
                       stages.stages.prd &&
                       stages.stages.prd.outputs &&
                       stages.stages.prd.outputs.features) || [];

  const createUiOutputs = (stages.stages &&
                            stages.stages.create_ui_scenarios &&
                            stages.stages.create_ui_scenarios.outputs) || {};
  const scenarioFilesMap = createUiOutputs.scenario_files || {};

  // 获取 deploy outputs（用于解析 base_url）
  const deployOutputs = (stages.stages &&
                         stages.stages.deploy &&
                         stages.stages.deploy.outputs) || {};
  const deployUrls = deployOutputs.deployment_urls || {};

  // 解析 base_url
  const uiE2eCfg = getUiE2eCfg(config);
  const webCfg   = uiE2eCfg.web || {};

  function resolveBaseUrl(clientTarget) {
    // 1. 从 ui_e2e.web.<clientTarget>.base_url_from 解析
    const targetWebCfg = webCfg[clientTarget] || {};
    if (targetWebCfg.base_url) return targetWebCfg.base_url;
    if (targetWebCfg.base_url_from) {
      const keyPath = targetWebCfg.base_url_from.replace(/^deploy\.services\./, '').replace(/\.url$/, '');
      if (deployUrls[keyPath]) return deployUrls[keyPath];
    }
    // 2. 从 deploy.outputs.deployment_urls 直接取
    if (deployUrls[clientTarget]) return deployUrls[clientTarget];
    // 3. 从 deploy.outputs.services 查
    const services = deployOutputs.services || [];
    const svc = services.find(s => s.client_target === clientTarget || s.name === clientTarget);
    if (svc && svc.url) return svc.url;
    return null;
  }

  // 遍历每个 feature
  const featureIds = new Set();
  prdFeatures.forEach(f => featureIds.add(f.feature_id));
  Object.keys(scenarioFilesMap).forEach(id => featureIds.add(id));

  for (const featureId of featureIds) {
    if (featureFilter && featureId !== featureFilter) continue;

    // 查找 YAML 路径
    let yamlPath = scenarioFilesMap[featureId]
      || path.join(projectRoot, 'docs', 'ui-scenarios', `${featureId}.scenarios.yaml`);

    if (!fs.existsSync(yamlPath)) continue;

    const yamlData = loadScenariosYaml(yamlPath);
    if (!yamlData || !Array.isArray(yamlData.scenarios)) continue;

    for (const sc of yamlData.scenarios) {
      if (!sc.id) continue;
      if (scenarioFilter && sc.id !== scenarioFilter) continue;

      if (seenIds.has(sc.id)) {
        // scenario_id 重复 → 退出码 1
        return { error: `scenario_id 重复: ${sc.id}`, queue: null };
      }
      seenIds.add(sc.id);

      const platform     = sc.platform || 'web';
      const clientTarget = sc.client_target || 'website';
      let mcp = 'none';
      if (platform === 'web') mcp = 'browser';
      else if (platform === 'android' || platform === 'ios') mcp = 'dart';

      const baseUrl = platform === 'web' ? resolveBaseUrl(clientTarget) : null;

      queue.push({
        scenario_id:   sc.id,
        feature_id:    featureId,
        client_target: clientTarget,
        platform,
        yaml_path:     yamlPath,
        base_url:      baseUrl,
        mcp,
        steps:         sc.steps || [],
        expect:        sc.expect || [],
        raw:           sc,
        status:        'pending',
      });
    }
  }

  return { error: null, queue };
}

// ── 计算 scenario_bundle_hash ─────────────────────────────────────
function computeScenarioBundleHash(stages, queue) {
  const releaseBundleHash = (stages.stages &&
                              stages.stages.create_ui_scenarios &&
                              stages.stages.create_ui_scenarios.inputs &&
                              stages.stages.create_ui_scenarios.inputs.release_bundle_hash) || null;
  const deployInputsSummaryHash = (stages.stages &&
                                    stages.stages.deploy &&
                                    stages.stages.deploy.inputs &&
                                    stages.stages.deploy.inputs.summary_hash) || null;
  // 各 YAML 文件 SHA-256，按 scenario_id 字典序
  const sorted = [...queue].sort((a, b) => a.scenario_id.localeCompare(b.scenario_id));
  const yamlHashes = sorted.map(sc => ({
    scenario_id: sc.scenario_id,
    yaml_hash: fileSha256(sc.yaml_path),
  }));
  const payload = JSON.stringify({ releaseBundleHash, deployInputsSummaryHash, yamlHashes });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ── 时间戳（日志文件名用） ────────────────────────────────────────
function nowFileTs() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// ── 单场景执行（默认 MCP runner；--use-sdk-scenarios 回退 SDK Agent）──
async function runScenario({ sc, config, stages, datetime }) {
  const uiE2eCfg   = getUiE2eCfg(config);
  const commandsCfg = uiE2eCfg.commands || {};
  const scenarioTimeoutMs = ((config.timeouts && config.timeouts.stages && config.timeouts.stages.ui_e2e_scenario_s) || 600) * 1000;
  const maxFixAttempts = commandsCfg.scenario_max_fix_attempts != null ? commandsCfg.scenario_max_fix_attempts : 2;

  if (!useSdkScenarios) {
    return runScenarioWithRunner({
      projectRoot,
      sc,
      config,
      log,
      datetime,
      scenarioTimeoutMs,
      maxFixAttempts,
    });
  }

  return runScenarioViaSdkAgent({ sc, config, datetime, scenarioTimeoutMs, maxFixAttempts });
}

async function runScenarioViaSdkAgent({ sc, config, datetime, scenarioTimeoutMs, maxFixAttempts }) {
  const startedAt  = Date.now();
  const startedStr = formatLocalTimeShort(new Date(startedAt));

  const scLogDir   = path.join(projectRoot, 'logs', 'stages', 'ui_e2e');
  const featLogDir = path.join(projectRoot, 'logs', 'features', sc.feature_id);
  const snapDir    = path.join(projectRoot, '.pipeline', 'logs', 'snapshots', sc.scenario_id);
  fs.mkdirSync(scLogDir,   { recursive: true });
  fs.mkdirSync(featLogDir, { recursive: true });
  fs.mkdirSync(snapDir,    { recursive: true });

  const scLogPath = path.join(scLogDir, `${datetime}-${sc.scenario_id}.log`);
  fs.writeFileSync(scLogPath, `[ui_e2e] scenario=${sc.scenario_id} started at ${startedStr} (sdk)\n`, 'utf8');

  log.info('ui_scenario_start', `[ui_e2e] scenario=${sc.scenario_id} feature=${sc.feature_id} 开始执行（SDK）`, {
    scenario_id: sc.scenario_id,
    feature_id:  sc.feature_id,
    platform:    sc.platform,
    mcp:         sc.mcp,
    base_url:    sc.base_url || null,
  });

  if (sc.platform === 'desktop' || sc.mcp === 'none') {
    log.info('ui_scenario_skipped', `[ui_e2e] scenario=${sc.scenario_id} platform=desktop 跳过（未实现）`, {
      scenario_id: sc.scenario_id,
      reason: 'desktop_not_implemented',
    });
    return {
      scenario_id:    sc.scenario_id,
      feature_id:     sc.feature_id,
      platform:       sc.platform,
      status:         'skipped',
      passed:         false,
      started_at:     startedStr,
      completed_at:   formatLocalTimeShort(),
      duration_ms:    Date.now() - startedAt,
      log_path:       path.relative(projectRoot, scLogPath),
      snapshot_paths: [],
      failure_summary: null,
      skip_reason:    'desktop_not_implemented',
      fix_attempts:   0,
    };
  }

  const skillsRoot = getSkillsRoot();
  const snapshotPaths = [];
  let   fixAttempts   = 0;
  let   timedOut      = false;

  // 执行（含即时重试）— SDK Agent + 结构化结果 JSON
  async function attemptExecution() {
    const contextPath = path.join(projectRoot, '.pipeline', `ui-e2e-scenario-ctx-${sc.scenario_id}.json`);
    fs.writeFileSync(contextPath, JSON.stringify({
      scenario_id: sc.scenario_id,
      feature_id:  sc.feature_id,
      platform:    sc.platform,
      base_url:    sc.base_url,
      steps:       sc.steps,
      expect:      sc.expect,
    }, null, 2) + '\n', 'utf8');

    const scenarioResultPath = path.join(projectRoot, '.pipeline', `ui-e2e-scenario-result-${sc.scenario_id}.json`);
    const cfg   = readPipelineConfigJson(projectRoot, configName);
    const model = resolvePipelineModel(cfg);

    const agentResult = await invokeSdkAgent({
      skillsRoot,
      projectRoot,
      promptFile:   'ui-e2e-run-scenario.md',
      agentId:      `ui-e2e-scenario-${sc.scenario_id}`,
      cwd:          projectRoot,
      model,
      timeoutMs:    scenarioTimeoutMs,
      log,
      artifactPath: scenarioResultPath,
      inject:       { scenario_context: contextPath },
    });

    if (agentResult.timedOut) {
      timedOut = true;
      return { passed: false, timedOut: true, failure_summary: `场景超时（${scenarioTimeoutMs}ms）` };
    }

    fs.appendFileSync(scLogPath,
      `[sdk agent] success=${agentResult.success} error=${agentResult.error || ''}\n`);
    fs.appendFileSync(path.join(featLogDir, `${datetime}.log`),
      `[${sc.scenario_id}] sdk success=${agentResult.success}\n`);

    if (!agentResult.success && !agentResult.artifact) {
      if (!process.env.CURSOR_API_KEY) {
        const msg = `CURSOR_API_KEY 未设置，跳过场景（scenario_id=${sc.scenario_id}）\n`;
        fs.appendFileSync(scLogPath, msg);
        return { passed: true, skipped: true, reason: 'no_api_key' };
      }
      return { passed: false, failure_summary: agentResult.error || 'SDK Agent 失败' };
    }

    const result = agentResult.artifact || {};
    if (Array.isArray(result.snapshot_paths)) {
      snapshotPaths.push(...result.snapshot_paths);
    }
    if (result.passed === true) return { passed: true };
    return {
      passed: false,
      failure_summary: result.failure_summary || agentResult.error || '场景未通过',
    };
  }

  // 超时包装 + 即时重试循环
  let result = { passed: false, failure_summary: 'unknown' };
  while (fixAttempts <= maxFixAttempts) {
    if (fixAttempts > 0) {
      log.warn('ui_scenario_retry', `[ui_e2e] scenario=${sc.scenario_id} 即时重试 #${fixAttempts}`, {
        scenario_id: sc.scenario_id,
        attempt: fixAttempts,
        reason: result.failure_summary || 'previous_attempt_failed',
      });
    }

    const execPromise = attemptExecution();
    const timeoutPromise = new Promise(resolve =>
      setTimeout(() => {
        timedOut = true;
        resolve({ passed: false, timedOut: true, failure_summary: `场景超时（${scenarioTimeoutMs}ms）` });
      }, scenarioTimeoutMs + 1000) // +1s buffer (inner agent has its own timeout)
    );
    result = await Promise.race([execPromise, timeoutPromise]);

    if (result.timedOut || result.passed || result.skipped) break;
    fixAttempts++;
  }

  const completedAt  = Date.now();
  const completedStr = formatLocalTimeShort(new Date(completedAt));
  const durationMs   = completedAt - startedAt;

  // 截图：若失败且无截图则写一个空占位文件
  if (!result.passed && !result.skipped && snapshotPaths.length === 0) {
    const snapName = `${nowFileTs()}.jpg`;
    const snapPath = path.join(snapDir, snapName);
    // 写最小 JPEG 占位（空内容）
    try { fs.writeFileSync(snapPath, Buffer.alloc(0)); } catch (_) {}
    snapshotPaths.push(path.relative(projectRoot, snapPath));
    log.info('ui_scenario_snapshot', `[ui_e2e] scenario=${sc.scenario_id} 截图占位已写`, {
      scenario_id: sc.scenario_id,
      path: snapshotPaths[snapshotPaths.length - 1],
      step_index: -1,
    });
  }

  if (result.skipped) {
    log.info('ui_scenario_complete', `[ui_e2e] scenario=${sc.scenario_id} 跳过（${result.reason}）`, {
      scenario_id:  sc.scenario_id,
      duration_ms:  durationMs,
      snapshot_paths: [],
    });
    return {
      scenario_id:    sc.scenario_id,
      feature_id:     sc.feature_id,
      platform:       sc.platform,
      status:         'skipped',
      passed:         false,
      started_at:     startedStr,
      completed_at:   completedStr,
      duration_ms:    durationMs,
      log_path:       path.relative(projectRoot, scLogPath),
      snapshot_paths: [],
      failure_summary: null,
      skip_reason:    result.reason || 'no_agent_bin',
      fix_attempts:   fixAttempts,
    };
  }

  if (result.passed) {
    log.info('ui_scenario_complete', `[ui_e2e] scenario=${sc.scenario_id} 通过，耗时 ${durationMs}ms`, {
      scenario_id:    sc.scenario_id,
      duration_ms:    durationMs,
      snapshot_paths: snapshotPaths,
    });
    return {
      scenario_id:    sc.scenario_id,
      feature_id:     sc.feature_id,
      platform:       sc.platform,
      status:         'completed',
      passed:         true,
      started_at:     startedStr,
      completed_at:   completedStr,
      duration_ms:    durationMs,
      log_path:       path.relative(projectRoot, scLogPath),
      snapshot_paths: snapshotPaths,
      failure_summary: null,
      fix_attempts:   fixAttempts,
    };
  }

  // 失败
  const failureSummary = result.failure_summary || `场景执行失败（重试 ${fixAttempts} 次）`;
  log.error('ui_scenario_failed', `[ui_e2e] scenario=${sc.scenario_id} platform=${sc.platform} 失败：${failureSummary}；log=${path.relative(projectRoot, scLogPath)}；snapshot=${snapshotPaths[0] || '(none)'}`, {
    scenario_id:    sc.scenario_id,
    feature_id:     sc.feature_id,
    failure_summary: failureSummary,
    log_path:       path.relative(projectRoot, scLogPath),
    snapshot_paths: snapshotPaths,
  });

  const scStatus = timedOut ? 'timed_out' : 'failed';
  return {
    scenario_id:    sc.scenario_id,
    feature_id:     sc.feature_id,
    platform:       sc.platform,
    status:         scStatus,
    passed:         false,
    started_at:     startedStr,
    completed_at:   completedStr,
    duration_ms:    durationMs,
    log_path:       path.relative(projectRoot, scLogPath),
    snapshot_paths: snapshotPaths,
    failure_summary: failureSummary,
    timed_out:      timedOut,
    fix_attempts:   fixAttempts,
  };
}

// ── 并发池执行 ────────────────────────────────────────────────────
async function runWithConcurrency(items, concurrency, fn, shouldStop) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      if (shouldStop && shouldStop()) break;
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ── 分诊 Agent（SDK）──────────────────────────────────────────────
async function runTriageAgent({ featureId, failedScenarioResults, stages, session, attempt }) {
  const skillsRoot  = getSkillsRoot();
  const lastErrPath = path.join(projectRoot, '.pipeline', `ui-e2e-last-error-${featureId}.json`);
  const triagePath  = path.join(projectRoot, '.pipeline', `ui-e2e-triage-${featureId}.json`);

  // 组装错误包
  const lastErrorDoc = {
    feature_id:     featureId,
    triage_attempt: attempt,
    failed_scenarios: failedScenarioResults.map(sc => ({
      scenario_id:     sc.scenario_id,
      platform:        sc.platform,
      failure_summary: sc.failure_summary,
      log_path:        sc.log_path,
      snapshot_paths:  sc.snapshot_paths,
    })),
    codegen_info: (stages.stages && stages.stages.codegen &&
                   stages.stages.codegen.features &&
                   stages.stages.codegen.features[featureId]) || null,
    design_info: (stages.stages && stages.stages.design &&
                  stages.stages.design.features &&
                  stages.stages.design.features[featureId]) || null,
    report_path: path.join(projectRoot, '.pipeline', 'reports', `ui-e2e-${session}.md`),
  };
  fs.writeFileSync(lastErrPath, JSON.stringify(lastErrorDoc, null, 2) + '\n', 'utf8');

  log.info('ui_e2e_triage_start', `[ui_e2e] feature=${featureId} 启动分诊 Agent，attempt=${attempt}`, {
    feature_id:          featureId,
    failed_scenario_ids: failedScenarioResults.map(s => s.scenario_id),
  });

  const fallback = (reason, decision = 'blocked') => {
    const triage = {
      decision,
      category:             'unknown',
      reason,
      failed_scenario_ids:  failedScenarioResults.map(s => s.scenario_id),
      evidence:             [],
      user_actions:         ['查看 .pipeline/ 日志并手动排查'],
    };
    fs.writeFileSync(triagePath, JSON.stringify(triage, null, 2) + '\n', 'utf8');
    return triage;
  };

  const cfg   = readPipelineConfigJson(projectRoot, configName);
  const model = resolvePipelineModel(cfg);

  const agentResult = await invokeSdkAgent({
    skillsRoot,
    projectRoot,
    promptFile:   'ui-e2e-triage.md',
    agentId:      `ui-e2e-triage-${featureId}`,
    cwd:          projectRoot,
    model,
    timeoutMs:    180000,
    log,
    artifactPath: triagePath,
    inject: {
      last_error: lastErrPath,
      attempt:    String(attempt),
    },
  });

  let triage = agentResult.artifact;
  if (!triage) {
    log.error('ui_e2e_triage_complete', `[ui_e2e] 分诊 Agent 未产出 triage JSON`, {
      feature_id: featureId,
      error:      agentResult.error,
    });
    return fallback(agentResult.error || '分诊 Agent 未产出 JSON');
  }

  log.info('ui_e2e_triage_complete', `[ui_e2e] feature=${featureId} 分诊完成：decision=${triage.decision}`, {
    feature_id: featureId,
    decision:   triage.decision,
    reason:     triage.reason,
  });
  return triage;
}

// ── fix_prompt：提交并推送 skill 提示词 ───────────────────────────
function publishFixPrompt({ featureId, triage }) {
  const skillsRoot = getSkillsRoot();
  const msg = `fix(ui-e2e): ${featureId} — ${String(triage.reason || 'triage').slice(0, 72)}`;
  return publishSkillPrompts({
    skillsRoot,
    message: msg,
    files:   triage.prompt_files || [],
    log,
  });
}

async function rerunFailedScenariosForFeature({
  featureId,
  failedScenarios,
  scenarioQueue,
  config,
  stages,
  scenarioResultsMap,
}) {
  const retryQueue = scenarioQueue.filter(
    (sc) =>
      sc.feature_id === featureId &&
      failedScenarios.some((f) => f.scenario_id === sc.scenario_id)
  );
  for (const sc of retryQueue) {
    const result = await runScenario({ sc, config, stages, datetime: log.datetime });
    scenarioResultsMap[sc.scenario_id] = result;
    stages = readStagesJson() || stages;
    if (!stages.stages.ui_e2e.scenarios) stages.stages.ui_e2e.scenarios = {};
    stages.stages.ui_e2e.scenarios[sc.scenario_id] = {
      feature_id:       result.feature_id,
      status:           result.status,
      started_at:       result.started_at || null,
      completed_at:     result.completed_at || null,
      duration_ms:      result.duration_ms || null,
      screenshot_paths: result.snapshot_paths || [],
      error:            result.failure_summary || null,
    };
    writeStagesJson(stages);
  }
  const stillFailed = retryQueue.filter(
    (sc) =>
      scenarioResultsMap[sc.scenario_id] &&
      ['failed', 'timed_out'].includes(scenarioResultsMap[sc.scenario_id].status)
  );
  return { retryQueue, stillFailed };
}

// ── feature 修复子链 ──────────────────────────────────────────────
function runRepairChain({ featureId, stages }) {
  log.info('repair_chain_start', `[ui_e2e] feature=${featureId} 修复子链启动`, {
    feature_id: featureId,
    stages: ['code-review', 'merge-push', 'build', 'deploy', 'ui-e2e'],
  });

  const stagesDir = path.resolve(__dirname);
  const chainStages = [
    { name: 'code-review', script: path.join(stagesDir, 'code-review.cjs') },
    { name: 'merge-push',  script: path.join(stagesDir, 'merge-push.cjs')  },
    { name: 'build',       script: path.join(stagesDir, 'build.cjs')       },
    { name: 'deploy',      script: path.join(stagesDir, 'deploy.cjs'), extraArgs: ['--explicit-confirm'] },
    { name: 'ui-e2e',      script: path.join(stagesDir, 'ui-e2e.cjs'), extraArgs: [`--feature=${featureId}`, '--skip-repair-chain'] },
  ];

  for (const step of chainStages) {
    const stepStart = Date.now();
    const stepArgs  = [
      step.script,
      `--project=${projectRoot}`,
      `--feature=${featureId}`,
      ...(step.extraArgs || []),
    ];
    if (runId) stepArgs.push(`--run-id=${runId}`);

    const result = spawnSync('node', stepArgs, {
      cwd:     projectRoot,
      encoding: 'utf8',
      timeout: 1800000,
      stdio:   ['ignore', 'pipe', 'pipe'],
    });

    const stepDur = Date.now() - stepStart;
    log.info('repair_chain_step', `[ui_e2e] feature=${featureId} 子链步骤 ${step.name} exit=${result.status}`, {
      feature_id: featureId,
      stage:      step.name,
      exit_code:  result.status,
      duration_ms: stepDur,
    });

    if (result.status !== 0) {
      log.error('repair_chain_failed', `[ui_e2e] feature=${featureId} 子链在 ${step.name} 中断，exit=${result.status}`, {
        feature_id:  featureId,
        failed_stage: step.name,
        exit_code:   result.status,
        reason:      (result.stderr || result.stdout || '').slice(-300),
      });
      return { success: false, failed_at: step.name };
    }
  }

  log.info('repair_chain_complete', `[ui_e2e] feature=${featureId} 修复子链成功`, {
    feature_id: featureId,
    duration_ms: 0,
  });
  return { success: true };
}

// ── 生成 UI E2E 报告 ──────────────────────────────────────────────
function generateReport({ scenarioResults, session, startedAt, completedAt }) {
  const durMs  = completedAt - startedAt;
  const durSec = (durMs / 1000).toFixed(1);

  const lines = [
    `# UI E2E Report — ${session}`,
    '',
    '## 摘要',
    '',
    `| 项目 | 值 |`,
    `| --- | --- |`,
    `| 总耗时 | ${durSec}s |`,
    `| 报告时间 | ${formatLocalTimeShort(new Date(completedAt))} |`,
    `| 场景总数 | ${scenarioResults.length} |`,
    `| 通过 | ${scenarioResults.filter(s => s.status === 'completed').length} |`,
    `| 失败 | ${scenarioResults.filter(s => s.status === 'failed' || s.status === 'timed_out').length} |`,
    `| 跳过 | ${scenarioResults.filter(s => s.status === 'skipped').length} |`,
    '',
    '## 场景列表',
    '',
    '| scenario_id | feature | platform | 结果 | 耗时 | 截图 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const sc of scenarioResults) {
    const mark = sc.status === 'completed' ? '✅' : sc.status === 'skipped' ? '⏭' : '❌';
    const dur  = sc.duration_ms != null ? `${(sc.duration_ms / 1000).toFixed(1)}s` : '-';
    const snap = (sc.snapshot_paths || []).length > 0 ? sc.snapshot_paths[0] : '-';
    lines.push(`| ${sc.scenario_id} | ${sc.feature_id} | ${sc.platform} | ${mark} ${sc.status} | ${dur} | ${snap} |`);
  }

  const failed = scenarioResults.filter(s => s.status === 'failed' || s.status === 'timed_out');
  if (failed.length > 0) {
    lines.push('', '## 失败详情', '');
    for (const sc of failed) {
      lines.push(`### ${sc.scenario_id}`, '');
      lines.push(`- **failure_summary**: ${sc.failure_summary || '(none)'}`);
      lines.push(`- **log_path**: ${sc.log_path || '-'}`);
      if ((sc.snapshot_paths || []).length > 0) {
        lines.push(`- **snapshots**: ${sc.snapshot_paths.join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = Date.now();
  const startedAtStr = formatLocalTimeShort(new Date(startedAt));

  loadProjectEnv(projectRoot);

  log.info('stage_start', `ui_e2e stage 启动，项目: ${projectRoot}`, {
    run_id:     runId,
    stage:      'ui_e2e',
    project:    projectRoot,
    started_at: startedAtStr,
  });

  // ── 1. 读 stages.json ─────────────────────────────────────────────
  let stages = readStagesJson();
  if (!stages) {
    log.error('stage_failed', 'stages.json 不存在', {
      stage: 'ui_e2e', exit_code: 1, reason: 'stages_json_missing', duration_ms: 0,
    });
    process.exit(1);
  }

  // ── 2. 读取配置 ───────────────────────────────────────────────────
  const config      = readConfigJson();
  const uiE2eCfg    = getUiE2eCfg(config);

  // ── 3. 上游门闸校验 ───────────────────────────────────────────────
  const deployStg       = stages.stages && stages.stages.deploy;
  const createUiStg     = stages.stages && stages.stages.create_ui_scenarios;
  const deployStatus    = deployStg && deployStg.status;
  const createUiStatus  = createUiStg && createUiStg.status;

  const DONE_STATUSES = ['completed', 'skipped'];

  if (!DONE_STATUSES.includes(deployStatus)) {
    log.error('stage_failed',
      `上游门闸未满足：deploy.status=${deployStatus}，需要 completed|skipped`, {
        stage: 'ui_e2e', exit_code: 1,
        reason: `deploy.status=${deployStatus}`,
        duration_ms: Date.now() - startedAt,
      });
    stages.stages        = stages.stages || {};
    stages.stages.ui_e2e = Object.assign({}, stages.stages.ui_e2e || {}, {
      status: 'failed', started_at: startedAtStr,
      blocking_issues: [`deploy.status=${deployStatus}`],
    });
    stages.pipeline = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    process.exit(1);
  }

  if (!DONE_STATUSES.includes(createUiStatus)) {
    log.error('stage_failed',
      `上游门闸未满足：create_ui_scenarios.status=${createUiStatus}，需要 completed|skipped`, {
        stage: 'ui_e2e', exit_code: 1,
        reason: `create_ui_scenarios.status=${createUiStatus}`,
        duration_ms: Date.now() - startedAt,
      });
    stages.stages        = stages.stages || {};
    stages.stages.ui_e2e = Object.assign({}, stages.stages.ui_e2e || {}, {
      status: 'failed', started_at: startedAtStr,
      blocking_issues: [`create_ui_scenarios.status=${createUiStatus}`],
    });
    stages.pipeline = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    process.exit(1);
  }

  // smoke 检查（deploy 未 skipped 时）
  const requireSmoke = uiE2eCfg.require_deploy_smoke_passed !== false; // 默认 true
  if (requireSmoke && deployStatus !== 'skipped') {
    const smokePassed = deployStg && deployStg.outputs && deployStg.outputs.inline_smoke_passed;
    if (smokePassed !== true) {
      log.error('stage_failed',
        `上游门闸未满足：require_deploy_smoke_passed=true 但 deploy.outputs.inline_smoke_passed=${smokePassed}`, {
          stage: 'ui_e2e', exit_code: 1,
          reason: `inline_smoke_passed=${smokePassed}`,
          duration_ms: Date.now() - startedAt,
        });
      stages.stages        = stages.stages || {};
      stages.stages.ui_e2e = Object.assign({}, stages.stages.ui_e2e || {}, {
        status: 'failed', started_at: startedAtStr,
        blocking_issues: [`inline_smoke_passed=${smokePassed}`],
      });
      stages.pipeline = stages.pipeline || {};
      stages.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stages);
      process.exit(1);
    }
  }

  // ── 4. enabled 检查 ───────────────────────────────────────────────
  if (uiE2eCfg.enabled === false) {
    log.info('stage_skipped', 'ui_e2e.enabled=false，跳过 ui_e2e', {
      reason: 'ui_e2e.disabled', exit_code: 0,
    });
    stages.stages        = stages.stages || {};
    stages.stages.ui_e2e = Object.assign({}, stages.stages.ui_e2e || {}, {
      status:       'skipped',
      started_at:   startedAtStr,
      completed_at: formatLocalTimeShort(),
      outputs: {
        overall: 'skipped',
        total_scenarios: 0, passed_scenarios: 0, failed_scenarios: 0, skipped_scenarios: 0,
        blocked_features: [], repair_chain_triggered: false, repair_chain_status: null,
        duration_ms: Date.now() - startedAt, timed_out: false, timeout_reason: null,
        skip_reason: 'ui_e2e.disabled',
      },
      validation: {
        passed: true, checked_at: formatLocalTimeShort(), summary: null,
        required_files: [], missing_required_fields: [], warnings: [],
      },
    });
    stages.pipeline = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    process.exit(0);
  }

  // ── 5. stop.signal 检查（启动时） ─────────────────────────────────
  const stopReason = getStopReason();
  if (stopReason !== null) {
    log.info('pipeline_stop', '检测到 stop.signal，ui_e2e stage 停止', {
      stage: 'ui_e2e', reason: stopReason, stopped_at: formatLocalTimeShort(),
    });
    stages.stages        = stages.stages || {};
    stages.stages.ui_e2e = Object.assign({}, stages.stages.ui_e2e || {}, {
      status:     'stopped',
      started_at: startedAtStr,
    });
    stages.pipeline = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    process.exit(5);
  }

  // ── 6. PID 锁 ─────────────────────────────────────────────────────
  const lockResult = acquirePidLock();
  if (!lockResult.ok) {
    log.error('stage_failed',
      `PID 锁被占用（pid=${lockResult.existingPid}），可能有并发 ui_e2e 在运行`, {
        stage: 'ui_e2e', exit_code: 1,
        reason: `pid_lock_occupied: ${lockResult.existingPid}`,
        duration_ms: Date.now() - startedAt,
      });
    process.exit(1);
  }

  process.on('exit', releasePidLock);
  process.on('SIGINT',  () => { releasePidLock(); process.exit(1); });
  process.on('SIGTERM', () => { releasePidLock(); process.exit(1); });

  // ── 7. 构建场景队列 ───────────────────────────────────────────────
  const queueResult = buildScenarioQueue(stages, config);
  if (queueResult.error) {
    log.error('stage_failed', `场景队列构建失败：${queueResult.error}`, {
      stage: 'ui_e2e', exit_code: 1, reason: queueResult.error, duration_ms: Date.now() - startedAt,
    });
    releasePidLock();
    process.exit(1);
  }
  const scenarioQueue = queueResult.queue;

  // ── 8. hash 门控（全段跳过） ──────────────────────────────────────
  if (!forceRerun && scenarioQueue.length > 0) {
    const hashNew   = computeScenarioBundleHash(stages, scenarioQueue);
    const oldUiE2e  = stages.stages && stages.stages.ui_e2e;
    const oldHash   = oldUiE2e && oldUiE2e.inputs && oldUiE2e.inputs.scenario_bundle_hash;
    const oldStatus = oldUiE2e && oldUiE2e.status;
    const oldFailed = oldUiE2e && oldUiE2e.outputs && (oldUiE2e.outputs.failed_scenarios || 0);
    if (oldHash && oldHash === hashNew && oldStatus === 'completed' && oldFailed === 0) {
      log.info('stage_skipped', 'ui_e2e hash 门控命中，整段跳过', {
        reason: 'scenario_bundle_hash_matched', exit_code: 0,
      });
      releasePidLock();
      process.exit(0);
    }
  }

  // ── 9. 并发参数 ───────────────────────────────────────────────────
  const pipelineCfg     = config.pipeline || {};
  const stagesUiE2eCfg  = (pipelineCfg.stages && pipelineCfg.stages.ui_e2e) || {};
  const scenarioMaxParallel = stagesUiE2eCfg.scenario_max_parallel != null ? stagesUiE2eCfg.scenario_max_parallel : 3;
  const featureMaxParallel  = (pipelineCfg.autorun && pipelineCfg.autorun.feature_max_parallel) || 3;
  const effectiveParallel   = Math.min(scenarioMaxParallel, featureMaxParallel);
  const triageMaxAttempts   = stagesUiE2eCfg.triage_max_attempts != null ? stagesUiE2eCfg.triage_max_attempts : 2;
  const failFast            = stagesUiE2eCfg.fail_fast === true;
  const stageTimeoutMs      = ((config.timeouts && config.timeouts.stages && config.timeouts.stages.ui_e2e_s) || 1800) * 1000;

  log.info('stage_start', `ui_e2e stage 场景执行开始，共 ${scenarioQueue.length} 个场景（executor=${useSdkScenarios ? 'sdk' : 'runner'}）`, {
    run_id:             runId,
    stage:              'ui_e2e',
    project:            projectRoot,
    scenario_total:     scenarioQueue.length,
    effective_parallel: effectiveParallel,
    executor:           useSdkScenarios ? 'sdk' : 'runner',
  });

  // ── 10. 写 running 状态骨架 ───────────────────────────────────────
  const session = log.datetime;
  const hashNew = scenarioQueue.length > 0 ? computeScenarioBundleHash(stages, scenarioQueue) : null;

  stages.stages        = stages.stages || {};
  stages.stages.ui_e2e = {
    status:     'running',
    started_at: startedAtStr,
    inputs: {
      scenario_bundle_hash: hashNew,
      scenario_files: Object.fromEntries(
        [...new Set(scenarioQueue.map(sc => sc.feature_id))].map(fid => [
          fid,
          path.join(projectRoot, 'docs', 'ui-scenarios', `${fid}.scenarios.yaml`),
        ])
      ),
      deployment_urls: (deployStg && deployStg.outputs && deployStg.outputs.deployment_urls) || {},
    },
    outputs: {
      overall: null,
      total_scenarios:   scenarioQueue.length,
      passed_scenarios:  0,
      failed_scenarios:  0,
      skipped_scenarios: 0,
      blocked_features:  [],
      repair_chain_triggered: false,
      repair_chain_status: null,
      duration_ms:  null,
      timed_out:    false,
      timeout_reason: null,
    },
    scenarios:  Object.fromEntries(scenarioQueue.map(sc => [sc.scenario_id, {
      feature_id:  sc.feature_id,
      status:      'pending',
      started_at:  null,
      completed_at: null,
      duration_ms: null,
      screenshot_paths: [],
      error: null,
    }])),
    validation: {
      passed: false,
      checked_at: null,
      summary: null,
      required_files: [],
      missing_required_fields: [],
      warnings: [],
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
  stages.pipeline             = stages.pipeline || {};
  stages.pipeline.updated_at  = formatLocalTimeShort();
  stages.pipeline.current_stage = 'ui_e2e';
  writeStagesJson(stages);

  // ── 11. MCP / 驱动预检 ────────────────────────────────────────────
  resetMobileSessions();

  const sampleWeb = scenarioQueue.find((s) => s.mcp === 'browser');
  const mobileScenarios = scenarioQueue.filter((s) => s.mcp === 'dart');
  const browserPf = await preflightBrowser(config, sampleWeb || null);
  const dartPf = await preflightDart(config, projectRoot);
  log.info('mcp_preflight', `[ui_e2e] Browser 预检 driver=${browserPf.driver || 'n/a'}`, browserPf);
  log.info('mcp_preflight', `[ui_e2e] Dart 预检 driver=${dartPf.driver || 'n/a'}`, dartPf);

  if (mobileScenarios.length > 0 && dartPf.ok) {
    const devCheck = await ensureDevicesForScenarios(projectRoot, config, mobileScenarios);
    for (const [plat, dev] of Object.entries(devCheck)) {
      log.info('mcp_preflight', `[ui_e2e] ${plat} 设备预检 ok=${dev.ok}`, {
        mcp: 'dart',
        platform: plat,
        ok: dev.ok,
        reason: dev.error || dev.deviceId || 'ok',
      });
    }
  }

  if (!browserPf.ok && !useSdkScenarios) {
    log.error('stage_failed', `Browser 驱动不可用：${browserPf.reason}`, {
      stage: 'ui_e2e',
      exit_code: 1,
      reason: browserPf.reason,
    });
    stages.stages.ui_e2e.status = 'failed';
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    releasePidLock();
    process.exit(1);
  }

  if (
    mobileScenarios.length > 0 &&
    !dartPf.ok &&
    !useSdkScenarios &&
    getUiE2eCfg(config).strict_mobile === true
  ) {
    log.error('stage_failed', `Dart/mobile 预检失败：${dartPf.reason}`, {
      stage: 'ui_e2e',
      exit_code: 1,
      reason: dartPf.reason,
    });
    stages.stages.ui_e2e.status = 'failed';
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    releasePidLock();
    process.exit(1);
  }

  // ── 12. 场景并行执行 ──────────────────────────────────────────────
  let stopFast = false;
  const scenarioResultsMap = {}; // scenario_id → result

  // 续跑：跳过已 completed/skipped 的场景
  const pendingScenarios = scenarioQueue.filter(sc => {
    const existing = stages.stages.ui_e2e.scenarios[sc.scenario_id];
    if (existing && ['completed', 'skipped'].includes(existing.status)) {
      log.info('ui_scenario_skipped', `[ui_e2e] scenario=${sc.scenario_id} 已通过，续跑跳过`, {
        scenario_id: sc.scenario_id, reason: 'already_completed',
      });
      scenarioResultsMap[sc.scenario_id] = { ...existing, scenario_id: sc.scenario_id, feature_id: sc.feature_id, platform: sc.platform };
      return false;
    }
    return true;
  });

  const stageDeadline = startedAt + stageTimeoutMs;

  await runWithConcurrency(
    pendingScenarios,
    effectiveParallel,
    async (sc) => {
      // stop.signal 检查点（每个场景前）
      if (getStopReason() !== null) {
        stopFast = true;
        return;
      }
      if (stopFast) return;

      const result = await runScenario({ sc, config, stages, datetime: log.datetime });
      scenarioResultsMap[sc.scenario_id] = result;

      // 更新 stages.json 中的场景状态
      stages = readStagesJson() || stages;
      if (!stages.stages.ui_e2e.scenarios) stages.stages.ui_e2e.scenarios = {};
      stages.stages.ui_e2e.scenarios[sc.scenario_id] = {
        feature_id:       result.feature_id,
        status:           result.status,
        started_at:       result.started_at || null,
        completed_at:     result.completed_at || null,
        duration_ms:      result.duration_ms || null,
        screenshot_paths: result.snapshot_paths || [],
        error:            result.failure_summary || null,
      };
      stages.pipeline = stages.pipeline || {};
      stages.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stages);

      // fail_fast 检查
      if (failFast && (result.status === 'failed' || result.status === 'timed_out')) {
        stopFast = true;
      }
    },
    () => stopFast || Date.now() > stageDeadline
  );

  // 检查是否由 stop.signal 导致的终止
  const stopAfterScenarios = getStopReason();
  if (stopAfterScenarios !== null && !stopFast) {
    log.info('pipeline_stop', '检测到 stop.signal，ui_e2e stage 在场景执行中途停止', {
      stage: 'ui_e2e', reason: stopAfterScenarios,
    });
    stages.stages.ui_e2e.status = 'stopped';
    stages.pipeline.updated_at  = formatLocalTimeShort();
    writeStagesJson(stages);
    releasePidLock();
    process.exit(5);
  }

  // ── 13. 汇总首轮结果 ──────────────────────────────────────────────
  const allResults = [
    ...Object.values(scenarioResultsMap),
    ...scenarioQueue
      .filter(sc => !scenarioResultsMap[sc.scenario_id])
      .map(sc => ({ scenario_id: sc.scenario_id, feature_id: sc.feature_id, platform: sc.platform, status: 'skipped', passed: false })),
  ];

  function countByStatus(list, ...statuses) {
    return list.filter(r => statuses.includes(r.status)).length;
  }

  let passedCount  = countByStatus(allResults, 'completed');
  let failedCount  = countByStatus(allResults, 'failed', 'timed_out');
  let skippedCount = countByStatus(allResults, 'skipped');
  const timedOutAny = allResults.some(r => r.status === 'timed_out');

  // 生成报告
  const reportDir = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `ui-e2e-${session}.md`);
  fs.writeFileSync(reportPath, generateReport({
    scenarioResults: allResults,
    session,
    startedAt,
    completedAt: Date.now(),
  }), 'utf8');

  // ── 14. 失败分诊与修复子链 ────────────────────────────────────────
  let blockedFeatures     = [];
  let repairedFeatures    = [];
  let repairChainTriggered = false;
  let repairChainStatus   = null;
  let finalExitCode       = 0;

  if (failedCount > 0 && !skipRepairChain) {
    // 按 feature 聚合失败场景
    const failedByFeature = {};
    for (const r of allResults) {
      if (r.status === 'failed' || r.status === 'timed_out') {
        if (!failedByFeature[r.feature_id]) failedByFeature[r.feature_id] = [];
        failedByFeature[r.feature_id].push(r);
      }
    }

    for (const [featureId, failedScenarios] of Object.entries(failedByFeature)) {
      let triageAttempt  = 0;
      let featureBlocked = false;
      let featureFixed   = false;

      while (triageAttempt < triageMaxAttempts && !featureBlocked && !featureFixed) {
        triageAttempt++;

        // stop.signal 检查（分诊前）
        if (getStopReason() !== null) {
          stages.stages.ui_e2e.status = 'stopped';
          stages.pipeline.updated_at  = formatLocalTimeShort();
          writeStagesJson(stages);
          releasePidLock();
          process.exit(5);
        }

        const triage = await runTriageAgent({
          featureId,
          failedScenarioResults: failedScenarios,
          stages,
          session,
          attempt: triageAttempt,
        });

        if (triage.decision === 'blocked') {
          log.error('ui_e2e_blocked', `[ui_e2e] feature=${featureId} blocked — ${triage.reason}`, {
            feature_id: featureId,
            reason:     triage.reason,
            exit_code:  9,
          });
          blockedFeatures.push({ feature_id: featureId, reason: triage.reason, user_actions: triage.user_actions || [] });
          featureBlocked = true;

        } else if (triage.decision === 'fix_prompt') {
          const pub = publishFixPrompt({ featureId, triage });
          if (!pub.ok) {
            log.error('prompt_publish_failed', `[ui_e2e] feature=${featureId} fix_prompt 未生效：${pub.error || 'push 失败'}`, {
              feature_id: featureId,
              files:      triage.prompt_files || [],
              skill_commit: pub.commit || null,
            });
          } else {
            const { stillFailed } = await rerunFailedScenariosForFeature({
              featureId,
              failedScenarios,
              scenarioQueue,
              config,
              stages,
              scenarioResultsMap,
            });
            if (stillFailed.length === 0) featureFixed = true;
            else {
              failedScenarios.splice(
                0,
                failedScenarios.length,
                ...stillFailed.map((sc) => scenarioResultsMap[sc.scenario_id])
              );
            }
          }

        } else if (triage.decision === 'fix_code' || triage.decision === 'fix_both') {
          if (triage.decision === 'fix_both') {
            const pub = publishFixPrompt({ featureId, triage });
            if (!pub.ok) {
              log.error('prompt_publish_failed', `[ui_e2e] feature=${featureId} fix_both 提示词 push 失败`, {
                feature_id: featureId,
                files: triage.prompt_files || [],
              });
            } else {
              await rerunFailedScenariosForFeature({
                featureId,
                failedScenarios,
                scenarioQueue,
                config,
                stages,
                scenarioResultsMap,
              });
            }
          }

          repairChainTriggered = true;
          stages.stages.ui_e2e.outputs.repair_chain_triggered = true;
          stages.stages.ui_e2e.outputs.repair_state           = 'repairing';
          writeStagesJson(stages);

          const chainResult = runRepairChain({ featureId, stages });
          repairChainStatus = chainResult.success ? 'completed' : 'failed';
          stages.stages.ui_e2e.outputs.repair_chain_status = repairChainStatus;
          writeStagesJson(stages);

          if (chainResult.success) {
            repairedFeatures.push(featureId);
            featureFixed = true;
          } else {
            // 子链失败 → 继续分诊循环（已耗费一次分诊次数）
          }

        } else if (triage.decision === 'fix_scenario') {
          log.warn('ui_e2e_triage_complete', `[ui_e2e] feature=${featureId} fix_scenario，需回 create-ui-scenarios`, {
            feature_id: featureId,
            decision:   'fix_scenario',
          });
          blockedFeatures.push({
            feature_id: featureId,
            reason: 'fix_scenario: YAML 错误，请重跑 --from-stage=create-ui-scenarios',
            user_actions: [`--from-stage=create-ui-scenarios --feature=${featureId}`],
          });
          featureBlocked = true;

        } else {
          // 未知 decision → blocked
          blockedFeatures.push({ feature_id: featureId, reason: `未知 decision: ${triage.decision}` });
          featureBlocked = true;
        }
      }

      // 分诊次数用尽仍未修复
      if (!featureFixed && !featureBlocked) {
        log.error('stage_failed', `[ui_e2e] feature=${featureId} 分诊次数（${triageMaxAttempts}）用尽仍失败`, {
          feature_id: featureId, triage_attempts: triageAttempt,
        });
      }
    }
  }

  // ── 15. 最终汇总 ──────────────────────────────────────────────────
  const completedAt    = Date.now();
  const completedAtStr = formatLocalTimeShort(new Date(completedAt));
  const durMs          = completedAt - startedAt;

  // 重新统计（含修复后重跑结果）
  const finalResults = [
    ...Object.values(scenarioResultsMap),
    ...scenarioQueue
      .filter(sc => !scenarioResultsMap[sc.scenario_id])
      .map(sc => ({ scenario_id: sc.scenario_id, feature_id: sc.feature_id, platform: sc.platform, status: 'skipped', passed: false })),
  ];
  passedCount  = countByStatus(finalResults, 'completed');
  failedCount  = countByStatus(finalResults, 'failed', 'timed_out');
  skippedCount = countByStatus(finalResults, 'skipped');

  const hasBlocked  = blockedFeatures.length > 0;
  const overallStatus = failedCount === 0 && !hasBlocked
    ? 'passed'
    : hasBlocked
      ? 'blocked'
      : 'failed';

  // 最终退出码
  if (hasBlocked) {
    finalExitCode = 9;
  } else if (failedCount > 0) {
    finalExitCode = timedOutAny && failedCount === 0 ? 3 : 4;
  } else {
    finalExitCode = 0;
  }

  // 更新报告
  fs.writeFileSync(reportPath, generateReport({
    scenarioResults: finalResults,
    session,
    startedAt,
    completedAt,
  }), 'utf8');

  // 更新 stages.json
  stages = readStagesJson() || stages;
  stages.stages.ui_e2e.status       = finalExitCode === 0 ? 'completed' : 'failed';
  stages.stages.ui_e2e.completed_at = completedAtStr;
  stages.stages.ui_e2e.outputs      = Object.assign(stages.stages.ui_e2e.outputs || {}, {
    overall:               overallStatus,
    total_scenarios:       finalResults.length,
    passed_scenarios:      passedCount,
    failed_scenarios:      failedCount,
    skipped_scenarios:     skippedCount,
    blocked_features:      blockedFeatures,
    repair_chain_triggered: repairChainTriggered,
    repair_chain_status:   repairChainStatus,
    repaired_features:     repairedFeatures,
    duration_ms:           durMs,
    timed_out:             timedOutAny,
    timeout_reason:        timedOutAny ? 'scenario_timed_out' : null,
    report_path:           reportPath,
    repair_state:          null,
    triage_attempts:       0,
  });

  stages.stages.ui_e2e.validation = {
    passed:                  finalExitCode === 0,
    checked_at:              completedAtStr,
    summary:                 finalExitCode === 0 ? null : `ui_e2e 失败，退出码 ${finalExitCode}，failed=${failedCount}，blocked=${blockedFeatures.length}`,
    required_files:          [],
    missing_required_fields: [],
    warnings:                [],
  };

  if (finalExitCode !== 0) {
    stages.stages.ui_e2e.blocking_issues = [
      ...(hasBlocked ? blockedFeatures.map(b => `blocked: ${b.feature_id}`) : []),
      ...(failedCount > 0 ? [`failed_scenarios=${failedCount}`] : []),
    ];
  }

  stages.stages.ui_e2e.generated_files = [reportPath];

  stages.pipeline             = stages.pipeline || {};
  stages.pipeline.updated_at  = completedAtStr;
  if (finalExitCode === 0) stages.pipeline.last_completed_stage = 'ui_e2e';
  writeStagesJson(stages);
  releasePidLock();

  // ── 16. 最终日志与退出 ────────────────────────────────────────────
  if (finalExitCode === 0) {
    log.info('validation_pass', 'ui_e2e 校验通过', {
      passed:   passedCount,
      skipped:  skippedCount,
      warnings: [],
    });
    log.info('stage_complete', `ui_e2e stage 完成，耗时 ${durMs}ms`, {
      stage:      'ui_e2e',
      exit_code:  0,
      duration_ms: durMs,
      passed_scenarios: passedCount,
      total_scenarios:  finalResults.length,
    });
    process.exit(0);
  }

  if (hasBlocked) {
    log.error('stage_failed', `ui_e2e stage blocked，需人工介入，退出码 9`, {
      stage:            'ui_e2e',
      exit_code:        9,
      blocked_features: blockedFeatures.map(b => b.feature_id),
      duration_ms:      durMs,
    });
    process.exit(9);
  }

  // 退出码 3：仅当所有失败场景都是超时导致的（无其它类型失败）
  const timedOutCount  = countByStatus(finalResults, 'timed_out');
  const plainFailCount = countByStatus(finalResults, 'failed');
  const actualExitCode = (timedOutCount > 0 && plainFailCount === 0) ? 3 : 4;
  log.error('stage_failed', `ui_e2e stage 失败，退出码 ${actualExitCode}，failed=${failedCount}，耗时 ${durMs}ms`, {
    stage:           'ui_e2e',
    exit_code:       actualExitCode,
    failed_scenarios: failedCount,
    duration_ms:     durMs,
  });
  process.exit(actualExitCode);
}

main().catch(err => {
  console.error(`[FATAL] ui-e2e.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  releasePidLock();
  process.exit(1);
});

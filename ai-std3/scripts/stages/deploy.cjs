'use strict';

/**
 * deploy.cjs — deploy stage
 *
 * 职责：在 build 产出就绪后，将各端部署到 Cloudflare（Pages / Workers）。
 * 内联 smoke 测试在每个 service 部署完成后执行。
 * 失败时调用 Agent 分诊（deploy-triage），按 decision 执行 fix_script / retry_deploy / blocked。
 *
 * 参数：
 *   --project=<路径>       业务项目根（绝对或相对），默认 AI_STD3_PROJECT 或 cwd
 *   --run-id=<id>          run_id（由 run-pipeline 传入）
 *   --explicit-confirm     跳过 destructive 保护确认
 *   --force-rerun=deploy   强制重新部署（跳过 hash 门控）
 *   --config=dev|release   选择 config 文件，默认 dev
 *
 * 退出码：
 *   0  全部 service 部署 + smoke 通过（或整段 skipped）
 *   1  门闸未满足 / destructive 未确认 / 凭证缺失 / PID 锁占用
 *   3  超时
 *   4  smoke 失败 / fix_script 用尽
 *   5  stop.signal
 *   8  云 API 错误，retry_deploy 用尽，但未判定须人工阻断
 *   9  Agent 判定 blocked（须人工介入）
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const http   = require('http');
const https  = require('https');
const { spawnSync } = require('child_process');

const { createLogger, formatLocalTimeShort } = require('../libs/logger.cjs');
const {
  loadProjectEnv,
  getSkillsRoot,
  resolvePipelineModel,
  readConfigJson: readProjectConfigJson,
} = require('../libs/pipeline-config.cjs');
const {
  RESOURCE_TYPES,
  isResourceService,
  shouldProvisionResource,
  persistServiceResourceConfig,
} = require('../libs/infer-deploy-services.cjs');
const { provisionCloudflareResource } = require('../libs/cloudflare-provision.cjs');
const {
  findWranglerTomlPath,
  applyWranglerBindings,
  sortDeployServices,
} = require('../libs/wrangler-bindings.cjs');
const { invokeSdkAgent } = require('../libs/invoke-sdk-agent.cjs');

// ── 解析参数 ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || true];
    })
);

const projectRoot    = args.project
  ? path.resolve(args.project)
  : process.env.AI_STD3_PROJECT
    ? path.resolve(process.env.AI_STD3_PROJECT)
    : process.cwd();

const runId          = args['run-id'] || null;
const explicitConfirm = args['explicit-confirm'] === true || args['explicit-confirm'] === 'true';
const forceRerun     = args['force-rerun'] === 'deploy' || args['force-rerun'] === true;
const configName     = (args.config === 'release') ? 'release' : 'dev';

// ── 初始化 Logger ─────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'deploy', runId });

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

// ── config 读取 ───────────────────────────────────────────────────
function readDeployConfigJson() {
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

// ── PID 锁 ────────────────────────────────────────────────────────
const locksDir    = path.join(projectRoot, '.pipeline', 'locks');
const pidLockPath = path.join(locksDir, 'deploy.pid');

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

// ── stop.signal 检查 ──────────────────────────────────────────────
const stopSignalPath = path.join(projectRoot, '.pipeline', 'stop.signal');

function getStopReason() {
  if (!fs.existsSync(stopSignalPath)) return null;
  try { return JSON.parse(fs.readFileSync(stopSignalPath, 'utf8')).reason || 'unknown'; }
  catch (_) { return 'unknown'; }
}

// ── 无可部署端判定 ────────────────────────────────────────────────
const DEPLOYABLE_TARGETS = new Set(['website', 'admin', 'backend']);

function hasDeployableTargets(stages, config) {
  // 1. stages.prd.outputs.client_targets 含 website/admin/backend
  const prdTargets = stages.stages &&
                     stages.stages.prd &&
                     stages.stages.prd.outputs &&
                     stages.stages.prd.outputs.client_targets;
  if (Array.isArray(prdTargets) && prdTargets.some(t => DEPLOYABLE_TARGETS.has(t))) return true;

  // 2. 项目根存在 src/website/ src/admin/ src/backend/
  for (const t of DEPLOYABLE_TARGETS) {
    if (fs.existsSync(path.join(projectRoot, 'src', t))) return true;
  }

  // 3. deploy.services[] 含可部署端
  const services = config.deploy && config.deploy.services;
  if (Array.isArray(services) && services.some(s => DEPLOYABLE_TARGETS.has(s.client_target))) return true;

  // 4. build.inputs.client_targets 含可部署端
  const buildTargets = stages.stages &&
                       stages.stages.build &&
                       stages.stages.build.inputs &&
                       stages.stages.build.inputs.client_targets;
  if (Array.isArray(buildTargets) && buildTargets.some(t => DEPLOYABLE_TARGETS.has(t))) return true;

  return false;
}

// ── summary_hash 计算 ─────────────────────────────────────────────
function computeSummaryHash(stages, config) {
  const buildSummaryHash = stages.stages &&
                           stages.stages.build &&
                           stages.stages.build.inputs &&
                           stages.stages.build.inputs.summary_hash;
  const deployCfg = config.deploy || {};
  const payload = {
    build_summary_hash: buildSummaryHash || null,
    provider:           deployCfg.provider || null,
    services:           (deployCfg.services || []).map(s => ({
      name:          s.name,
      client_target: s.client_target,
      type:          s.type,
    })),
    fail_fast:          deployCfg.fail_fast !== false,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ── artifact 路径解析 ─────────────────────────────────────────────
function resolveArtifactPath(service, stages) {
  const buildResults = stages.stages &&
                       stages.stages.build &&
                       stages.stages.build.outputs &&
                       stages.stages.build.outputs.build_results;

  if (!buildResults) return null;

  const target = service.client_target;
  const subPlatform = service.sub_platform || 'default';
  const key = subPlatform === 'default' ? target : `${target}:${subPlatform}`;

  const result = buildResults[key] || buildResults[target];
  if (!result || (result.status !== 'success' && result.status !== 'completed')) return null;
  return result.artifact_path || null;
}

// ── 凭证预检 ─────────────────────────────────────────────────────
function checkCloudflareCredentials(envVars) {
  const token = envVars.CLOUDFLARE_API_TOKEN || envVars.CF_API_TOKEN ||
                process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const accountId = envVars.CLOUDFLARE_ACCOUNT_ID || envVars.CF_ACCOUNT_ID ||
                    process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;

  if (!token) return { ok: false, reason: 'missing_secret', missing: 'CLOUDFLARE_API_TOKEN' };
  if (!accountId) return { ok: false, reason: 'missing_secret', missing: 'CLOUDFLARE_ACCOUNT_ID' };

  return { ok: true, token, accountId };
}

// ── Cloudflare API 调用工具 ───────────────────────────────────────
function cfApiCall({ method, path: apiPath, body, token, accountId, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const startMs = Date.now();

    const options = {
      hostname: 'api.cloudflare.com',
      port:     443,
      path:     `/client/v4${apiPath}`,
      method:   method || 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const durationMs = Date.now() - startMs;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, raw: data, durationMs });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('CF API request timed out'));
    });

    req.on('error', err => reject(err));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Cloudflare Pages 部署 ─────────────────────────────────────────
async function deployPages({ service, artifactPath, token, accountId, stageLogPath }) {
  const projectName = service.name || service.client_target;

  log.info('deploy_api_call', `[deploy] CF Pages：确认项目 ${projectName}`, {
    method: 'GET', path: `/accounts/${accountId}/pages/projects/${projectName}`,
    service_name: service.name,
  });

  // 检查/创建 Pages 项目
  const checkRes = await cfApiCall({
    method: 'GET',
    path:   `/accounts/${accountId}/pages/projects/${projectName}`,
    token, accountId,
  });

  log.info('deploy_api_call', `CF Pages 项目检查`, {
    method: 'GET',
    path:   `/accounts/${accountId}/pages/projects/${projectName}`,
    status: checkRes.status,
    duration_ms: checkRes.durationMs,
    success: checkRes.status === 200,
    error_summary: checkRes.status !== 200
      ? (checkRes.body && checkRes.body.errors && checkRes.body.errors[0] && checkRes.body.errors[0].message) || `HTTP ${checkRes.status}`
      : null,
  });

  if (checkRes.status !== 200) {
    // 尝试创建项目
    log.info('deploy_api_call', `CF Pages 创建项目 ${projectName}`, {
      method: 'POST', path: `/accounts/${accountId}/pages/projects`,
    });
    const createRes = await cfApiCall({
      method: 'POST',
      path:   `/accounts/${accountId}/pages/projects`,
      body:   { name: projectName, production_branch: 'main' },
      token, accountId,
    });
    log.info('deploy_api_call', `CF Pages 项目创建结果`, {
      method: 'POST',
      path:   `/accounts/${accountId}/pages/projects`,
      status: createRes.status,
      duration_ms: createRes.durationMs,
      success: createRes.status === 200 || createRes.status === 201,
      error_summary: (createRes.status !== 200 && createRes.status !== 201)
        ? (createRes.body && createRes.body.errors && createRes.body.errors[0] && createRes.body.errors[0].message) || `HTTP ${createRes.status}`
        : null,
    });

    if (createRes.status !== 200 && createRes.status !== 201) {
      const errMsg = (createRes.body && createRes.body.errors && createRes.body.errors[0] && createRes.body.errors[0].message) || `HTTP ${createRes.status}`;
      throw Object.assign(new Error(`CF Pages 创建项目失败：${errMsg}`), {
        httpStatus: createRes.status,
        apiErrors:  (createRes.body && createRes.body.errors || []).map(e => e.message),
        cfCode:     createRes.body && createRes.body.errors && createRes.body.errors[0] && createRes.body.errors[0].code,
      });
    }
  }

  // 使用 wrangler 部署（npx wrangler pages deploy）
  log.info('deploy_service_start', `[deploy] service=${service.name} 执行 wrangler pages deploy`, {
    service_name:  service.name,
    client_target: service.client_target,
    type:          'pages',
    artifact_path: artifactPath,
  });

  const artPath = artifactPath || '.';
  const wranglerArgs = ['wrangler', 'pages', 'deploy', artPath, `--project-name=${projectName}`];
  if (service.domain) wranglerArgs.push(`--branch=production`);

  const wResult = spawnSync('npx', wranglerArgs, {
    cwd:      projectRoot,
    encoding: 'utf8',
    timeout:  280000,
    env:      { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
    stdio:    ['ignore', 'pipe', 'pipe'],
  });

  if (stageLogPath) {
    try { fs.appendFileSync(stageLogPath, `[wrangler pages deploy]\nSTDOUT:\n${wResult.stdout}\nSTDERR:\n${wResult.stderr}\n`); } catch (_) {}
  }

  if (wResult.status !== 0) {
    const errMsg = (wResult.stderr || wResult.stdout || '').slice(-500);
    throw Object.assign(new Error(`wrangler pages deploy 失败（exit ${wResult.status}）：${errMsg}`), {
      httpStatus: null,
      apiErrors:  [errMsg],
      cfCode:     null,
      wranglerExit: wResult.status,
    });
  }

  // 从 stdout 提取部署 URL
  const urlMatch = (wResult.stdout || '').match(/https?:\/\/[^\s\n]+\.pages\.dev[^\s\n]*/);
  const deployUrl = urlMatch ? urlMatch[0].trim() : `https://${projectName}.pages.dev`;
  return { url: deployUrl };
}

// ── Cloudflare Workers 部署 ───────────────────────────────────────
async function deployWorkers({ service, artifactPath, token, accountId, stageLogPath }) {
  log.info('deploy_service_start', `[deploy] service=${service.name} 执行 wrangler deploy`, {
    service_name:  service.name,
    client_target: service.client_target,
    type:          'workers',
    artifact_path: artifactPath || '.',
  });

  const wResult = spawnSync('npx', ['wrangler', 'deploy'], {
    cwd:     artifactPath ? path.dirname(artifactPath) : projectRoot,
    encoding: 'utf8',
    timeout: 280000,
    env:     { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
    stdio:   ['ignore', 'pipe', 'pipe'],
  });

  if (stageLogPath) {
    try { fs.appendFileSync(stageLogPath, `[wrangler deploy]\nSTDOUT:\n${wResult.stdout}\nSTDERR:\n${wResult.stderr}\n`); } catch (_) {}
  }

  if (wResult.status !== 0) {
    const errMsg = (wResult.stderr || wResult.stdout || '').slice(-500);
    throw Object.assign(new Error(`wrangler deploy 失败（exit ${wResult.status}）：${errMsg}`), {
      httpStatus: null,
      apiErrors:  [errMsg],
      cfCode:     null,
      wranglerExit: wResult.status,
    });
  }

  const urlMatch = (wResult.stdout || '').match(/https?:\/\/[^\s\n]+\.workers\.dev[^\s\n]*/);
  const deployUrl = urlMatch ? urlMatch[0].trim() : (service.domain ? `https://${service.domain}` : null);
  return { url: deployUrl };
}

// ── 内联 Smoke 测试 ───────────────────────────────────────────────
function httpRequest(url, { method = 'GET', timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const startMs = Date.now();

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { 'User-Agent': 'ai-std3-smoke/1.0' },
    };

    const req = mod.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data, durationMs: Date.now() - startMs });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('smoke request timed out')));
    req.on('error', err => reject(err));
    req.end();
  });
}

function resolveSmokeUrl(rawUrl, deployedUrls) {
  // 替换占位符 {deploy.services.<name>.url} 或 {deploy.services.<client_target>.url}
  return rawUrl.replace(/\{deploy\.services\.([^}]+)\.url\}/g, (_, name) => {
    return deployedUrls[name] || rawUrl;
  });
}

async function runSmokeChecks({ service, deployedUrl, smokeConfig, deployedUrls, timeoutMs }) {
  const checks  = (smokeConfig && smokeConfig.checks) || [];
  const results = [];

  // 筛选与本 service 相关的检查
  const relevant = checks.filter(c => {
    if (c.scope === 'codegen') return false;
    const targets = c.client_targets;
    if (targets && !targets.includes(service.client_target)) return false;
    return true;
  });

  if (relevant.length === 0) return { passed: true, failures: [], results: [] };

  for (const check of relevant) {
    let url = check.url || null;
    if (!url && check.path) {
      url = `${deployedUrl}${check.path.startsWith('/') ? '' : '/'}${check.path}`;
    }
    if (!url) continue;

    url = resolveSmokeUrl(url, { ...deployedUrls, [service.name]: deployedUrl, [service.client_target]: deployedUrl });

    const expectedStatus = check.expected_status || 200;
    const method         = check.method || 'GET';
    let passed = false;
    let error  = null;

    try {
      const res = await httpRequest(url, { method, timeoutMs });
      if (res.status === expectedStatus) {
        if (check.body_contains && !res.body.includes(check.body_contains)) {
          passed = false;
          error  = `body 未包含 "${check.body_contains}"`;
        } else {
          passed = true;
        }
      } else {
        error = `HTTP ${res.status}，期望 ${expectedStatus}`;
      }
    } catch (e) {
      error = e.message;
    }

    results.push({ url, method, expected_status: expectedStatus, passed, error });
  }

  const failures = results.filter(r => !r.passed);
  return { passed: failures.length === 0, failures, results };
}

// ── 写入错误包 ────────────────────────────────────────────────────
function writeLastError({ service, provider, httpStatus, apiErrors, stderrTail, stageLogPath, config }) {
  const errorPath = path.join(projectRoot, '.pipeline', 'deploy-last-error.json');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';
  const redacted = {
    account_id: accountId ? accountId.slice(0, 4) + '***' : null,
    domain:     service.domain || null,
  };
  const errObj = {
    failed_at:     formatLocalTimeShort(),
    service:       { name: service.name, client_target: service.client_target, type: service.type },
    provider:      provider || 'cloudflare',
    http_status:   httpStatus || null,
    api_errors:    apiErrors || [],
    stderr_tail:   stderrTail || '',
    deploy_log_path: stageLogPath || null,
    config_redacted: redacted,
  };
  fs.writeFileSync(errorPath, JSON.stringify(errObj, null, 2) + '\n', 'utf8');
  return errorPath;
}

// ── 失败分诊（SDK Agent）──────────────────────────────────────────
async function runTriageAgent({ attempt }) {
  const skillsRoot   = getSkillsRoot();
  const triageOutPath = path.join(projectRoot, '.pipeline', 'deploy-triage.json');
  const lastErrPath   = path.join(projectRoot, '.pipeline', 'deploy-last-error.json');

  log.info('deploy_triage_start', `[deploy] 启动分诊 SDK Agent，attempt=${attempt}`, {
    agent_id: 'deploy-triage',
    attempt,
  });

  const cfg   = readProjectConfigJson(projectRoot, configName);
  const model = resolvePipelineModel(cfg);

  const result = await invokeSdkAgent({
    skillsRoot,
    projectRoot,
    promptFile:   'deploy-triage.md',
    agentId:      'deploy-triage',
    cwd:          getSkillsRoot(),
    model,
    timeoutMs:    120000,
    log,
    artifactPath: triageOutPath,
    inject: {
      deploy_last_error: lastErrPath,
      attempt:           String(attempt),
    },
  });

  let triage = result.artifact;
  if (!triage) {
    log.error('deploy_triage_complete', '[deploy] 分诊未产出有效 JSON，退化 blocked', {
      error: result.error,
    });
    triage = {
      decision:     'blocked',
      category:     'unknown',
      reason:       result.error || '分诊 Agent 未产出 deploy-triage.json',
      evidence:     [],
      patch_hints:  [],
      user_actions: ['查看 .pipeline/deploy-last-error.json 与 logs/stages/deploy/'],
    };
    fs.writeFileSync(triageOutPath, JSON.stringify(triage, null, 2) + '\n', 'utf8');
  }

  log.info('deploy_triage_complete', `[deploy] 分诊完成：decision=${triage.decision}，category=${triage.category}`, {
    decision: triage.decision,
    category: triage.category,
    reason:   triage.reason,
  });

  return triage;
}

// ── 生成部署报告 ──────────────────────────────────────────────────
function generateDeployReport({ services, inlineSmokeFailures, inlineSmokePassed, startedAt, completedAt }) {
  const durMs  = completedAt - startedAt;
  const durSec = (durMs / 1000).toFixed(1);

  const lines = [
    '# Deploy Summary',
    '',
    '## 摘要',
    '',
    `| 项目 | 值 |`,
    `| --- | --- |`,
    `| 总耗时 | ${durSec}s |`,
    `| smoke 通过 | ${inlineSmokePassed ? '✅' : '❌'} |`,
    `| 报告时间 | ${formatLocalTimeShort(new Date(completedAt))} |`,
    '',
    '## 部署结果',
    '',
    '| service | client_target | type | status | url | smoke | 耗时 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const s of services) {
    const statusMark = s.status === 'completed' ? '✅' : (s.status === 'failed' ? '❌' : '⏭');
    const smokeMark  = s.smoke_passed === true ? '✅' : (s.smoke_passed === false ? '❌' : '-');
    const dur        = s.duration_ms != null ? `${(s.duration_ms / 1000).toFixed(1)}s` : '-';
    lines.push(`| ${s.name} | ${s.client_target} | ${s.type || '-'} | ${statusMark} ${s.status} | ${s.url || '-'} | ${smokeMark} | ${dur} |`);
  }

  if (inlineSmokeFailures.length > 0) {
    lines.push('', '## Smoke 失败详情', '');
    for (const f of inlineSmokeFailures) {
      lines.push(`- **${f.service}** → ${f.url}: ${f.error}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = Date.now();
  const startedAtStr = formatLocalTimeShort(new Date(startedAt));

  log.info('stage_start', `deploy stage 启动，项目: ${projectRoot}`, {
    run_id:     runId,
    stage:      'deploy',
    project:    projectRoot,
    started_at: startedAtStr,
  });

  loadProjectEnv(projectRoot);

  // ── 1. 读 stages.json ─────────────────────────────────────────────
  let stages = readStagesJson();
  if (!stages) {
    log.error('stage_failed', 'stages.json 不存在', {
      stage: 'deploy', exit_code: 1, reason: 'stages.json missing', duration_ms: 0,
    });
    process.exit(1);
  }

  // ── 2. 上游门闸：build.status=completed ──────────────────────────
  const buildStage = stages.stages && stages.stages.build;
  if (!buildStage || buildStage.status !== 'completed') {
    log.error('stage_failed',
      `上游门闸未满足：build.status=${buildStage ? buildStage.status : 'missing'}，需要 completed`, {
        stage: 'deploy', exit_code: 1,
        reason: `build.status=${buildStage ? buildStage.status : 'missing'}`,
        duration_ms: 0,
      });
    process.exit(1);
  }

  // ── 3. stop.signal 检查 ───────────────────────────────────────────
  const stopReason = getStopReason();
  if (stopReason !== null) {
    log.info('pipeline_stop', '检测到 stop.signal，deploy stage 停止', {
      stage:      'deploy',
      reason:     stopReason,
      stopped_at: formatLocalTimeShort(),
    });
    stages.stages       = stages.stages || {};
    stages.stages.deploy = Object.assign({}, stages.stages.deploy || {}, { status: 'stopped' });
    stages.pipeline      = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    process.exit(5);
  }

  // ── 4. 读取配置 ───────────────────────────────────────────────────
  const config      = readDeployConfigJson();
  const envVars     = readConfigEnv();
  const deployCfg   = config.deploy || {};
  const pipelineCfg = config.pipeline || {};
  const smokeCfg    = config.smoke || {};

  const agentFixMaxAttempts = (pipelineCfg.stages &&
                               pipelineCfg.stages.deploy &&
                               pipelineCfg.stages.deploy.agent_fix_max_attempts) || 2;
  const deployRetryMax      = (pipelineCfg.stages &&
                               pipelineCfg.stages.deploy &&
                               pipelineCfg.stages.deploy.deploy_retry_max) || 1;
  const failFast            = (pipelineCfg.stages &&
                               pipelineCfg.stages.deploy &&
                               pipelineCfg.stages.deploy.fail_fast) !== false;
  const deployTimeoutMs     = ((config.timeouts &&
                                config.timeouts.stages &&
                                config.timeouts.stages.deploy_s) || 300) * 1000;

  const smokeDeployEnabled  = (smokeCfg.deploy && smokeCfg.deploy.enabled) !== false &&
                              !!(smokeCfg.checks && smokeCfg.checks.length);
  const smokeTimeoutMs      = ((smokeCfg.deploy && smokeCfg.deploy.timeout_s) ||
                               Math.min(120, deployTimeoutMs / 1000 / 3)) * 1000;

  // ── 5. deploy.enabled 检查 ────────────────────────────────────────
  if (deployCfg.enabled === false) {
    log.info('stage_skipped', 'deploy.enabled=false，跳过 deploy', {
      reason: 'deploy.disabled', exit_code: 0,
    });
    stages.stages       = stages.stages || {};
    stages.stages.deploy = Object.assign({}, stages.stages.deploy || {}, {
      status:     'skipped',
      started_at: startedAtStr,
      outputs:    { skip_reason: 'deploy.disabled', inline_smoke_passed: null },
      validation: { passed: true, checked_at: startedAtStr, summary: null,
                    required_files: [], missing_required_fields: [], warnings: [] },
    });
    stages.pipeline = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    process.exit(0);
  }

  // ── 6. 无可部署端检查 ─────────────────────────────────────────────
  if (!hasDeployableTargets(stages, config)) {
    log.info('stage_skipped', '项目无可部署 Web/Admin/Backend 端，跳过 deploy', {
      reason: 'no_deployable_targets', exit_code: 0,
    });
    stages.stages       = stages.stages || {};
    stages.stages.deploy = Object.assign({}, stages.stages.deploy || {}, {
      status:     'skipped',
      started_at: startedAtStr,
      outputs:    { skip_reason: 'no_deployable_targets', inline_smoke_passed: null },
      validation: { passed: true, checked_at: startedAtStr, summary: null,
                    required_files: [], missing_required_fields: [], warnings: [] },
    });
    stages.pipeline = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    process.exit(0);
  }

  // ── 7. Destructive 确认 ───────────────────────────────────────────
  const allowDestructive = (pipelineCfg.autorun && pipelineCfg.autorun.allow_destructive_deploy === true) ||
                           (deployCfg.allow_destructive_deploy === true);

  if (!allowDestructive && !explicitConfirm) {
    log.error('stage_failed',
      'Destructive 保护：需要 allow_destructive_deploy=true 或 --explicit-confirm', {
        stage: 'deploy', exit_code: 1,
        reason: 'destructive_not_confirmed',
        duration_ms: Date.now() - startedAt,
      });
    process.exit(1);
  }

  // ── 8. hash 门控（在凭证检查前，避免不必要的预检）────────────────
  const summaryHashNew = computeSummaryHash(stages, config);

  if (!forceRerun) {
    const deployStageOld = stages.stages && stages.stages.deploy;
    const oldHash        = deployStageOld && deployStageOld.inputs && deployStageOld.inputs.summary_hash;
    if (oldHash &&
        oldHash === summaryHashNew &&
        deployStageOld.status === 'completed' &&
        deployStageOld.validation &&
        deployStageOld.validation.passed === true) {
      log.info('stage_skipped', 'deploy hash 门控命中，跳过执行', {
        reason: 'summary_hash_matched',
        exit_code: 0,
      });
      process.exit(0);
    }
  }

  // ── 9. 凭证预检（仅 Cloudflare，hash 未命中时才检查）─────────────
  const provider = deployCfg.provider || 'cloudflare';

  if (provider === 'cloudflare') {
    const credCheck = checkCloudflareCredentials(envVars);
    if (!credCheck.ok) {
      log.error('stage_failed',
        `Cloudflare 凭证缺失：${credCheck.missing}，退出码 1`, {
          stage: 'deploy', exit_code: 1,
          reason: `missing_secret: ${credCheck.missing}`,
          duration_ms: Date.now() - startedAt,
        });
      process.exit(1);
    }
  } else if (provider !== 'manual') {
    log.error('stage_failed', `provider=${provider} 未实现，仅支持 cloudflare / manual`, {
      stage: 'deploy', exit_code: 1,
      reason: `unsupported_provider: ${provider}`,
      duration_ms: Date.now() - startedAt,
    });
    process.exit(1);
  }

  // ── 10. PID 锁 ────────────────────────────────────────────────────
  const lockResult = acquirePidLock();
  if (!lockResult.ok) {
    log.error('stage_failed',
      `PID 锁被占用（pid=${lockResult.existingPid}），可能有并发 deploy 在运行`, {
        stage: 'deploy', exit_code: 1,
        reason: `pid_lock_occupied: ${lockResult.existingPid}`,
        duration_ms: Date.now() - startedAt,
      });
    process.exit(1);
  }

  process.on('exit', releasePidLock);
  process.on('SIGINT',  () => { releasePidLock(); process.exit(1); });
  process.on('SIGTERM', () => { releasePidLock(); process.exit(1); });

  // ── 11. 初始化骨架 ────────────────────────────────────────────────
  const allServices    = deployCfg.services || [];
  const sortedServices = sortDeployServices(allServices);
  const provisionedBindings = { d1: [], r2: [], kv: [], queues: [], durable_objects: [] };
  const credVars        = provider === 'cloudflare' ? checkCloudflareCredentials(envVars) : {};
  const cfToken         = credVars.token;
  const cfAccountId     = credVars.accountId;

  stages.stages        = stages.stages || {};
  const oldDeployStage = stages.stages.deploy || {};

  const serviceStatuses = {};
  if (oldDeployStage.outputs && oldDeployStage.outputs.services) {
    for (const s of oldDeployStage.outputs.services) {
      serviceStatuses[s.name] = s;
    }
  }

  const serviceSlots = allServices.map(s => ({
    name:          s.name || s.client_target,
    client_target: s.client_target,
    sub_platform:  s.sub_platform || 'default',
    type:          s.type || 'pages',
    status:        'pending',
    url:           null,
    smoke_passed:  null,
    smoke_checks:  [],
    duration_ms:   null,
    ...((serviceStatuses[s.name || s.client_target] &&
         serviceStatuses[s.name || s.client_target].status === 'completed')
      ? serviceStatuses[s.name || s.client_target] : {}),
  }));

  stages.stages.deploy = {
    status:     'running',
    started_at: startedAtStr,
    inputs: {
      summary_hash: summaryHashNew,
      build_artifact_hashes: {},
    },
    outputs: {
      services:               serviceSlots,
      deployed_targets:       [],
      skipped_targets:        [],
      failed_targets:         [],
      deployment_urls:        {},
      inline_smoke_passed:    null,
      inline_smoke_failures:  [],
      blocked_reason:         null,
      user_actions:           [],
      report_path:            null,
      provider,
      environment:            configName,
      deploy_retries:         (oldDeployStage.outputs && oldDeployStage.outputs.deploy_retries) || 0,
      agent_fix_attempts:     (oldDeployStage.outputs && oldDeployStage.outputs.agent_fix_attempts) || 0,
      duration_ms:            null,
      timed_out:              false,
      timeout_reason:         null,
      skip_reason:            null,
    },
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
    git_sync: {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  };

  stages.pipeline             = stages.pipeline || {};
  stages.pipeline.updated_at  = formatLocalTimeShort();
  stages.pipeline.current_stage = 'deploy';
  writeStagesJson(stages);

  // ── 12. 按 service 顺序：云资源 provision → workers/pages 部署 ─────
  const deployedUrls        = {};
  const inlineSmokeFailures = [];
  let   overallFailed       = false;
  let   lastFailedService   = null;
  let   lastError           = null;
  let   timedOut            = false;

  const logDir  = path.join(projectRoot, 'logs', 'stages', 'deploy');
  fs.mkdirSync(logDir, { recursive: true });
  const datetime = log.datetime;

  for (const svc of sortedServices) {
    const svcName     = svc.name || svc.client_target;
    const svcSlotIdx  = stages.stages.deploy.outputs.services.findIndex(s => s.name === svcName);
    const svcSlot     = svcSlotIdx >= 0 ? stages.stages.deploy.outputs.services[svcSlotIdx] : null;

    // 续跑幂等：已成功则跳过
    if (svcSlot && svcSlot.status === 'completed') {
      log.info('deploy_service_skipped', `[deploy] service=${svcName} 已部署完成，跳过`, {
        service_name: svcName,
        reason:       'already_deployed',
      });
      deployedUrls[svcName] = svcSlot.url;
      deployedUrls[svc.client_target] = svcSlot.url;
      continue;
    }

    const svcType      = (svc.type || 'pages').toLowerCase();
    const artifactPath = resolveArtifactPath(svc, stages);
    const serviceLogPath = path.join(logDir, `${datetime}-${svcName}.log`);
    fs.writeFileSync(serviceLogPath, `[deploy] service=${svcName} started at ${formatLocalTimeShort()}\n`, 'utf8');

    const svcStart = Date.now();
    let   deployUrl = null;

    // ── 云资源 provision（d1 / r2 / kv）────────────────────────────
    if (isResourceService(svc)) {
      if (!shouldProvisionResource(svc, configName, deployCfg)) {
        log.info('deploy_provision_skipped', `[deploy] 跳过 provision: ${svcName} status=${svc.status || 'draft'}`, {
          service_name: svcName,
          type:         svcType,
          status:       svc.status,
        });
        if (svcSlotIdx >= 0) {
          stages.stages.deploy.outputs.services[svcSlotIdx].status = 'skipped';
        }
        writeStagesJson(stages);
        continue;
      }

      log.info('deploy_service_start', `[deploy] provision service=${svcName}`, {
        service_name: svcName,
        type:         svcType,
      });

      let timedOutSvc = false;
      try {
        const prov = await Promise.race([
          provisionCloudflareResource({
            service: svc,
            token:   cfToken,
            accountId: cfAccountId,
            projectRoot,
            log,
            stageLogPath: serviceLogPath,
          }),
          new Promise((_, reject) => {
            setTimeout(() => {
              timedOutSvc = true;
              reject(new Error(`provision timeout after ${deployTimeoutMs}ms`));
            }, deployTimeoutMs);
          }),
        ]);

        persistServiceResourceConfig(projectRoot, configName, svcName, {
          resource_config: prov.resource_config,
          status:          'active',
        });

        if (svcType === 'd1' && prov.database_id) {
          provisionedBindings.d1.push({
            binding:       prov.binding,
            database_name: prov.database_name,
            database_id:   prov.database_id,
          });
        } else if (svcType === 'r2' && prov.bucket_name) {
          provisionedBindings.r2.push({
            binding:     prov.binding,
            bucket_name: prov.bucket_name,
          });
        } else if (svcType === 'kv' && prov.namespace_id) {
          provisionedBindings.kv.push({
            binding:      prov.binding,
            namespace_id: prov.namespace_id,
          });
        } else if (svcType === 'queues' && prov.queue_name) {
          provisionedBindings.queues.push({
            binding:          prov.binding,
            queue_name:       prov.queue_name,
            consumer_enabled: prov.consumer_enabled,
          });
        } else if (svcType === 'durable_objects' && prov.class_name) {
          provisionedBindings.durable_objects.push({
            binding:        prov.binding,
            class_name:     prov.class_name,
            migrations_tag: prov.migrations_tag,
          });
        }

        if (svcSlotIdx >= 0) {
          stages.stages.deploy.outputs.services[svcSlotIdx] = Object.assign(
            stages.stages.deploy.outputs.services[svcSlotIdx],
            {
              status:      'completed',
              url:         null,
              duration_ms: Date.now() - svcStart,
              provision:   prov,
            }
          );
        }
        writeStagesJson(stages);
        log.info('deploy_service_complete', `[deploy] provision 完成 service=${svcName}`, {
          service_name: svcName,
          type:         svcType,
          duration_ms:  Date.now() - svcStart,
        });
      } catch (err) {
        overallFailed = true;
        lastFailedService = svc;
        lastError = err;
        if (svcSlotIdx >= 0) {
          stages.stages.deploy.outputs.services[svcSlotIdx].status = 'failed';
        }
        writeStagesJson(stages);
        if (failFast) break;
        continue;
      }
      continue;
    }

    if (!['pages', 'workers'].includes(svcType)) {
      log.warn('deploy_service_unknown_type', `[deploy] 跳过未知类型: ${svcType}`, {
        service_name: svcName,
      });
      continue;
    }

    log.info('deploy_service_start', `[deploy] 开始部署 service=${svcName}`, {
      service_name:  svcName,
      client_target: svc.client_target,
      type:          svcType,
      artifact_path: artifactPath || '(none)',
    });

    // Workers：注入 wrangler bindings 后再 deploy
    if (svcType === 'workers' && provider === 'cloudflare') {
      const wrPath = findWranglerTomlPath(projectRoot, artifactPath);
      const hasBindings = provisionedBindings.d1.length ||
        provisionedBindings.r2.length ||
        provisionedBindings.kv.length ||
        provisionedBindings.queues.length ||
        provisionedBindings.durable_objects.length;
      if (wrPath && hasBindings) {
        const bindRes = applyWranglerBindings(wrPath, provisionedBindings);
        log.info('wrangler_bindings_applied', `[deploy] 已更新 wrangler.toml bindings`, {
          path:  bindRes.path,
          added: bindRes.added || [],
        });
      } else if (hasBindings && !wrPath) {
        log.warn('wrangler_bindings_missing', '[deploy] 有 provision 结果但未找到 wrangler.toml', {
          artifact_path: artifactPath,
        });
      }
    }

    // 超时包装
    let timedOutSvc = false;
    const deployPromise = (async () => {
      if (provider === 'cloudflare') {
        if (svcType === 'pages') {
          return deployPages({ service: svc, artifactPath, token: cfToken, accountId: cfAccountId, stageLogPath: serviceLogPath });
        }
        if (svcType === 'workers') {
          return deployWorkers({ service: svc, artifactPath, token: cfToken, accountId: cfAccountId, stageLogPath: serviceLogPath });
        }
        throw new Error(`未知 Cloudflare 类型：${svcType}`);
      }
      return { url: svc.url || null };
    })();

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => {
        timedOutSvc = true;
        reject(new Error(`deploy timeout after ${deployTimeoutMs}ms`));
      }, deployTimeoutMs)
    );

    let deployResult = null;
    try {
      deployResult = await Promise.race([deployPromise, timeoutPromise]);
      deployUrl    = deployResult.url;
    } catch (err) {
      // 失败处理
      const svcDur = Date.now() - svcStart;
      overallFailed = true;
      lastFailedService = svc;
      lastError = err;

      if (timedOutSvc) timedOut = true;

      log.error('deploy_failed', `[deploy] service=${svcName} 失败：${err.message}`, {
        service_name:    svcName,
        http_status:     err.httpStatus || null,
        error_summary:   err.message,
        deploy_log_path: serviceLogPath,
        timed_out:       timedOutSvc,
      });

      // 更新 slot 状态
      if (svcSlot) {
        Object.assign(svcSlot, { status: 'failed', duration_ms: svcDur });
        stages.stages.deploy.outputs.failed_targets.push(svcName);
      }
      stages.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stages);

      if (failFast) break;
      continue;
    }

    const svcDur = Date.now() - svcStart;
    deployedUrls[svcName] = deployUrl;
    deployedUrls[svc.client_target] = deployUrl;

    log.info('deploy_service_complete', `[deploy] service=${svcName} 部署完成，url=${deployUrl}，耗时 ${svcDur}ms`, {
      service_name: svcName,
      url:          deployUrl,
      duration_ms:  svcDur,
    });

    // 更新 stages
    if (svcSlot) {
      Object.assign(svcSlot, {
        status:      'completed',
        url:         deployUrl,
        duration_ms: svcDur,
        deployed_at: formatLocalTimeShort(),
      });
    }
    stages.stages.deploy.outputs.deployment_urls[svcName] = deployUrl;
    stages.stages.deploy.outputs.deployed_targets.push(svcName);

    // ── 内联 smoke ──────────────────────────────────────────────
    if (smokeDeployEnabled && deployUrl) {
      const smokeRes = await runSmokeChecks({
        service:     svc,
        deployedUrl: deployUrl,
        smokeConfig: smokeCfg,
        deployedUrls,
        timeoutMs:   smokeTimeoutMs,
      });

      if (svcSlot) {
        svcSlot.smoke_passed  = smokeRes.passed;
        svcSlot.smoke_checks  = smokeRes.results;
      }

      if (smokeRes.passed) {
        log.info('smoke_inline_complete', `[smoke] service=${svcName} smoke 通过`, {
          service_name:  svcName,
          url:           deployUrl,
          checks_passed: smokeRes.results.length,
        });
      } else {
        for (const f of smokeRes.failures) {
          inlineSmokeFailures.push({ service: svcName, url: f.url, error: f.error });
        }
        log.error('smoke_inline_failed', `[smoke] service=${svcName} smoke 失败`, {
          service_name: svcName,
          url:          deployUrl,
          failures:     smokeRes.failures,
        });

        if (failFast) {
          overallFailed     = true;
          lastFailedService = svc;
          lastError         = new Error(`smoke 失败：${smokeRes.failures.map(f => f.error).join('; ')}`);
          lastError.isSmokeFailure = true;
          break;
        }
      }
    }

    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
  }

  // ── 13. 失败分诊 ──────────────────────────────────────────────────
  let finalExitCode = 0;

  if (overallFailed && lastFailedService && lastError) {
    if (!lastError.isSmokeFailure) {
      // 部署失败：写错误包 + 分诊（含重试循环）
      let triageAttempt = 0;
      let keepTrying    = true;

      // 用于 retry_deploy 场景的单 service 重部署
      async function retryOneService(svc) {
        const svcName        = svc.name || svc.client_target;
        const serviceLogPath = path.join(logDir, `${datetime}-${svcName}-retry.log`);
        fs.writeFileSync(serviceLogPath, `[deploy] retry service=${svcName} at ${formatLocalTimeShort()}\n`, 'utf8');

        const svcStart   = Date.now();
        let   timedOutRetry = false;
        const retryDeployPromise = (async () => {
          if (provider === 'cloudflare') {
            const svcType = (svc.type || 'pages').toLowerCase();
            if (svcType === 'pages') {
              return deployPages({ service: svc, artifactPath: resolveArtifactPath(svc, stages),
                                   token: cfToken, accountId: cfAccountId, stageLogPath: serviceLogPath });
            } else {
              return deployWorkers({ service: svc, artifactPath: resolveArtifactPath(svc, stages),
                                     token: cfToken, accountId: cfAccountId, stageLogPath: serviceLogPath });
            }
          }
          return { url: svc.url || null };
        })();

        const timeoutRetry = new Promise((_, rej) =>
          setTimeout(() => { timedOutRetry = true; rej(new Error('retry timeout')); }, deployTimeoutMs)
        );

        try {
          const res = await Promise.race([retryDeployPromise, timeoutRetry]);
          const svcSlot = stages.stages.deploy.outputs.services.find(s => s.name === svcName);
          if (svcSlot) {
            Object.assign(svcSlot, {
              status: 'completed', url: res.url, duration_ms: Date.now() - svcStart,
              deployed_at: formatLocalTimeShort(),
            });
          }
          stages.stages.deploy.outputs.deployment_urls[svcName] = res.url;
          if (!stages.stages.deploy.outputs.deployed_targets.includes(svcName)) {
            stages.stages.deploy.outputs.deployed_targets.push(svcName);
          }
          stages.stages.deploy.outputs.failed_targets =
            stages.stages.deploy.outputs.failed_targets.filter(t => t !== svcName);
          deployedUrls[svcName] = res.url;
          deployedUrls[svc.client_target] = res.url;
          return { success: true, url: res.url };
        } catch (retryErr) {
          if (timedOutRetry) timedOut = true;
          return { success: false, error: retryErr };
        }
      }

      while (keepTrying) {
        triageAttempt++;

        // 写错误包（每次分诊前刷新）
        const stderrTail = (lastError.apiErrors || []).join('\n').slice(-500);
        writeLastError({
          service:      lastFailedService,
          provider,
          httpStatus:   lastError.httpStatus || null,
          apiErrors:    lastError.apiErrors || [lastError.message],
          stderrTail,
          stageLogPath: path.join(logDir, `${datetime}-${lastFailedService.name || lastFailedService.client_target}.log`),
          config,
        });

        const triage = await runTriageAgent({ attempt: triageAttempt });

        if (triage.decision === 'blocked') {
          log.error('deploy_blocked', `[deploy] 分诊结果：blocked — ${triage.reason}`, {
            reason:       triage.reason,
            user_actions: triage.user_actions || [],
            exit_code:    9,
          });
          stages.stages.deploy.outputs.blocked_reason = triage.reason;
          stages.stages.deploy.outputs.user_actions   = triage.user_actions || [];
          finalExitCode = 9;
          keepTrying    = false;

        } else if (triage.decision === 'retry_deploy') {
          stages.stages.deploy.outputs.deploy_retries = (stages.stages.deploy.outputs.deploy_retries || 0) + 1;
          const retries = stages.stages.deploy.outputs.deploy_retries;

          log.warn('deploy_retry', `[deploy] retry_deploy #${retries}，原因：${triage.reason}`, {
            reason:             triage.reason,
            deploy_retries:     retries,
            agent_fix_attempts: stages.stages.deploy.outputs.agent_fix_attempts || 0,
          });

          if (retries > deployRetryMax) {
            log.error('stage_failed', `[deploy] retry_deploy 次数用尽（${deployRetryMax}），退出码 8`, {
              stage: 'deploy', exit_code: 8,
            });
            finalExitCode = 8;
            keepTrying    = false;
          } else {
            // 实际重试失败 service
            const retryRes = await retryOneService(lastFailedService);
            if (retryRes.success) {
              log.info('deploy_service_complete', `[deploy] retry 成功 service=${lastFailedService.name || lastFailedService.client_target}`, {
                service_name: lastFailedService.name || lastFailedService.client_target,
                url:          retryRes.url,
                duration_ms:  0,
              });
              overallFailed = false;
              lastError     = null;
              finalExitCode = 0;
              keepTrying    = false;
            } else {
              lastError = retryRes.error;
              // 继续循环（再次分诊）
            }
          }

        } else if (triage.decision === 'fix_script') {
          stages.stages.deploy.outputs.agent_fix_attempts = (stages.stages.deploy.outputs.agent_fix_attempts || 0) + 1;
          const fixAttempts = stages.stages.deploy.outputs.agent_fix_attempts;

          log.info('deploy_script_patched', `[deploy] fix_script #${fixAttempts}，分诊已改 skill 脚本，重试部署`, {
            files:   (triage.patch_hints || []).map(h => h.path),
            attempt: fixAttempts,
          });

          if (fixAttempts > agentFixMaxAttempts) {
            log.error('stage_failed', `[deploy] fix_script 次数用尽（${agentFixMaxAttempts}），退出码 4`, {
              stage: 'deploy', exit_code: 4,
            });
            finalExitCode = 4;
            keepTrying    = false;
          } else {
            const retryRes = await retryOneService(lastFailedService);
            if (retryRes.success) {
              log.info('deploy_service_complete', `[deploy] fix_script 后重试成功 service=${lastFailedService.name || lastFailedService.client_target}`, {
                service_name: lastFailedService.name || lastFailedService.client_target,
                url:          retryRes.url,
              });
              overallFailed = false;
              lastError     = null;
              finalExitCode = 0;
              keepTrying    = false;
            } else {
              lastError = retryRes.error;
              // 继续分诊循环
            }
          }
        } else {
          finalExitCode = 8;
          keepTrying    = false;
        }
      }
    } else {
      // smoke 失败
      finalExitCode = 4;
    }
  }

  // ── 14. 汇总与写报告 ──────────────────────────────────────────────
  const completedAt    = Date.now();
  const completedAtStr = formatLocalTimeShort(new Date(completedAt));
  const durMs          = completedAt - startedAt;

  stages.stages.deploy.outputs.inline_smoke_passed   = inlineSmokeFailures.length === 0 && !overallFailed;
  stages.stages.deploy.outputs.inline_smoke_failures = inlineSmokeFailures;
  stages.stages.deploy.outputs.duration_ms           = durMs;
  stages.stages.deploy.outputs.timed_out             = timedOut;
  stages.stages.deploy.outputs.timeout_reason        = timedOut ? `service timed out after ${deployTimeoutMs}ms` : null;

  // 生成报告
  const reportDir  = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'deploy-summary.md');
  const reportContent = generateDeployReport({
    services:            stages.stages.deploy.outputs.services,
    inlineSmokeFailures,
    inlineSmokePassed:   stages.stages.deploy.outputs.inline_smoke_passed,
    startedAt,
    completedAt,
  });
  fs.writeFileSync(reportPath, reportContent, 'utf8');
  stages.stages.deploy.outputs.report_path = reportPath;
  stages.stages.deploy.generated_files     = [reportPath];

  const overallOk = finalExitCode === 0 && !overallFailed;
  const validationPassed = overallOk;

  stages.stages.deploy.status       = overallOk ? 'completed' : 'failed';
  stages.stages.deploy.completed_at = completedAtStr;
  stages.stages.deploy.validation   = {
    passed:                  validationPassed,
    checked_at:              completedAtStr,
    summary:                 overallOk ? null : `部署失败，退出码 ${timedOut ? 3 : finalExitCode}`,
    required_files:          [],
    missing_required_fields: [],
    warnings:                [],
  };

  if (!overallOk) {
    stages.stages.deploy.blocking_issues = [`部署失败（exit=${timedOut ? 3 : finalExitCode}）`];
  }

  stages.pipeline.updated_at           = completedAtStr;
  stages.pipeline.last_completed_stage  = overallOk ? 'deploy' : (stages.pipeline.last_completed_stage || null);
  writeStagesJson(stages);
  releasePidLock();

  // ── 15. 最终日志与退出码 ─────────────────────────────────────────
  if (overallOk) {
    log.info('validation_pass', 'deploy 校验通过', {
      services_deployed: stages.stages.deploy.outputs.deployed_targets,
      warnings:          [],
    });
    log.info('stage_complete', `deploy stage 完成，耗时 ${durMs}ms`, {
      stage:             'deploy',
      exit_code:         0,
      duration_ms:       durMs,
      services_deployed: stages.stages.deploy.outputs.deployed_targets,
    });
    process.exit(0);
  }

  const actualExitCode = timedOut ? 3 : finalExitCode;
  log.error('stage_failed', `deploy stage 失败，退出码 ${actualExitCode}，耗时 ${durMs}ms`, {
    stage:      'deploy',
    step:       lastFailedService ? (lastFailedService.name || lastFailedService.client_target) : 'unknown',
    exit_code:  actualExitCode,
    reason:     lastError ? lastError.message : 'unknown',
    duration_ms: durMs,
  });
  process.exit(actualExitCode);
}

main().catch(err => {
  console.error(`[FATAL] deploy.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  releasePidLock();
  process.exit(1);
});

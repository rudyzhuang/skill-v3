'use strict';

/**
 * Cloudflare 全自动部署（对齐 ai-deploy2 `templates/cloudflare/deploy.sh.tmpl` 语义）：
 * - 按 service_name 预检/创建 Pages 项目或 Workers 脚本部署
 * - 自定义域名：Pages Domains API / Workers Custom Domains API，失败则 DNS CNAME（橙色代理自动 HTTPS）
 * - 凭证：docs/config.env 中 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID（可选 CLOUDFLARE_ZONE_ID 仅作提示，Zone 按域名自动解析）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { parseConfigEnv } = require('../config-env.cjs');
const { matchArtifactsForService } = require('../artifacts.cjs');
const { finalizeDeploySuccess, finalizeDeployFailure } = require('./stage-write.cjs');

const CF_API = 'api.cloudflare.com';

/**
 * @param {string} method
 * @param {string} apiPath  以 / 开头，不含 /client/v4 前缀
 * @param {string} token
 * @param {object|null} body
 * @returns {Promise<{ statusCode: number, json: object|null, raw: string }>}
 */
function cfApi(method, apiPath, token, body) {
  const payload = body != null ? JSON.stringify(body) : null;
  const opts = {
    hostname: CF_API,
    port: 443,
    method,
    path: `/client/v4${apiPath}`,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload, 'utf8') }
        : {}),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        raw += c;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          /* ignore */
        }
        resolve({ statusCode: res.statusCode || 0, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function isAuthishStatus(c) {
  return c === 401 || c === 403;
}

function isServerError(c) {
  return c >= 500 && c < 600;
}

function errorSummary(statusCode, json) {
  if (json && Array.isArray(json.errors) && json.errors.length) {
    return json.errors.map((e) => e.message || JSON.stringify(e)).join('; ');
  }
  if (json && json.messages) return JSON.stringify(json.messages);
  return `HTTP ${statusCode}`;
}

const zoneCache = new Map();

/**
 * @param {string} hostname
 * @param {string} token
 * @param {string} accountId
 * @returns {Promise<{ id: string, name: string }|null>}
 */
async function getZoneInfo(hostname, token, accountId) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!h || !token) return null;
  if (zoneCache.has(h)) return zoneCache.get(h);
  const parts = h.split('.');
  for (let i = 0; i <= Math.max(parts.length - 2, 0); i++) {
    const candidate = parts.slice(i).join('.');
    const q = `/zones?name=${encodeURIComponent(candidate)}${accountId ? `&account.id=${encodeURIComponent(accountId)}` : ''}`;
    const { statusCode, json } = await cfApi('GET', q, token, null);
    if (statusCode === 200 && json && json.success && json.result && json.result[0]) {
      const z = json.result[0];
      const info = { id: z.id, name: z.name };
      zoneCache.set(h, info);
      return info;
    }
  }
  zoneCache.set(h, null);
  return null;
}

function hostFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const u = url.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return u.split('/')[0].split(':')[0].toLowerCase();
}

function isEdgeHostname(host) {
  const h = String(host || '').toLowerCase();
  return h.endsWith('.pages.dev') || h.endsWith('.workers.dev');
}

function pagesEdgeHostname(serviceName) {
  return `${serviceName}.pages.dev`;
}

async function fetchWorkersDevCnameTarget(serviceName, token, accountId) {
  if (!token || !accountId) return `${serviceName}.workers.dev`;
  const { statusCode, json } = await cfApi('GET', `/accounts/${accountId}/workers/subdomain`, token, null);
  if (statusCode === 200 && json && json.success) {
    const res = json.result || {};
    const sub = res.subdomain;
    if (typeof sub === 'string' && sub.trim()) {
      const s = sub.trim().replace(/\.$/, '');
      return `${serviceName}.${s}.workers.dev`;
    }
  }
  return `${serviceName}.workers.dev`;
}

function dnsShortRecordName(fqdn, zoneName) {
  const f = fqdn.replace(/\.$/, '').toLowerCase();
  const z = zoneName.replace(/\.$/, '').toLowerCase();
  if (f === z) return '@';
  const suf = `.${z}`;
  if (f.endsWith(suf)) {
    const p = f.slice(0, -suf.length);
    return p || '@';
  }
  return fqdn;
}

async function ensureDnsRecord(zoneInfo, fqdn, recordType, content, token, proxied) {
  if (!token || !zoneInfo) return false;
  const zoneId = zoneInfo.id;
  const zn = zoneInfo.name;
  const short = dnsShortRecordName(fqdn, zn);
  const queryNames = [fqdn];
  if (short !== '@' && `${short}.${zn}`.toLowerCase() !== fqdn.toLowerCase()) queryNames.push(`${short}.${zn}`);

  let recs = [];
  for (const qn of queryNames) {
    const { statusCode, json } = await cfApi(
      'GET',
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(qn)}&type=${recordType}`,
      token,
      null
    );
    if (statusCode === 200 && json && json.success && json.result && json.result.length) {
      recs = json.result;
      break;
    }
  }
  const want = String(content).replace(/\.$/, '').toLowerCase();
  if (recs.length) {
    const existing = String(recs[0].content || '')
      .replace(/\.$/, '')
      .toLowerCase();
    if (existing === want) return true;
    return false;
  }
  const body = { type: recordType, name: short, content, proxied: !!proxied, ttl: proxied ? 1 : 3600 };
  const { statusCode, json } = await cfApi('POST', `/zones/${zoneId}/dns_records`, token, body);
  return statusCode === 200 && json && json.success;
}

async function ensurePagesProject(accountId, serviceName, token) {
  const { statusCode, json } = await cfApi(
    'GET',
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(serviceName)}`,
    token,
    null
  );
  if (isAuthishStatus(statusCode)) {
    const err = new Error(`Cloudflare API 凭证/权限: ${errorSummary(statusCode, json)}`);
    err.cfStatus = statusCode;
    throw err;
  }
  if (statusCode === 200 && json && json.success) return;
  const { statusCode: c2, json: j2 } = await cfApi('POST', `/accounts/${accountId}/pages/projects`, token, {
    name: serviceName,
    production_branch: 'main',
  });
  if (isAuthishStatus(c2)) {
    const err = new Error(`Cloudflare API 凭证/权限: ${errorSummary(c2, j2)}`);
    err.cfStatus = c2;
    throw err;
  }
  if (c2 !== 200 || !j2 || !j2.success) {
    const err = new Error(`Pages 项目创建失败: ${errorSummary(c2, j2)}`);
    err.cfStatus = c2;
    err.cfJson = j2;
    throw err;
  }
}

async function bindPagesCustomDomain(accountId, serviceName, customHost, token) {
  const { statusCode, json } = await cfApi(
    'POST',
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(serviceName)}/domains`,
    token,
    { name: customHost }
  );
  if (statusCode === 200 && json && json.success) return true;
  if (json && Array.isArray(json.errors) && json.errors.some((e) => e.code === 8000037)) return true;
  return false;
}

async function setupPagesCustomHost(accountId, serviceName, customHost, token, accountIdForDns) {
  await bindPagesCustomDomain(accountId, serviceName, customHost, token);
  const zi = await getZoneInfo(customHost, token, accountIdForDns);
  if (zi) {
    await ensureDnsRecord(zi, customHost, 'CNAME', pagesEdgeHostname(serviceName), token, true);
  }
}

async function workersAttachCustomHostname(hostname, scriptName, zoneId, token, accountId) {
  const body = { hostname, service: scriptName, environment: 'production', zone_id: zoneId };
  for (const method of ['POST', 'PUT']) {
    const { statusCode, json } = await cfApi(method, `/accounts/${accountId}/workers/domains`, token, body);
    if (statusCode === 200 && json && json.success) return true;
    if (json && Array.isArray(json.errors) && json.errors.some((e) => [10005, 10006, 8000018].includes(e.code))) return true;
  }
  return false;
}

async function setupWorkerCustomHost(serviceName, customHost, token, accountId) {
  const zi = await getZoneInfo(customHost, token, accountId);
  const target = await fetchWorkersDevCnameTarget(serviceName, token, accountId);
  if (zi && (await workersAttachCustomHostname(customHost, serviceName, zi.id, token, accountId))) return;
  if (zi) {
    await ensureDnsRecord(zi, customHost, 'CNAME', target, token, true);
    const { statusCode, json } = await cfApi(
      'POST',
      `/zones/${zi.id}/workers/routes`,
      token,
      { pattern: `${customHost}/*`, script: serviceName }
    );
    if (statusCode === 200 && json && json.success) return;
    if (json && Array.isArray(json.errors) && json.errors.some((e) => e.code === 10020)) return;
  }
}

function resolveServiceName(svc) {
  const rc = svc.resource_config && typeof svc.resource_config === 'object' ? svc.resource_config : {};
  return (
    (svc.service_name && String(svc.service_name).trim()) ||
    (rc.project_name && String(rc.project_name).trim()) ||
    (rc.script_name && String(rc.script_name).trim()) ||
    svc.client_target ||
    'app'
  );
}

function isWorkerDeploy(svc, artifactAbs) {
  const rt = String(svc.resource_type || '').toLowerCase();
  if (rt.includes('worker') || rt.includes('edge') || rt === 'serverless_function' || rt === 'api_gateway') return true;
  if (rt.includes('page') || rt === 'static_site' || rt === 'web_app') return false;
  try {
    return fs.existsSync(path.join(artifactAbs, 'wrangler.toml'));
  } catch {
    return false;
  }
}

function mergeEnvForChild(projectRoot, envMap) {
  const out = { ...process.env };
  for (const [k, v] of envMap.entries()) {
    out[k] = v;
  }
  out.CLOUDFLARE_API_TOKEN = envMap.get('CLOUDFLARE_API_TOKEN') || out.CLOUDFLARE_API_TOKEN;
  out.CLOUDFLARE_ACCOUNT_ID = envMap.get('CLOUDFLARE_ACCOUNT_ID') || out.CLOUDFLARE_ACCOUNT_ID;
  return out;
}

function runCmd(cmd, cwd, env, log) {
  log(`exec: ${cmd} (cwd=${cwd})`);
  const r = spawnSync(cmd, { cwd, env, shell: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) {
    const err = new Error((r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 800));
    err.exitCode = r.status;
    throw err;
  }
}

/**
 * @param {string} projectRoot
 * @param {object} deploy deploy 配置子树
 * @param {object[]} buildArtifacts stages.build.outputs.artifacts 全量
 * @param {(s:string)=>void} log
 */
async function runCloudflareDeploy(projectRoot, deploy, buildArtifacts, log) {
  const envPath = path.join(projectRoot, 'docs', 'config.env');
  const envMap = parseConfigEnv(envPath);
  const token = String(envMap.get('CLOUDFLARE_API_TOKEN') || '').trim();
  const accountId = String(envMap.get('CLOUDFLARE_ACCOUNT_ID') || '').trim();
  if (!token || !accountId) {
    const e = new Error('Cloudflare 部署需要 docs/config.env 中 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID');
    e.code = 'CONFIG';
    throw e;
  }

  const childEnv = mergeEnvForChild(projectRoot, envMap);
  const services = deploy.services || [];
  const arts = buildArtifacts || [];
  const outServices = [];
  let deployUrl = '';

  const pairs = [];
  for (const svc of services) {
    if (!svc || !svc.client_target) continue;
    const matches = matchArtifactsForService(svc, arts);
    if (matches.length !== 1) {
      const e = new Error(`artifact 映射失败: ${svc.client_target}`);
      e.code = 'CONFIG';
      throw e;
    }
    pairs.push({ service: svc, artifact: matches[0] });
  }

  for (const { service: svc, artifact: art } of pairs) {
    const artifactAbs = path.isAbsolute(art.artifact_path)
      ? art.artifact_path
      : path.join(projectRoot, art.artifact_path);
    if (!fs.existsSync(artifactAbs)) {
      const e = new Error(`产物路径不存在: ${artifactAbs}`);
      e.code = 'CONFIG';
      throw e;
    }
    const serviceName = resolveServiceName(svc);
    const domainRaw = (svc.domain && String(svc.domain).trim()) || '';
    const customHost = hostFromUrl(domainRaw);

    const worker = isWorkerDeploy(svc, artifactAbs);

    if (!worker) {
      await ensurePagesProject(accountId, serviceName, token);
      const stat = fs.statSync(artifactAbs);
      const deployPath = stat.isDirectory() ? artifactAbs : path.dirname(artifactAbs);
      runCmd(`npx wrangler pages deploy "${deployPath}" --project-name="${serviceName}"`, projectRoot, childEnv, log);
      let publicUrl = `https://${pagesEdgeHostname(serviceName)}`;
      if (customHost && !isEdgeHostname(customHost)) {
        await setupPagesCustomHost(accountId, serviceName, customHost, token, accountId);
        publicUrl = `https://${customHost}`;
      }
      if (!deployUrl) deployUrl = publicUrl.replace(/\/$/, '');
      outServices.push({
        client_target: svc.client_target,
        service_name: serviceName,
        resource_type: svc.resource_type || 'pages_project',
        url: publicUrl,
        status: 'deployed',
        log_path: '',
      });
    } else {
      const cwd = fs.statSync(artifactAbs).isDirectory() ? artifactAbs : path.dirname(artifactAbs);
      runCmd('npx wrangler deploy', cwd, childEnv, log);
      const target = await fetchWorkersDevCnameTarget(serviceName, token, accountId);
      let publicUrl = `https://${target}`;
      if (customHost && !isEdgeHostname(customHost)) {
        await setupWorkerCustomHost(serviceName, customHost, token, accountId);
        publicUrl = `https://${customHost}`;
      }
      if (!deployUrl) deployUrl = publicUrl.replace(/\/$/, '');
      outServices.push({
        client_target: svc.client_target,
        service_name: serviceName,
        resource_type: svc.resource_type || 'worker_script',
        url: publicUrl,
        status: 'deployed',
        log_path: '',
      });
    }
  }

  return {
    services: outServices,
    deploy_url: deployUrl,
  };
}

/**
 * @param {string} projectRoot
 * @param {object} config 全量 config.dev.json
 * @param {object[]} buildArtifacts
 * @param {object[]} consumed 本次 deploy 消费的 artifacts（写回 stages.deploy.inputs）
 * @param {string} summaryHash
 * @param {string} stPath
 * @param {(s:string)=>void} log
 * @returns {Promise<{ code: number, message?: string, failed_step?: string }>}
 */
async function executeCloudflareAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log) {
  const t0 = Date.now();
  try {
    const planned = await runCloudflareDeploy(projectRoot, config.deploy, buildArtifacts, log);
    finalizeDeploySuccess(stPath, t0, summaryHash, consumed, {
      provider: 'cloudflare',
      services: planned.services,
      deploy_url: planned.deploy_url,
      validationSummary: 'Cloudflare 全自动部署（Pages/Workers + 域名/DNS/SSL）',
    });
    return { code: 0, message: 'deploy 完成（cloudflare provider）' };
  } catch (e) {
    const msg = e.message || String(e);
    const cfStatus = e.cfStatus;
    const exitCode = e.exitCode;
    let code = 1;
    if (e.code === 'CONFIG') code = 1;
    else if (cfStatus != null && (isAuthishStatus(cfStatus) || isServerError(cfStatus))) code = 8;
    else if (exitCode != null && exitCode !== 0) code = 8;
    else if (cfStatus != null) code = 8;

    finalizeDeployFailure(stPath, t0, summaryHash, consumed, {
      provider: 'cloudflare',
      errorMsg: msg,
      validationSummary: 'Cloudflare deploy 失败',
    });

    if (code === 8) return { code: 8, failed_step: 'deploy', message: msg };
    return { code: 1, failed_step: 'deploy', message: msg };
  }
}

module.exports = { runCloudflareDeploy, executeCloudflareAndWriteStages, getZoneInfo, cfApi };

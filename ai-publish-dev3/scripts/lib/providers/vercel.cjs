'use strict';

const fs = require('fs');
const path = require('path');
const { matchArtifactsForService } = require('../artifacts.cjs');
const { mergeConfigEnvIntoProcess, resolveArtifactPath, deployableDir, resolveServiceName, runCmd } = require('./deploy-common.cjs');
const { finalizeDeploySuccess, finalizeDeployFailure } = require('./stage-write.cjs');

function pickVercelUrlFromOutput(text) {
  const s = String(text || '');
  const m = s.match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/i);
  if (m) return m[0].replace(/\/$/, '');
  const m2 = s.match(/https:\/\/[^\s]+vercel\.app[^\s]*/i);
  if (m2) return m2[0].replace(/\/$/, '');
  return '';
}

/**
 * @param {string} projectRoot
 * @param {object} deploy
 * @param {object[]} buildArtifacts
 * @param {(s:string)=>void} log
 */
async function runVercelDeploy(projectRoot, deploy, buildArtifacts, log) {
  const { childEnv, envMap } = mergeConfigEnvIntoProcess(projectRoot);
  const token = String(envMap.get('VERCEL_TOKEN') || '').trim();
  if (!token) {
    const e = new Error('Vercel 部署需要 docs/config.env 中 VERCEL_TOKEN');
    e.code = 'CONFIG';
    throw e;
  }
  childEnv.VERCEL_TOKEN = token;

  const services = deploy.services || [];
  const arts = buildArtifacts || [];
  const outServices = [];
  let deployUrl = '';

  for (const svc of services) {
    if (!svc || !svc.client_target) continue;
    const matches = matchArtifactsForService(svc, arts);
    if (matches.length !== 1) {
      const e = new Error(`artifact 映射失败: ${svc.client_target}`);
      e.code = 'CONFIG';
      throw e;
    }
    const art = matches[0];
    const artifactAbs = resolveArtifactPath(projectRoot, art);
    if (!fs.existsSync(artifactAbs)) {
      const e = new Error(`产物路径不存在: ${artifactAbs}`);
      e.code = 'CONFIG';
      throw e;
    }
    const deployPath = deployableDir(artifactAbs);
    const serviceName = resolveServiceName(svc);
    const rc = svc.resource_config && typeof svc.resource_config === 'object' ? svc.resource_config : {};
    const team = rc.vercel_team_slug || rc.vercel_scope || envMap.get('VERCEL_ORG_ID') || '';
    const projectId = rc.vercel_project_id || envMap.get('VERCEL_PROJECT_ID') || '';
    const scopeArg = team ? ` --scope "${String(team).replace(/"/g, '')}"` : '';
    const projectArg = projectId ? ` --project "${String(projectId).replace(/"/g, '')}"` : '';
    const prodArg = rc.vercel_preview_only ? '' : ' --prod';
    const cmd = `npx --yes vercel deploy "${deployPath}"${prodArg} --yes --token "${token.replace(/"/g, '')}"${scopeArg}${projectArg}`;
    log(`vercel: service=${serviceName}`);
    const r = runCmd(cmd, projectRoot, childEnv, log);
    const combined = `${r.stdout || ''}\n${r.stderr || ''}`;
    let url = pickVercelUrlFromOutput(combined);
    if (!url && rc.public_url) url = String(rc.public_url).trim().replace(/\/$/, '');
    if (!url) {
      const e = new Error('vercel deploy 输出中未解析到 URL；请在 resource_config.public_url 显式填写');
      e.code = 'CONFIG';
      throw e;
    }
    if (!deployUrl) deployUrl = url;
    outServices.push({
      client_target: svc.client_target,
      service_name: serviceName,
      resource_type: svc.resource_type || 'vercel_project',
      url,
      status: 'deployed',
      log_path: '',
    });
  }

  return { services: outServices, deploy_url: deployUrl };
}

/**
 * @returns {Promise<{ code: number, message?: string, failed_step?: string }>}
 */
async function executeVercelAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log) {
  const t0 = Date.now();
  const provider = 'vercel';
  try {
    const planned = await runVercelDeploy(projectRoot, config.deploy, buildArtifacts, log);
    finalizeDeploySuccess(stPath, t0, summaryHash, consumed, {
      provider,
      services: planned.services,
      deploy_url: planned.deploy_url,
      validationSummary: 'Vercel 全自动部署（vercel deploy CLI）',
    });
    return { code: 0, message: 'deploy 完成（vercel provider）' };
  } catch (e) {
    const msg = e.message || String(e);
    const code = e.code === 'CONFIG' ? 1 : 8;
    finalizeDeployFailure(stPath, t0, summaryHash, consumed, {
      provider,
      errorMsg: msg,
      validationSummary: 'Vercel deploy 失败',
    });
    if (code === 8) return { code: 8, failed_step: 'deploy', message: msg };
    return { code: 1, failed_step: 'deploy', message: msg };
  }
}

module.exports = { runVercelDeploy, executeVercelAndWriteStages };

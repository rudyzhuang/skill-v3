'use strict';

const fs = require('fs');
const { matchArtifactsForService } = require('../artifacts.cjs');
const { mergeConfigEnvIntoProcess, resolveArtifactPath, deployableDir, resolveServiceName, runCmd } = require('./deploy-common.cjs');
const { finalizeDeploySuccess, finalizeDeployFailure } = require('./stage-write.cjs');

function requireRc(svc) {
  const rc = svc.resource_config && typeof svc.resource_config === 'object' ? svc.resource_config : {};
  if (!rc.storage_container || !String(rc.storage_container).trim()) {
    const e = new Error('azure provider 要求 deploy.services[].resource_config.storage_container（Blob 容器名）');
    e.code = 'CONFIG';
    throw e;
  }
  return rc;
}

/**
 * Azure Blob：使用 az storage blob upload-batch。
 * @param {string} projectRoot
 * @param {object} deploy
 * @param {object[]} buildArtifacts
 * @param {(s:string)=>void} log
 */
async function runAzureBlobDeploy(projectRoot, deploy, buildArtifacts, log) {
  const { childEnv, envMap } = mergeConfigEnvIntoProcess(projectRoot);
  const conn = String(envMap.get('AZURE_STORAGE_CONNECTION_STRING') || '').trim();
  if (!conn) {
    const e = new Error('Azure Blob 部署需要 docs/config.env 中 AZURE_STORAGE_CONNECTION_STRING');
    e.code = 'CONFIG';
    throw e;
  }
  childEnv.AZURE_STORAGE_CONNECTION_STRING = conn;

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
    const dir = deployableDir(artifactAbs);
    const rc = requireRc(svc);
    const container = String(rc.storage_container).trim();
    const destPath = String(rc.blob_prefix || '').replace(/^\/+/, '');
    const destArg = destPath ? ` --destination-path "${destPath.replace(/"/g, '')}"` : '';
    const cmd = `az storage blob upload-batch --destination "${container.replace(/"/g, '')}" --source "${dir.replace(/"/g, '')}"${destArg}`;
    runCmd(cmd, projectRoot, childEnv, log);

    const serviceName = resolveServiceName(svc);
    const url = String(rc.public_url || '').trim().replace(/\/$/, '');
    if (!url) {
      const e = new Error('请在 resource_config.public_url 填写静态站/CDN 访问 URL（Blob 直链或 Front Door 域名）');
      e.code = 'CONFIG';
      throw e;
    }
    if (!deployUrl) deployUrl = url;
    outServices.push({
      client_target: svc.client_target,
      service_name: serviceName,
      resource_type: svc.resource_type || 'azure_blob_static',
      url,
      status: 'deployed',
      log_path: '',
    });
  }

  return { services: outServices, deploy_url: deployUrl };
}

async function executeAzureAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log) {
  const t0 = Date.now();
  const provider = 'azure';
  try {
    const planned = await runAzureBlobDeploy(projectRoot, config.deploy, buildArtifacts, log);
    finalizeDeploySuccess(stPath, t0, summaryHash, consumed, {
      provider,
      services: planned.services,
      deploy_url: planned.deploy_url,
      validationSummary: 'Azure 全自动部署（az storage blob upload-batch）',
    });
    return { code: 0, message: 'deploy 完成（azure provider）' };
  } catch (e) {
    const msg = e.message || String(e);
    const code = e.code === 'CONFIG' ? 1 : 8;
    finalizeDeployFailure(stPath, t0, summaryHash, consumed, {
      provider,
      errorMsg: msg,
      validationSummary: 'Azure Blob deploy 失败',
    });
    if (code === 8) return { code: 8, failed_step: 'deploy', message: msg };
    return { code: 1, failed_step: 'deploy', message: msg };
  }
}

module.exports = { runAzureBlobDeploy, executeAzureAndWriteStages };

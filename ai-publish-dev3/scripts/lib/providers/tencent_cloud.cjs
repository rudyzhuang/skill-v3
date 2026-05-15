'use strict';

const fs = require('fs');
const { matchArtifactsForService } = require('../artifacts.cjs');
const { mergeConfigEnvIntoProcess, resolveArtifactPath, deployableDir, resolveServiceName, runCmd } = require('./deploy-common.cjs');
const { finalizeDeploySuccess, finalizeDeployFailure } = require('./stage-write.cjs');

function requireRc(svc) {
  const rc = svc.resource_config && typeof svc.resource_config === 'object' ? svc.resource_config : {};
  if (!rc.cos_bucket || !String(rc.cos_bucket).trim()) {
    const e = new Error('tencent_cloud provider 要求 deploy.services[].resource_config.cos_bucket');
    e.code = 'CONFIG';
    throw e;
  }
  if (!rc.cos_endpoint_url || !String(rc.cos_endpoint_url).trim()) {
    const e = new Error('tencent_cloud provider 要求 deploy.services[].resource_config.cos_endpoint_url（如 https://cos.ap-guangzhou.myqcloud.com）');
    e.code = 'CONFIG';
    throw e;
  }
  return rc;
}

/**
 * 使用 AWS CLI S3 兼容接口同步到 COS（endpoint-url）。
 * @param {string} projectRoot
 * @param {object} deploy
 * @param {object[]} buildArtifacts
 * @param {(s:string)=>void} log
 */
async function runTencentCosDeploy(projectRoot, deploy, buildArtifacts, log) {
  const { childEnv, envMap } = mergeConfigEnvIntoProcess(projectRoot);
  const sid = String(envMap.get('TENCENTCLOUD_SECRETID') || envMap.get('COS_SECRET_ID') || '').trim();
  const skey = String(envMap.get('TENCENTCLOUD_SECRETKEY') || envMap.get('COS_SECRET_KEY') || '').trim();
  if (!sid || !skey) {
    const e = new Error(
      '腾讯云 COS 部署需要 docs/config.env 中 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY（或 COS_SECRET_ID / COS_SECRET_KEY）'
    );
    e.code = 'CONFIG';
    throw e;
  }
  childEnv.AWS_ACCESS_KEY_ID = sid;
  childEnv.AWS_SECRET_ACCESS_KEY = skey;

  const services = deploy.services || [];
  const arts = buildArtifacts || [];
  const outServices = [];
  let deployUrl = '';
  const defaultRegion = String((deploy && deploy.region) || 'ap-guangzhou').trim() || 'ap-guangzhou';

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
    const bucket = String(rc.cos_bucket).trim();
    const prefix = String(rc.cos_prefix || '').replace(/^\/+/, '');
    const endpoint = String(rc.cos_endpoint_url).trim();
    const region = String(rc.cos_region || deploy.region || defaultRegion).trim() || defaultRegion;
    childEnv.AWS_DEFAULT_REGION = region;
    const dest = prefix ? `s3://${bucket}/${prefix.replace(/\/+$/, '')}/` : `s3://${bucket}/`;
    const deleteExtra = rc.cos_sync_delete === true ? ' --delete' : '';
    runCmd(
      `aws s3 sync "${dir}" "${dest}" --endpoint-url "${endpoint}" --region "${region}"${deleteExtra}`,
      projectRoot,
      childEnv,
      log
    );

    const serviceName = resolveServiceName(svc);
    const url = String(rc.public_url || '').trim().replace(/\/$/, '');
    if (!url) {
      const e = new Error('请在 resource_config.public_url 填写站点访问 URL（CDN 或静态域名）');
      e.code = 'CONFIG';
      throw e;
    }
    if (!deployUrl) deployUrl = url;
    outServices.push({
      client_target: svc.client_target,
      service_name: serviceName,
      resource_type: svc.resource_type || 'cos_static',
      url,
      status: 'deployed',
      log_path: '',
    });
  }

  return { services: outServices, deploy_url: deployUrl };
}

async function executeTencentCloudAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log) {
  const t0 = Date.now();
  const provider = 'tencent_cloud';
  try {
    const planned = await runTencentCosDeploy(projectRoot, config.deploy, buildArtifacts, log);
    finalizeDeploySuccess(stPath, t0, summaryHash, consumed, {
      provider,
      services: planned.services,
      deploy_url: planned.deploy_url,
      validationSummary: '腾讯云 COS 全自动部署（aws s3 sync + COS endpoint）',
    });
    return { code: 0, message: 'deploy 完成（tencent_cloud provider）' };
  } catch (e) {
    const msg = e.message || String(e);
    const code = e.code === 'CONFIG' ? 1 : 8;
    finalizeDeployFailure(stPath, t0, summaryHash, consumed, {
      provider,
      errorMsg: msg,
      validationSummary: '腾讯云 COS deploy 失败',
    });
    if (code === 8) return { code: 8, failed_step: 'deploy', message: msg };
    return { code: 1, failed_step: 'deploy', message: msg };
  }
}

module.exports = { runTencentCosDeploy, executeTencentCloudAndWriteStages };

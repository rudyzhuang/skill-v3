'use strict';

const fs = require('fs');
const { matchArtifactsForService } = require('../artifacts.cjs');
const { mergeConfigEnvIntoProcess, resolveArtifactPath, deployableDir, resolveServiceName, runCmd } = require('./deploy-common.cjs');
const { finalizeDeploySuccess, finalizeDeployFailure } = require('./stage-write.cjs');

function requireRc(svc) {
  const rc = svc.resource_config && typeof svc.resource_config === 'object' ? svc.resource_config : {};
  if (!rc.oss_bucket || !String(rc.oss_bucket).trim()) {
    const e = new Error('alibaba_cloud provider 要求 deploy.services[].resource_config.oss_bucket');
    e.code = 'CONFIG';
    throw e;
  }
  return rc;
}

function ossPublicUrl(rc, bucket, prefix) {
  const p = String(rc.public_url || '').trim();
  if (p) return p.replace(/\/$/, '');
  const pf = (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const ep = String(rc.oss_endpoint || '').trim();
  if (ep) {
    const host = ep.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return `https://${bucket}.${host}/${pf ? `${pf}/` : ''}`.replace(/\/+$/, '');
  }
  return `https://${bucket}.oss.aliyuncs.com/${pf ? `${pf}/` : ''}`.replace(/\/+$/, '');
}

/**
 * @param {string} projectRoot
 * @param {object} deploy
 * @param {object[]} buildArtifacts
 * @param {(s:string)=>void} log
 */
async function runAlibabaOssDeploy(projectRoot, deploy, buildArtifacts, log) {
  const { childEnv, envMap } = mergeConfigEnvIntoProcess(projectRoot);
  const ak = String(envMap.get('ALIBABA_CLOUD_ACCESS_KEY_ID') || envMap.get('ALICLOUD_ACCESS_KEY') || '').trim();
  const sk = String(
    envMap.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET') || envMap.get('ALICLOUD_ACCESS_SECRET') || ''
  ).trim();
  if (!ak || !sk) {
    const e = new Error(
      '阿里云 OSS 部署需要 docs/config.env 中 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET（或 ALICLOUD_ACCESS_KEY / ALICLOUD_ACCESS_SECRET）'
    );
    e.code = 'CONFIG';
    throw e;
  }
  childEnv.ALIBABA_CLOUD_ACCESS_KEY_ID = ak;
  childEnv.ALIBABA_CLOUD_ACCESS_KEY_SECRET = sk;

  const services = deploy.services || [];
  const arts = buildArtifacts || [];
  const outServices = [];
  let deployUrl = '';
  const defaultRegion = String((deploy && deploy.region) || 'cn-hangzhou').trim() || 'cn-hangzhou';

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
    const bucket = String(rc.oss_bucket).trim();
    const prefix = String(rc.oss_prefix || '').replace(/^\/+/, '');
    const region = String(rc.oss_region || rc.region || defaultRegion).trim() || defaultRegion;
    const endpoint =
      String(rc.oss_endpoint || '').trim() ||
      `https://oss-${region}.aliyuncs.com`;
    const dest = prefix ? `oss://${bucket}/${prefix.replace(/\/+$/, '')}/` : `oss://${bucket}/`;
    runCmd(`aliyun oss cp -r -f "${dir}/" "${dest}" --endpoint "${endpoint}"`, projectRoot, childEnv, log);

    const serviceName = resolveServiceName(svc);
    const url = ossPublicUrl(rc, bucket, prefix);
    if (!deployUrl) deployUrl = url;
    outServices.push({
      client_target: svc.client_target,
      service_name: serviceName,
      resource_type: svc.resource_type || 'oss_static',
      url,
      status: 'deployed',
      log_path: '',
    });
  }

  return { services: outServices, deploy_url: deployUrl };
}

async function executeAlibabaCloudAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log) {
  const t0 = Date.now();
  const provider = 'alibaba_cloud';
  try {
    const planned = await runAlibabaOssDeploy(projectRoot, config.deploy, buildArtifacts, log);
    finalizeDeploySuccess(stPath, t0, summaryHash, consumed, {
      provider,
      services: planned.services,
      deploy_url: planned.deploy_url,
      validationSummary: '阿里云 OSS 全自动部署（aliyun oss cp）',
    });
    return { code: 0, message: 'deploy 完成（alibaba_cloud provider）' };
  } catch (e) {
    const msg = e.message || String(e);
    const code = e.code === 'CONFIG' ? 1 : 8;
    finalizeDeployFailure(stPath, t0, summaryHash, consumed, {
      provider,
      errorMsg: msg,
      validationSummary: '阿里云 OSS deploy 失败',
    });
    if (code === 8) return { code: 8, failed_step: 'deploy', message: msg };
    return { code: 1, failed_step: 'deploy', message: msg };
  }
}

module.exports = { runAlibabaOssDeploy, executeAlibabaCloudAndWriteStages };

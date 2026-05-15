'use strict';

const fs = require('fs');
const { matchArtifactsForService } = require('../artifacts.cjs');
const { mergeConfigEnvIntoProcess, resolveArtifactPath, deployableDir, resolveServiceName, runCmd } = require('./deploy-common.cjs');
const { finalizeDeploySuccess, finalizeDeployFailure } = require('./stage-write.cjs');

function requireRc(svc) {
  const rc = svc.resource_config && typeof svc.resource_config === 'object' ? svc.resource_config : {};
  if (!rc.s3_bucket || !String(rc.s3_bucket).trim()) {
    const e = new Error('aws provider 要求 deploy.services[].resource_config.s3_bucket');
    e.code = 'CONFIG';
    throw e;
  }
  return rc;
}

function inferPublicUrl(rc, region, bucket, prefix) {
  const p = String(rc.public_url || '').trim();
  if (p) return p.replace(/\/$/, '');
  const pf = (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (rc.cloudfront_distribution_id && rc.cloudfront_domain) {
    return `https://${String(rc.cloudfront_domain).replace(/^https?:\/\//i, '').replace(/\/$/, '')}`;
  }
  if (rc.s3_website_endpoint === true || rc.use_s3_website === true) {
    const web = `http://${bucket}.s3-website-${region}.amazonaws.com`;
    return pf ? `${web}/${pf}` : web;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${pf ? `${pf}/` : ''}`.replace(/\/+$/, '');
}

/**
 * @param {string} projectRoot
 * @param {object} deploy
 * @param {object[]} buildArtifacts
 * @param {(s:string)=>void} log
 */
async function runAwsDeploy(projectRoot, deploy, buildArtifacts, log) {
  const { childEnv, envMap } = mergeConfigEnvIntoProcess(projectRoot);
  const ak = String(envMap.get('AWS_ACCESS_KEY_ID') || '').trim();
  const sk = String(envMap.get('AWS_SECRET_ACCESS_KEY') || '').trim();
  if (!ak || !sk) {
    const e = new Error('AWS 部署需要 docs/config.env 中 AWS_ACCESS_KEY_ID 与 AWS_SECRET_ACCESS_KEY');
    e.code = 'CONFIG';
    throw e;
  }
  childEnv.AWS_ACCESS_KEY_ID = ak;
  childEnv.AWS_SECRET_ACCESS_KEY = sk;
  if (envMap.get('AWS_SESSION_TOKEN')) childEnv.AWS_SESSION_TOKEN = envMap.get('AWS_SESSION_TOKEN');

  const services = deploy.services || [];
  const arts = buildArtifacts || [];
  const outServices = [];
  let deployUrl = '';
  const defaultRegion = String((deploy && deploy.region) || 'us-east-1').trim() || 'us-east-1';

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
    const bucket = String(rc.s3_bucket).trim();
    const prefix = String(rc.s3_prefix || '').replace(/^\/+/, '');
    const region = String(rc.aws_region || rc.region || defaultRegion).trim() || defaultRegion;
    childEnv.AWS_DEFAULT_REGION = region;
    const dest = prefix ? `s3://${bucket}/${prefix.replace(/\/+$/, '')}/` : `s3://${bucket}/`;
    const deleteExtra = rc.s3_sync_delete === true ? ' --delete' : '';
    runCmd(`aws s3 sync "${dir}" "${dest}" --region "${region}"${deleteExtra}`, projectRoot, childEnv, log);

    const cfId = String(rc.cloudfront_distribution_id || '').trim();
    if (cfId) {
      runCmd(
        `aws cloudfront create-invalidation --distribution-id "${cfId}" --paths "/*" --region "${region}"`,
        projectRoot,
        childEnv,
        log
      );
    }

    const serviceName = resolveServiceName(svc);
    const url = inferPublicUrl(rc, region, bucket, prefix);
    if (!deployUrl) deployUrl = url;
    outServices.push({
      client_target: svc.client_target,
      service_name: serviceName,
      resource_type: svc.resource_type || 's3_static',
      url,
      status: 'deployed',
      log_path: '',
    });
  }

  return { services: outServices, deploy_url: deployUrl };
}

async function executeAwsAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log) {
  const t0 = Date.now();
  const provider = 'aws';
  try {
    const planned = await runAwsDeploy(projectRoot, config.deploy, buildArtifacts, log);
    finalizeDeploySuccess(stPath, t0, summaryHash, consumed, {
      provider,
      services: planned.services,
      deploy_url: planned.deploy_url,
      validationSummary: 'AWS 全自动部署（S3 sync + 可选 CloudFront invalidation）',
    });
    return { code: 0, message: 'deploy 完成（aws provider）' };
  } catch (e) {
    const msg = e.message || String(e);
    const code = e.code === 'CONFIG' ? 1 : 8;
    finalizeDeployFailure(stPath, t0, summaryHash, consumed, {
      provider,
      errorMsg: msg,
      validationSummary: 'AWS deploy 失败',
    });
    if (code === 8) return { code: 8, failed_step: 'deploy', message: msg };
    return { code: 1, failed_step: 'deploy', message: msg };
  }
}

module.exports = { runAwsDeploy, executeAwsAndWriteStages };

'use strict';

const fs = require('fs');
const path = require('path');
const { matchArtifactsForService } = require('../artifacts.cjs');
const { mergeConfigEnvIntoProcess, resolveArtifactPath, deployableDir, resolveServiceName, runCmd } = require('./deploy-common.cjs');
const { finalizeDeploySuccess, finalizeDeployFailure } = require('./stage-write.cjs');

function readFirebaseHostingPublic(projectRoot) {
  const p = path.join(projectRoot, 'firebase.json');
  if (!fs.existsSync(p)) {
    const e = new Error('google_cloud provider 需要项目根存在 firebase.json（Firebase Hosting）');
    e.code = 'CONFIG';
    throw e;
  }
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    const e = new Error(`firebase.json 解析失败: ${err.message}`);
    e.code = 'CONFIG';
    throw e;
  }
  const hosting = j.hosting;
  const pub =
    typeof hosting === 'string'
      ? hosting
      : hosting && typeof hosting === 'object' && !Array.isArray(hosting)
        ? hosting.public
        : Array.isArray(hosting) && hosting[0]
          ? hosting[0].public
          : '';
  if (!pub || !String(pub).trim()) {
    const e = new Error('firebase.json 缺少 hosting.public 配置');
    e.code = 'CONFIG';
    throw e;
  }
  return String(pub).trim();
}

/**
 * 将构建产物同步到 Firebase Hosting public 目录后执行 firebase deploy。
 * @param {string} projectRoot
 * @param {object} deploy
 * @param {object[]} buildArtifacts
 * @param {(s:string)=>void} log
 */
async function runGoogleFirebaseDeploy(projectRoot, deploy, buildArtifacts, log) {
  const { childEnv, envMap } = mergeConfigEnvIntoProcess(projectRoot);
  const token = String(envMap.get('FIREBASE_TOKEN') || '').trim();
  if (!token) {
    const e = new Error('Firebase Hosting 部署需要 docs/config.env 中 FIREBASE_TOKEN（CI token）');
    e.code = 'CONFIG';
    throw e;
  }
  childEnv.FIREBASE_TOKEN = token;

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
    const srcDir = deployableDir(artifactAbs);
    const rc = svc.resource_config && typeof svc.resource_config === 'object' ? svc.resource_config : {};
    const hostingPublicRel = String(rc.firebase_hosting_public || readFirebaseHostingPublic(projectRoot)).trim();
    const hostingAbs = path.join(projectRoot, hostingPublicRel);
    const skipSync = rc.skip_sync_artifact_to_hosting === true;
    if (!skipSync) {
      fs.mkdirSync(hostingAbs, { recursive: true });
      fs.cpSync(srcDir, hostingAbs, { recursive: true, force: true });
    }

    const serviceName = resolveServiceName(svc);
    const projectFlag = rc.firebase_project ? ` --project "${String(rc.firebase_project).replace(/"/g, '')}"` : '';
    const siteId = rc.firebase_hosting_site ? String(rc.firebase_hosting_site).replace(/"/g, '') : '';
    const onlyFlag = siteId ? ` --only hosting:${siteId}` : ' --only hosting';
    const cmd = `npx --yes firebase-tools deploy${onlyFlag} --non-interactive --token "${token.replace(/"/g, '')}"${projectFlag}`;
    runCmd(cmd, projectRoot, childEnv, log);

    const url = String(rc.public_url || '').trim().replace(/\/$/, '');
    if (!url) {
      const e = new Error('请在 resource_config.public_url 填写 Firebase Hosting 访问 URL（或站点默认域名）');
      e.code = 'CONFIG';
      throw e;
    }
    if (!deployUrl) deployUrl = url;
    outServices.push({
      client_target: svc.client_target,
      service_name: serviceName,
      resource_type: svc.resource_type || 'firebase_hosting',
      url,
      status: 'deployed',
      log_path: '',
    });
  }

  return { services: outServices, deploy_url: deployUrl };
}

async function executeGoogleCloudAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log) {
  const t0 = Date.now();
  const provider = 'google_cloud';
  try {
    const planned = await runGoogleFirebaseDeploy(projectRoot, config.deploy, buildArtifacts, log);
    finalizeDeploySuccess(stPath, t0, summaryHash, consumed, {
      provider,
      services: planned.services,
      deploy_url: planned.deploy_url,
      validationSummary: 'Google Cloud / Firebase Hosting 全自动部署（firebase-tools deploy）',
    });
    return { code: 0, message: 'deploy 完成（google_cloud provider）' };
  } catch (e) {
    const msg = e.message || String(e);
    const code = e.code === 'CONFIG' ? 1 : 8;
    finalizeDeployFailure(stPath, t0, summaryHash, consumed, {
      provider,
      errorMsg: msg,
      validationSummary: 'Firebase Hosting deploy 失败',
    });
    if (code === 8) return { code: 8, failed_step: 'deploy', message: msg };
    return { code: 1, failed_step: 'deploy', message: msg };
  }
}

module.exports = { runGoogleFirebaseDeploy, executeGoogleCloudAndWriteStages };

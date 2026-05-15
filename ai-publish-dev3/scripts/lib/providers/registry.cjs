'use strict';

const { validateEnvKeys } = require('../config-env.cjs');

/** @type {ReadonlySet<string>} */
const AUTOMATED_PROVIDERS = new Set([
  'cloudflare',
  'vercel',
  'aws',
  'alibaba_cloud',
  'tencent_cloud',
  'huawei_cloud',
  'google_cloud',
  'azure',
]);

/**
 * @param {string|undefined|null} provider
 */
function isAutomatedProvider(provider) {
  return AUTOMATED_PROVIDERS.has(String(provider || '').toLowerCase());
}

/**
 * @param {Map<string,string>} envMap
 * @param {string|undefined|null} provider
 * @returns {{ ok: boolean, message?: string }}
 */
function validateAutomatedProviderEnv(envMap, provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'manual') return { ok: true };
  if (!isAutomatedProvider(p)) {
    return { ok: false, message: `preflight: 未知 deploy.provider="${provider}"` };
  }
  if (p === 'cloudflare') {
    return validateEnvKeys(envMap, ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], { requireNonEmpty: true });
  }
  if (p === 'vercel') {
    return validateEnvKeys(envMap, ['VERCEL_TOKEN'], { requireNonEmpty: true });
  }
  if (p === 'aws') {
    return validateEnvKeys(envMap, ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], { requireNonEmpty: true });
  }
  if (p === 'alibaba_cloud') {
    const a = validateEnvKeys(envMap, ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'], {
      requireNonEmpty: true,
    });
    if (a.ok) return a;
    return validateEnvKeys(envMap, ['ALICLOUD_ACCESS_KEY', 'ALICLOUD_ACCESS_SECRET'], { requireNonEmpty: true });
  }
  if (p === 'tencent_cloud') {
    const a = validateEnvKeys(envMap, ['TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY'], { requireNonEmpty: true });
    if (a.ok) return a;
    return validateEnvKeys(envMap, ['COS_SECRET_ID', 'COS_SECRET_KEY'], { requireNonEmpty: true });
  }
  if (p === 'huawei_cloud') {
    const a = validateEnvKeys(envMap, ['HUAWEI_ACCESS_KEY_ID', 'HUAWEI_SECRET_ACCESS_KEY'], { requireNonEmpty: true });
    if (a.ok) return a;
    return validateEnvKeys(envMap, ['OBS_ACCESS_KEY_ID', 'OBS_SECRET_ACCESS_KEY'], { requireNonEmpty: true });
  }
  if (p === 'google_cloud') {
    return validateEnvKeys(envMap, ['FIREBASE_TOKEN'], { requireNonEmpty: true });
  }
  if (p === 'azure') {
    return validateEnvKeys(envMap, ['AZURE_STORAGE_CONNECTION_STRING'], { requireNonEmpty: true });
  }
  return { ok: true };
}

/**
 * @param {string|undefined|null} provider
 * @param {string} projectRoot
 * @param {object} config
 * @param {object[]} buildArtifacts
 * @param {object[]} consumed
 * @param {string} summaryHash
 * @param {string} stPath
 * @param {(s:string)=>void} log
 * @returns {Promise<{ code: number, message?: string, failed_step?: string }>}
 */
async function executeAutomatedDeploy(provider, projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log) {
  const p = String(provider || '').toLowerCase();
  if (p === 'cloudflare') {
    return require('./cloudflare.cjs').executeCloudflareAndWriteStages(
      projectRoot,
      config,
      buildArtifacts,
      consumed,
      summaryHash,
      stPath,
      log
    );
  }
  if (p === 'vercel') {
    return require('./vercel.cjs').executeVercelAndWriteStages(
      projectRoot,
      config,
      buildArtifacts,
      consumed,
      summaryHash,
      stPath,
      log
    );
  }
  if (p === 'aws') {
    return require('./aws.cjs').executeAwsAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log);
  }
  if (p === 'alibaba_cloud') {
    return require('./alibaba_cloud.cjs').executeAlibabaCloudAndWriteStages(
      projectRoot,
      config,
      buildArtifacts,
      consumed,
      summaryHash,
      stPath,
      log
    );
  }
  if (p === 'tencent_cloud') {
    return require('./tencent_cloud.cjs').executeTencentCloudAndWriteStages(
      projectRoot,
      config,
      buildArtifacts,
      consumed,
      summaryHash,
      stPath,
      log
    );
  }
  if (p === 'huawei_cloud') {
    return require('./huawei_cloud.cjs').executeHuaweiCloudAndWriteStages(
      projectRoot,
      config,
      buildArtifacts,
      consumed,
      summaryHash,
      stPath,
      log
    );
  }
  if (p === 'google_cloud') {
    return require('./google_cloud.cjs').executeGoogleCloudAndWriteStages(
      projectRoot,
      config,
      buildArtifacts,
      consumed,
      summaryHash,
      stPath,
      log
    );
  }
  if (p === 'azure') {
    return require('./azure.cjs').executeAzureAndWriteStages(projectRoot, config, buildArtifacts, consumed, summaryHash, stPath, log);
  }
  return { code: 1, failed_step: 'deploy', message: `内部错误: 未注册自动化 deploy.provider=${provider}` };
}

module.exports = {
  AUTOMATED_PROVIDERS,
  isAutomatedProvider,
  validateAutomatedProviderEnv,
  executeAutomatedDeploy,
};

'use strict';

const crypto = require('crypto');
const fs = require('fs');

function sha256Stable(obj) {
  const s = JSON.stringify(obj);
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * deploy 阶段 summary 输入面（publish3.md §6.3 子集；未含可选 api.yaml 列表）。
 * @param {object} configDeploy deploy 子树
 * @param {object[]} consumedArtifacts build.outputs.artifacts 中本次消费的行
 */
function deploySummaryInput(configDeploy, consumedArtifacts) {
  return {
    deploy: configDeploy,
    artifacts: consumedArtifacts.map((a) => ({
      client_target: a.client_target,
      sub_platform: a.sub_platform || '',
      artifact_path: a.artifact_path,
      status: a.status,
    })),
  };
}

/**
 * @param {object} smokeCfg config.smoke 子树
 * @param {string} baseUrl
 * @param {string} deployUrlHint
 * @param {object[]} [xSmokeForHash] 已与 config 合并后的检查项（publish3.md §6.3）
 */
function smokeSummaryInput(smokeCfg, baseUrl, deployUrlHint, xSmokeForHash) {
  return {
    smoke_checks: smokeCfg.checks || [],
    x_smoke_effective: xSmokeForHash || [],
    base_url: baseUrl || '',
    deploy_url: deployUrlHint || '',
  };
}

/**
 * @param {string} projectRoot
 * @param {string} configPath docs/config.dev.json 绝对路径
 */
function hashConfigDeploySubtree(projectRoot, configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const deploy = cfg.deploy || {};
  return deploy;
}

module.exports = {
  sha256Stable,
  deploySummaryInput,
  smokeSummaryInput,
  hashConfigDeploySubtree,
};

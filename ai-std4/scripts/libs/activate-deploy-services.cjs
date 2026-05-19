'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * prd-review 通过后：将 deploy.services[] 中 draft → active（便于 deploy provision）
 */
function activateDeployServicesOnPrdReviewPass(projectRoot, { log } = {}) {
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(configPath)) {
    return { changed: false, activated: 0 };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`config.dev.json 解析失败: ${e.message}`);
  }

  const services = (config.deploy && config.deploy.services) || [];
  let activated = 0;

  for (const s of services) {
    if (s.status === 'draft') {
      s.status = 'active';
      activated++;
    }
  }

  if (activated === 0) {
    return { changed: false, activated: 0 };
  }

  config.deploy = config.deploy || {};
  config.deploy.services = services;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  if (log) {
    log.info('file_updated', `prd-review 已将 ${activated} 个 deploy.services 从 draft 激活为 active`, {
      path: configPath,
      activated,
    });
  }

  return { changed: true, activated, configPath };
}

module.exports = { activateDeployServicesOnPrdReviewPass };

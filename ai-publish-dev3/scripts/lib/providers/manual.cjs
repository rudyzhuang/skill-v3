'use strict';

/**
 * manual provider：不调用云 API；从 JSON 中 domain + healthcheck_path 推导服务 URL（供 smoke 与审计）。
 * @param {object[]} services config.deploy.services
 * @returns {{ services: { client_target: string, service_name: string, resource_type: string, url: string, status: string, log_path: string }[], deploy_url: string }}
 */
function planManualDeploy(services) {
  const out = [];
  let deployUrl = '';
  for (const svc of services || []) {
    if (!svc || !svc.client_target) continue;
    const domain = (svc.domain || '').trim();
    let base = domain;
    if (domain && !/^https?:\/\//i.test(domain)) {
      base = `https://${domain}`;
    }
    const hp = (svc.healthcheck_path || '/').startsWith('/') ? svc.healthcheck_path : `/${svc.healthcheck_path || ''}`;
    const url = base ? `${base.replace(/\/$/, '')}${hp}` : '';
    if (!deployUrl && base) deployUrl = base.replace(/\/$/, '');
    out.push({
      client_target: svc.client_target,
      service_name: svc.service_name || svc.client_target,
      resource_type: svc.resource_type || 'manual',
      url,
      status: url ? 'deployed_manual' : 'skipped_no_domain',
      log_path: '',
    });
  }
  return { services: out, deploy_url: deployUrl };
}

module.exports = { planManualDeploy };

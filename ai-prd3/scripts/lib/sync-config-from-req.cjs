'use strict';

const { providerFromCloud } = require('./req-parse.cjs');

const WEB_DEPLOY_TARGETS = ['website', 'admin', 'backend'];

/**
 * @param {string} slug
 * @param {object} parsed
 * @param {object} [existing]
 */
function buildDeployService(slug, parsed, existing = {}) {
  const url = parsed.endpoint_urls[slug] || `${parsed.base_url}/${slug === 'backend' ? 'api' : slug}/`;
  const hostBase = parsed.base_url;
  const defaults = {
    website: {
      service_name: 'notes-website',
      resource_type: 'pages_project',
      runtime: 'static',
      healthcheck_path: '/website/',
      resource_config: { artifact_subdir: 'website/default', route_pattern: `${parsed.domain_host}/website/*` },
    },
    admin: {
      service_name: 'notes-admin',
      resource_type: 'pages_project',
      runtime: 'static',
      healthcheck_path: '/admin/',
      resource_config: { artifact_subdir: 'admin/default', route_pattern: `${parsed.domain_host}/admin/*` },
    },
    backend: {
      service_name: 'notes-api',
      resource_type: 'worker_script',
      runtime: 'nodejs',
      healthcheck_path: '/api/health',
      resource_config: { artifact_subdir: 'backend/default', route_pattern: `${parsed.domain_host}/api/*` },
    },
  }[slug] || {
    service_name: `notes-${slug}`,
    resource_type: 'pages_project',
    runtime: '',
    healthcheck_path: '/',
    resource_config: {},
  };

  return {
    client_target: slug,
    sub_platform: existing.sub_platform || 'default',
    service_name: existing.service_name || defaults.service_name,
    resource_type: existing.resource_type || defaults.resource_type,
    runtime: existing.runtime || defaults.runtime,
    region: existing.region || '',
    domain: url.startsWith('http') ? url.replace(/\/+$/, '') : hostBase,
    healthcheck_path: existing.healthcheck_path || defaults.healthcheck_path,
    create_if_missing: existing.create_if_missing !== undefined ? existing.create_if_missing : true,
    resource_config: { ...defaults.resource_config, ...(existing.resource_config || {}) },
  };
}

/**
 * Merge deploy.services for website/admin/backend from parsed req.
 * @param {object} configJson
 * @param {object} parsed
 * @param {string[]} [declaredSlugs] prd-spec client_targets; defaults to parsed.client_targets
 */
function syncDeployAndSmoke(configJson, parsed, declaredSlugs) {
  const slugs = (declaredSlugs || parsed.client_targets || []).filter((s) => WEB_DEPLOY_TARGETS.includes(s));
  const out = { ...configJson };
  const provider = providerFromCloud(parsed.cloud_platform);
  out.deploy = out.deploy || {};
  out.deploy.provider = provider === 'manual' ? out.deploy.provider || 'manual' : provider;
  if (parsed.base_url) {
    out.deploy.deploy_url = parsed.base_url;
  }

  const existingByTarget = {};
  for (const svc of out.deploy.services || []) {
    if (svc?.client_target) existingByTarget[svc.client_target] = svc;
  }

  const mergedServices = [...(out.deploy.services || [])];
  for (const slug of slugs) {
    const idx = mergedServices.findIndex((s) => s.client_target === slug);
    const built = buildDeployService(slug, parsed, existingByTarget[slug] || {});
    if (idx >= 0) mergedServices[idx] = { ...mergedServices[idx], ...built };
    else mergedServices.push(built);
  }
  out.deploy.services = mergedServices;

  out.smoke = out.smoke || {};
  if (parsed.base_url) out.smoke.base_url = parsed.base_url;
  out.smoke.enabled = out.smoke.enabled !== false;
  const checks = Array.isArray(out.smoke.checks) ? [...out.smoke.checks] : [];
  const hasApiHealth = checks.some((c) => c.path === '/api/health' || c.name === 'api-health');
  if (slugs.includes('backend') && !hasApiHealth) {
    checks.unshift({
      name: 'api-health',
      method: 'GET',
      path: '/api/health',
      expected_status: 200,
    });
  }
  out.smoke.checks = checks;

  return out;
}

/**
 * @param {object} configJson
 * @param {string[]} declaredSlugs from prd-spec
 */
function validateDeployServicesCoverage(configJson, declaredSlugs) {
  const need = (declaredSlugs || []).filter((s) => WEB_DEPLOY_TARGETS.includes(s));
  const have = new Set((configJson.deploy?.services || []).map((s) => s.client_target));
  const missing = need.filter((s) => !have.has(s));
  return { ok: missing.length === 0, missing };
}

module.exports = {
  WEB_DEPLOY_TARGETS,
  buildDeployService,
  syncDeployAndSmoke,
  validateDeployServicesCoverage,
};

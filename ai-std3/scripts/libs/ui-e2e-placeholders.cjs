'use strict';

/**
 * 占位符替换与 web base_url 解析（ui_e2e runner 共用）
 */

function substitutePlaceholders(text, vars) {
  let out = String(text || '');
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split(`{${k}}`).join(v == null ? '' : String(v));
  }
  return out;
}

/**
 * @param {object} config docs/config.*.json
 * @param {object} stagesDoc .pipeline/stages.json
 * @param {string} clientTarget website|admin
 */
function resolveWebBaseUrl(config, stagesDoc, clientTarget) {
  const ui = config.ui_e2e || {};
  const webCfg = (ui.web && ui.web[clientTarget]) || {};
  const explicit = String(webCfg.base_url || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const fromKey = String(webCfg.base_url_from || '').trim();
  if (fromKey === 'smoke.base_url' || fromKey === 'config.smoke.base_url') {
    const bu = (config.smoke && config.smoke.base_url) || '';
    if (bu) return String(bu).trim().replace(/\/$/, '');
  }

  const deploy = stagesDoc.stages?.deploy;
  const services = deploy?.outputs?.services || [];
  const deploymentUrls = deploy?.outputs?.deployment_urls || {};
  if (deploymentUrls[clientTarget]) {
    return String(deploymentUrls[clientTarget]).trim().replace(/\/$/, '');
  }

  const deployServicesCfg = config.deploy?.services || [];
  for (const svc of services) {
    if (svc.client_target !== clientTarget) continue;
    const cfgSvc = deployServicesCfg.find((s) => s.client_target === clientTarget);
    const domain = String(cfgSvc?.domain || '').trim();
    if (domain.startsWith('http')) return domain.replace(/\/$/, '');
    if (svc.url) return String(svc.url).trim().replace(/\/$/, '');
  }

  if (deploy?.outputs?.deploy_url && clientTarget === 'website') {
    return String(deploy.outputs.deploy_url).trim().replace(/\/$/, '');
  }

  if (fromKey.startsWith('deploy.services.')) {
    const m = fromKey.match(/^deploy\.services\.([^.]+)\.url$/);
    if (m) {
      const name = m[1];
      for (const svc of services) {
        if (svc.service_name === name || svc.client_target === name) {
          if (svc.url) return String(svc.url).trim().replace(/\/$/, '');
        }
      }
    }
  }

  const smokeBase =
    (config.smoke && config.smoke.base_url) ||
    stagesDoc.stages?.smoke?.inputs?.base_url ||
    '';
  return String(smokeBase).trim().replace(/\/$/, '');
}

function buildScenarioVars(config, baseUrl) {
  const envUser = process.env.UI_E2E_TEST_USER || process.env.AI_STD3_UI_E2E_TEST_USER || '';
  const envPass = process.env.UI_E2E_TEST_PASSWORD || process.env.AI_STD3_UI_E2E_TEST_PASSWORD || '';
  const cfgEnv = config.ui_e2e?.test_credentials || {};
  return {
    base_url: baseUrl || '',
    test_user: envUser || cfgEnv.test_user || 'e2e@test.local',
    test_password: envPass || cfgEnv.test_password || '',
  };
}

module.exports = {
  substitutePlaceholders,
  resolveWebBaseUrl,
  buildScenarioVars,
};

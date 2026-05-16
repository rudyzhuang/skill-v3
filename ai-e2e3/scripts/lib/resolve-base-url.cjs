'use strict';

/**
 * @param {object} config
 * @param {object} stagesDoc
 * @param {string} clientTarget website|admin
 */
function resolveWebBaseUrl(config, stagesDoc, clientTarget) {
  const ui = config.ui_e2e || {};
  const webCfg = (ui.web && ui.web[clientTarget]) || {};
  const fromKey = String(webCfg.base_url_from || '').trim();

  if (fromKey === 'smoke.base_url' || fromKey === 'config.smoke.base_url') {
    const bu = (config.smoke && config.smoke.base_url) || '';
    if (bu) return bu;
  }

  const deploy = stagesDoc.stages?.deploy;
  const services = deploy?.outputs?.services || [];
  for (const svc of services) {
    if (svc.client_target === clientTarget && svc.url) return String(svc.url).trim();
  }
  if (deploy?.outputs?.deploy_url && clientTarget === 'website') {
    return String(deploy.outputs.deploy_url).trim();
  }

  if (fromKey.startsWith('deploy.services.')) {
    const m = fromKey.match(/^deploy\.services\.([^.]+)\.url$/);
    if (m) {
      const name = m[1];
      for (const svc of services) {
        if (svc.service_name === name || svc.client_target === name) {
          if (svc.url) return String(svc.url).trim();
        }
      }
    }
  }

  const smokeBase = (config.smoke && config.smoke.base_url) || stagesDoc.stages?.smoke?.inputs?.base_url || '';
  return String(smokeBase).trim();
}

function substitutePlaceholders(text, vars) {
  let out = String(text || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v == null ? '' : String(v));
  }
  return out;
}

module.exports = { resolveWebBaseUrl, substitutePlaceholders };

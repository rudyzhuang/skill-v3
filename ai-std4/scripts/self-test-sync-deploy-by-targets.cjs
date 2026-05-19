'use strict';

/**
 *   node ai-std4/scripts/self-test-sync-deploy-by-targets.cjs
 */

const {
  parseClientTargetsFromMarkdown,
  parseDeployHintsFromReq,
  syncDeployConfig,
  deployableTargetsFrom,
} = require('./libs/sync-deploy-by-targets.cjs');

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`OK: ${msg}`);
  }
}

const reqSnippet = `
## 客户端目标 *
- admin
- backend

DOMAIN= dash.ai-ww.com
- admin  url = https://admin.<DOMAIN>
- backend  url = https://api.<DOMAIN>
`;

assert(
  parseClientTargetsFromMarkdown(reqSnippet).join(',') === 'admin,backend',
  'parseClientTargetsFromMarkdown',
);

const hints = parseDeployHintsFromReq(reqSnippet);
assert(hints.domain === 'dash.ai-ww.com', 'parse DOMAIN');
assert(hints.urls.admin === 'https://admin.dash.ai-ww.com', 'expand admin url');
assert(hints.urls.backend === 'https://api.dash.ai-ww.com', 'expand backend url');

const config = {
  deploy: {
    enabled: false,
    provider: 'cloudflare',
    domain: '',
    services: [
      { name: 'website', client_target: 'website', type: 'pages', domain: '', url: '' },
      { name: 'admin', client_target: 'admin', type: 'pages', domain: 'admin.dash.ai-ww.com', url: 'https://admin.dash.ai-ww.com' },
      { name: 'backend', client_target: 'backend', type: 'workers', domain: 'api.dash.ai-ww.com', url: 'https://api.dash.ai-ww.com' },
    ],
  },
  smoke: {
    checks: [
      { url: '{deploy.services.website.url}/', client_targets: ['website'], scope: 'deploy' },
      { url: '{deploy.services.backend.url}/health', client_targets: ['backend'], scope: 'deploy' },
    ],
  },
  ui_e2e: {
    web: {
      website: { base_url_from: 'deploy.services.website.url' },
      admin:   { base_url_from: 'deploy.services.admin.url' },
    },
  },
};

const r = syncDeployConfig(config, ['admin', 'backend'], { reqContent: reqSnippet });
assert(r.changed, 'sync marks changed');
assert(deployableTargetsFrom(['admin', 'backend']).join(',') === 'admin,backend', 'deployable set');
assert(config.deploy.services.length === 2, 'two services kept');
assert(!config.deploy.services.some(s => s.client_target === 'website'), 'website removed');
assert(!config.smoke.checks.some(c => (c.client_targets || []).includes('website')), 'website smoke removed');
assert(config.smoke.checks.some(c => (c.client_targets || []).includes('admin')), 'admin smoke added');
assert(!config.ui_e2e.web.website, 'ui_e2e website removed');
assert(config.ui_e2e.web.admin, 'ui_e2e admin kept');
assert(config.deploy.domain === 'dash.ai-ww.com', 'deploy.domain from req');

const configWithDb = {
  deploy: {
    enabled: false,
    provider: 'cloudflare',
    services: [
      {
        name: 'admin',
        client_target: 'admin',
        type: 'pages',
        domain: 'admin.dash.ai-ww.com',
        url: 'https://admin.dash.ai-ww.com',
      },
      {
        name: 'backend',
        role: 'api',
        client_target: 'backend',
        type: 'workers',
        domain: 'api.dash.ai-ww.com',
        url: 'https://api.dash.ai-ww.com',
      },
      {
        name: 'db',
        role: 'db',
        client_target: 'backend',
        type: 'd1',
        requires_artifact: false,
        resource_config: { database_name: 'dashstd4-d1' },
      },
    ],
  },
  smoke: { checks: [] },
};

syncDeployConfig(configWithDb, ['admin', 'backend'], { reqContent: reqSnippet });
assert(configWithDb.deploy.services.length === 3, 'workers + d1 both kept for backend');
assert(
  configWithDb.deploy.services.some(s => s.type === 'workers' && s.name === 'backend'),
  'backend workers kept',
);
assert(
  configWithDb.deploy.services.some(s => s.type === 'd1' && s.name === 'db'),
  'backend d1 kept',
);

if (failed > 0) process.exit(1);
console.log('\nAll tests passed.');

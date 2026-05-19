'use strict';

/**
 * sync-deploy-by-targets.cjs
 * 按 client_targets 裁剪 deploy.services[]、smoke.checks[]、ui_e2e.web，
 * 并从 req.md 合并域名/URL 提示（不删敏感字段）。
 */

const fs   = require('fs');
const path = require('path');

const DEPLOYABLE_TARGETS = new Set(['website', 'admin', 'backend']);
const WEB_UI_TARGETS     = new Set(['website', 'admin']);

const TARGET_ALIASES = {
  api:      'backend',
  server:   'backend',
  web:      'website',
  frontend: 'website',
};

const DEFAULT_SERVICES = {
  website: {
    name:          'website',
    client_target: 'website',
    type:          'pages',
    domain:        '',
    url:           '',
  },
  admin: {
    name:          'admin',
    client_target: 'admin',
    type:          'pages',
    domain:        '',
    url:           '',
  },
  backend: {
    name:          'backend',
    client_target: 'backend',
    type:          'workers',
    domain:        '',
    url:           '',
  },
};

const DEFAULT_SMOKE_BY_TARGET = {
  website: {
    url:             '{deploy.services.website.url}/',
    method:          'GET',
    expected_status: 200,
    client_targets:  ['website'],
    scope:           'deploy',
    safe:            true,
  },
  admin: {
    url:             '{deploy.services.admin.url}/',
    method:          'GET',
    expected_status: 200,
    client_targets:  ['admin'],
    scope:           'deploy',
    safe:            true,
  },
  backend: {
    url:             '{deploy.services.backend.url}/health',
    method:          'GET',
    expected_status: 200,
    client_targets:  ['backend'],
    scope:           'deploy',
    safe:            true,
  },
};

/**
 * 从 Markdown（req.md / prd-spec.md）解析 ## 客户端目标 列表
 * @param {string} content
 * @returns {string[]}
 */
function parseClientTargetsFromMarkdown(content) {
  const targets = [];
  let inSection = false;
  let inComment = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.includes('<!--')) inComment = true;
    if (trimmed.includes('-->')) { inComment = false; continue; }
    if (inComment) continue;

    if (/^##\s+客户端目标/.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(trimmed)) break;
    if (!inSection) continue;

    const m = trimmed.match(/^-\s+`?([a-zA-Z][a-zA-Z0-9_-]*)`?(?:\s|$|[—\-–,.;:])/);
    if (m) targets.push(normalizeClientTarget(m[1]));
  }
  return [...new Set(targets.filter(Boolean))];
}

/**
 * @param {string} ct
 * @returns {string}
 */
function normalizeClientTarget(ct) {
  if (!ct) return ct;
  const lower = String(ct).toLowerCase().trim();
  return TARGET_ALIASES[lower] || lower;
}

/**
 * @param {string[]} clientTargets
 * @returns {string[]} 可部署子集（保持原顺序：website → admin → backend）
 */
function deployableTargetsFrom(clientTargets) {
  const normalized = clientTargets.map(normalizeClientTarget);
  const wanted = new Set(normalized.filter(t => DEPLOYABLE_TARGETS.has(t)));
  return ['website', 'admin', 'backend'].filter(t => wanted.has(t));
}

/**
 * 从 req.md 解析 DOMAIN 与各端 URL（支持 <DOMAIN> 占位）
 * @param {string} content
 * @returns {{ domain: string|null, urls: Record<string, string> }}
 */
function parseDeployHintsFromReq(content) {
  const hints = { domain: null, urls: {} };
  if (!content) return hints;

  const domainMatch = content.match(/DOMAIN\s*=\s*(\S+)/i);
  const rootDomain  = domainMatch ? domainMatch[1].trim() : null;
  if (rootDomain) hints.domain = rootDomain;

  const expand = (url) => (rootDomain ? url.replace(/<DOMAIN>/gi, rootDomain) : url);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--') || trimmed.startsWith('#')) continue;

    const m = trimmed.match(
      /^-\s*(website|admin|backend|api|server|web)\b[^=]*=\s*(https?:\/\/\S+)/i,
    );
    if (!m) continue;

    const target = normalizeClientTarget(m[1]);
    if (!DEPLOYABLE_TARGETS.has(target)) continue;
    hints.urls[target] = expand(m[2].trim());
  }

  return hints;
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

/**
 * @param {object} config
 * @param {string[]} deployable
 * @param {object} hints
 */
function applyDeployHints(config, deployable, hints) {
  if (!config.deploy) config.deploy = {};
  if (hints.domain) config.deploy.domain = hints.domain;

  const services = config.deploy.services || [];
  for (const svc of services) {
    const ct = normalizeClientTarget(svc.client_target);
    const url = hints.urls[ct];
    if (!url) continue;
    svc.url    = url;
    svc.domain = hostnameFromUrl(url) || svc.domain || '';
  }
}

/**
 * 裁剪并补齐 deploy / smoke / ui_e2e
 * @param {object} config
 * @param {string[]} clientTargets
 * @param {{ reqContent?: string }} [opts]
 * @returns {{ changed: boolean, deployable: string[], servicesRemoved: string[], servicesAdded: string[] }}
 */
function syncDeployConfig(config, clientTargets, opts = {}) {
  const deployable = deployableTargetsFrom(clientTargets);
  const hints      = parseDeployHintsFromReq(opts.reqContent || '');

  const servicesRemoved = [];
  const servicesAdded   = [];

  if (!config.deploy) config.deploy = { enabled: false, provider: 'cloudflare', services: [] };
  if (!Array.isArray(config.deploy.services)) config.deploy.services = [];

  const beforeNames = config.deploy.services.map(s => s.name || s.client_target);
  const kept        = [];
  const byTarget    = new Map();

  for (const svc of config.deploy.services) {
    const ct = normalizeClientTarget(svc.client_target);
    if (deployable.includes(ct)) {
      kept.push(Object.assign({}, svc, { client_target: ct }));
      byTarget.set(ct, kept[kept.length - 1]);
    } else {
      servicesRemoved.push(svc.name || svc.client_target || ct);
    }
  }

  for (const ct of deployable) {
    if (!byTarget.has(ct)) {
      const added = Object.assign({}, DEFAULT_SERVICES[ct]);
      kept.push(added);
      byTarget.set(ct, added);
      servicesAdded.push(ct);
    }
  }

  const order = ['website', 'admin', 'backend'];
  config.deploy.services = order
    .filter(ct => byTarget.has(ct))
    .map(ct => byTarget.get(ct));

  applyDeployHints(config, deployable, hints);

  // smoke.checks
  if (!config.smoke) config.smoke = {};
  if (!Array.isArray(config.smoke.checks)) config.smoke.checks = [];

  config.smoke.checks = config.smoke.checks.filter(ch => {
    if (Array.isArray(ch.client_targets) && ch.client_targets.length > 0) {
      const refs = ch.client_targets.map(normalizeClientTarget);
      if (!refs.some(t => deployable.includes(t))) return false;
    }
    const url = ch.url || '';
    for (const ct of ['website', 'admin', 'backend']) {
      if (!deployable.includes(ct) && url.includes(`deploy.services.${ct}`)) return false;
    }
    return true;
  });

  for (const ct of deployable) {
    const hasCheck = config.smoke.checks.some(ch => {
      const refs = (ch.client_targets || []).map(normalizeClientTarget);
      return refs.includes(ct) || String(ch.url || '').includes(`deploy.services.${ct}`);
    });
    if (!hasCheck && DEFAULT_SMOKE_BY_TARGET[ct]) {
      config.smoke.checks.push(Object.assign({}, DEFAULT_SMOKE_BY_TARGET[ct]));
    }
  }

  // ui_e2e.web
  if (config.ui_e2e && config.ui_e2e.web && typeof config.ui_e2e.web === 'object') {
    for (const key of Object.keys(config.ui_e2e.web)) {
      const ct = normalizeClientTarget(key);
      if (WEB_UI_TARGETS.has(ct) && !deployable.includes(ct)) {
        delete config.ui_e2e.web[key];
      }
    }
  }

  const afterNames = config.deploy.services.map(s => s.name || s.client_target);
  const changed    = servicesRemoved.length > 0
    || servicesAdded.length > 0
    || beforeNames.join(',') !== afterNames.join(',');

  return {
    changed: changed || false,
    deployable,
    servicesRemoved,
    servicesAdded,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string[]} opts.clientTargets
 * @param {string} [opts.reqPath]
 * @param {object} [opts.log]
 * @returns {{ changed: boolean, configDevPath: string, configReleasePath: string, deployable: string[], servicesRemoved: string[], servicesAdded: string[] }}
 */
function syncDeployConfigFiles(opts) {
  const { projectRoot, clientTargets, log } = opts;
  const reqPath = opts.reqPath || path.join(projectRoot, 'inputs', 'req.md');

  let reqContent = '';
  if (fs.existsSync(reqPath)) {
    reqContent = fs.readFileSync(reqPath, 'utf8');
  }

  let targets = clientTargets && clientTargets.length > 0
    ? clientTargets.map(normalizeClientTarget)
    : parseClientTargetsFromMarkdown(reqContent);

  if (targets.length === 0) {
    return {
      changed:           false,
      configDevPath:     path.join(projectRoot, 'docs', 'config.dev.json'),
      configReleasePath: path.join(projectRoot, 'docs', 'config.release.json'),
      deployable:        [],
      servicesRemoved:   [],
      servicesAdded:     [],
      skipped:           true,
      reason:            'no_client_targets',
    };
  }

  const docsDir = path.join(projectRoot, 'docs');
  const paths   = [
    path.join(docsDir, 'config.dev.json'),
    path.join(docsDir, 'config.release.json'),
  ];

  let aggregate = {
    changed:         false,
    deployable:      [],
    servicesRemoved: [],
    servicesAdded:   [],
  };

  for (const configPath of paths) {
    if (!fs.existsSync(configPath)) continue;

    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`${configPath} JSON 解析失败: ${e.message}`);
    }

    const result = syncDeployConfig(config, targets, { reqContent });
    if (result.changed) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
      if (log && log.info) {
        log.info('file_updated', `已按 client_targets 同步 deploy 配置`, {
          path:              configPath,
          client_targets:    targets,
          deployable:        result.deployable,
          services_removed:  result.servicesRemoved,
          services_added:    result.servicesAdded,
        });
      }
    }

    aggregate.changed         = aggregate.changed || result.changed;
    aggregate.deployable      = result.deployable;
    aggregate.servicesRemoved = [...new Set([...aggregate.servicesRemoved, ...result.servicesRemoved])];
    aggregate.servicesAdded   = [...new Set([...aggregate.servicesAdded, ...result.servicesAdded])];
  }

  return Object.assign(aggregate, {
    configDevPath:     paths[0],
    configReleasePath: paths[1],
  });
}

if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => {
        const [k, ...v] = a.slice(2).split('=');
        return [k, v.join('=') || true];
      }),
  );

  const projectRoot = args.project
    ? path.resolve(args.project)
    : process.env.AI_STD4_PROJECT
      ? path.resolve(process.env.AI_STD4_PROJECT)
      : process.cwd();

  try {
    const result = syncDeployConfigFiles({ projectRoot, clientTargets: [] });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`[ERROR] sync-deploy-by-targets: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEPLOYABLE_TARGETS,
  parseClientTargetsFromMarkdown,
  parseDeployHintsFromReq,
  normalizeClientTarget,
  deployableTargetsFrom,
  syncDeployConfig,
  syncDeployConfigFiles,
};

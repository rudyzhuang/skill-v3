'use strict';

/**
 * infer-deploy-services.cjs — 从 PRD 推断 deploy.services[] 并 merge 进 docs/config.dev.json
 *
 * 推断 workers/pages + 云资源（d1/r2/kv）；deploy M2 对 active/draft 资源 provision 后部署 workers。
 */

const fs   = require('fs');
const path = require('path');
const { createPipelinePaths } = require('./pipeline-paths.cjs');
const { createArtifactPaths } = require('./artifact-paths.cjs');

const DEPLOYABLE_TYPES = new Set(['pages', 'workers']);
const RESOURCE_TYPES   = new Set(['d1', 'r2', 'kv', 'queues', 'durable_objects', 'dns']);

const R2_SIGNALS = /\b(r2|upload|object storage|bucket)\b|对象存储|文件上传|图片|视频/i;
const KV_SIGNALS = /\b(kv|cache|session store|rate limit)\b|缓存|限流/i;
const D1_SIGNALS = /\b(d1|sqlite|database)\b|持久化|关系型/i;
const QUEUE_SIGNALS = /\b(queue|queues|consumer|job)\b|队列|异步任务/i;
const DO_SIGNALS    = /\b(durable object|websocket)\b|实时|协同|房间/i;

const KNOWN_KINDS = new Set([
  ...DEPLOYABLE_TYPES,
  ...RESOURCE_TYPES,
  'worker',
]);

function normalizeResourceType(type) {
  const t = String(type || '').toLowerCase().replace(/^cloudflare\s+/, '').trim();
  if (t === 'worker') return 'workers';
  return t;
}

function hasBackendTarget(clientTargets) {
  return (clientTargets || []).some(ct => {
    const n = String(ct).toLowerCase();
    return n === 'backend' || n === 'api' || n === 'server';
  });
}

/**
 * 对比 Agent 写的 deploy.resources[] 与启发式期望；仅 warn，补全由 merge 完成。
 * @returns {{ warnings: string[], gaps: object[] }}
 */
function auditDeployResources({ prdBackend, clientTargets, allPrdDocs }) {
  const warnings = [];
  const gaps = [];

  if (!hasBackendTarget(clientTargets)) {
    return { warnings, gaps };
  }

  const dep = prdBackend && prdBackend.deploy;
  const list = dep && (dep.resources || dep.cloud_resources);

  if (!dep) {
    const msg = 'prd-backend.json 缺少 deploy 节；infer-deploy-services 将按 features/tech_stack 自动补全（不阻断 prd）';
    warnings.push(msg);
    gaps.push({ kind: '(deploy)', reason: 'missing deploy section' });
    return { warnings, gaps };
  }

  if (!Array.isArray(list) || list.length === 0) {
    warnings.push(
      'deploy.resources[] 为空或未填写；将根据 db_tables、acceptance、tech_stack 启发式自动补全（不阻断 prd）'
    );
  } else {
    for (const r of list) {
      if (!r || !r.kind) {
        warnings.push('deploy.resources[] 存在缺少 kind 的条目，已忽略该条');
        continue;
      }
      const k = normalizeResourceType(r.kind);
      if (!KNOWN_KINDS.has(k)) {
        warnings.push(
          `deploy.resources[] 含未知 kind="${r.kind}"（归一化后 ${k}），infer 将跳过；请使用 catalog 类型：d1|r2|kv|queues|durable_objects|workers|pages`
        );
      }
    }
  }

  const hasApiRuntime = dep.api && typeof dep.api === 'object' && !!dep.api.runtime;
  const hasServiceType = !!dep.service_type;
  if (!hasApiRuntime && !hasServiceType) {
    warnings.push(
      'deploy.api.runtime 与 deploy.service_type 均未填写；infer 将默认 workers（不阻断 prd）'
    );
  }

  const text = collectTextSignals(prdBackend, allPrdDocs || []);
  const explicit = explicitResources(prdBackend);
  const explicitTypes = new Set(explicit.map(e => normalizeResourceType(e.type)));
  const heuristic = heuristicResources(text, prdBackend);

  for (const h of heuristic) {
    const t = normalizeResourceType(h.type);
    if (explicitTypes.has(t)) continue;
    const msg =
      `deploy.resources[] 未声明 kind=${t}（role=${h.role}，依据：${h.reason}）；已/将自动补全至 config.dev.json（不阻断 prd）`;
    warnings.push(msg);
    gaps.push({ kind: t, role: h.role, reason: h.reason, status: h.status });
  }

  if (!explicitTypes.has('workers')) {
    const heurHasWorkers = heuristic.some(h => normalizeResourceType(h.type) === 'workers');
    if (!heurHasWorkers) {
      const msg =
        'deploy.resources[] 未声明 workers，且 deploy.api 未覆盖 runtime；将按 client_targets 自动补全 api/workers（不阻断 prd）';
      warnings.push(msg);
      gaps.push({ kind: 'workers', role: 'api', reason: 'client_targets includes backend' });
    }
  }

  return { warnings, gaps };
}

function slugify(name) {
  return String(name || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
}

function loadCatalog(skillsRoot) {
  const p = path.join(skillsRoot, 'docs', 'templates', 'deploy-services.catalog.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function getProviderBlock(catalog, providerId) {
  if (!catalog || !Array.isArray(catalog.providers)) return null;
  return catalog.providers.find(p => p.id === providerId) || null;
}

function getCatalogDefaults(providerBlock, serviceId) {
  const svc = (providerBlock && providerBlock.services || []).find(s => s.id === serviceId);
  if (!svc || !svc.config_defaults) return {};
  return JSON.parse(JSON.stringify(svc.config_defaults));
}

function collectTextSignals(prdBackend, allPrdDocs) {
  const parts = [];
  if (prdBackend) {
    parts.push(JSON.stringify(prdBackend.tech_stack || {}));
    parts.push(JSON.stringify(prdBackend.deploy || {}));
    parts.push(JSON.stringify(prdBackend.constraints || []));
    for (const f of prdBackend.features || []) {
      parts.push(f.description || '');
      parts.push((f.acceptance || []).join('\n'));
      parts.push((f.db_tables || []).join('\n'));
    }
  }
  for (const doc of allPrdDocs) {
    parts.push(JSON.stringify(doc.deploy || {}));
    for (const f of doc.features || []) {
      parts.push(f.description || '');
      parts.push((f.acceptance || []).join('\n'));
    }
  }
  return parts.join('\n');
}

function explicitResources(prdBackend) {
  const out = [];
  const dep = prdBackend && prdBackend.deploy;
  if (!dep) return out;

  const list = dep.resources || dep.cloud_resources;
  if (!Array.isArray(list)) return out;

  for (const r of list) {
    if (!r || !r.kind) continue;
    out.push({
      role:   r.role || r.kind,
      type:   normalizeResourceType(r.kind),
      reason: r.reason || 'prd.deploy.resources',
      status: r.status === 'optional' ? 'optional' : 'active',
    });
  }

  if (dep.api && typeof dep.api === 'object') {
    out.push({
      role:   'api',
      type:   normalizeResourceType(dep.api.runtime || dep.service_type || 'workers'),
      reason: 'prd.deploy.api',
      status: 'active',
    });
  }

  return out;
}

function heuristicResources(text, prdBackend) {
  const found = new Map();

  function add(role, type, reason, status) {
    const key = `${role}:${type}`;
    if (!found.has(key)) found.set(key, { role, type, reason, status: status || 'active' });
  }

  const hasDbTables = (prdBackend && prdBackend.features || []).some(
    f => Array.isArray(f.db_tables) && f.db_tables.length > 0
  );
  const dbStack = (prdBackend && prdBackend.tech_stack && prdBackend.tech_stack.db) || '';

  if (hasDbTables || D1_SIGNALS.test(dbStack) || D1_SIGNALS.test(text)) {
    add('db', 'd1', 'db_tables or tech_stack.db', 'active');
  }
  if (R2_SIGNALS.test(text)) {
    add('storage', 'r2', 'acceptance/tech mentions object storage', 'active');
  }
  if (KV_SIGNALS.test(text)) {
    add('cache', 'kv', 'cache/session signals', 'optional');
  }
  if (QUEUE_SIGNALS.test(text)) {
    add('queue', 'queues', 'async/queue signals', 'optional');
  }
  if (DO_SIGNALS.test(text)) {
    add('realtime', 'durable_objects', 'realtime signals', 'optional');
  }

  const framework = ((prdBackend && prdBackend.tech_stack && prdBackend.tech_stack.framework) || '').toLowerCase();
  const serviceType = ((prdBackend && prdBackend.deploy && prdBackend.deploy.service_type) || '').toLowerCase();
  if (/hono|worker|workers|cloudflare/.test(framework + serviceType + text)) {
    add('api', 'workers', 'backend edge runtime', 'active');
  }

  return [...found.values()];
}

function buildServiceEntry({
  role, type, slug, prdBackend, catalogDefaults, domainPlaceholder,
}) {
  const requiresArtifact = DEPLOYABLE_TYPES.has(type);
  const name = role === 'api' && type === 'workers' ? 'api' : role;

  const resourceConfig = Object.assign(
    {},
    catalogDefaults.resource_config || {}
  );

  if (type === 'workers') {
    resourceConfig.script_name = resourceConfig.script_name || `${slug}-api`;
    resourceConfig.route = resourceConfig.route || '';
  } else if (type === 'pages') {
    resourceConfig.project_name = resourceConfig.project_name || `${slug}-${role}`;
    resourceConfig.production_branch = resourceConfig.production_branch || 'main';
  } else if (type === 'd1') {
    resourceConfig.database_name = resourceConfig.database_name || `${slug}-d1`;
  } else if (type === 'r2') {
    resourceConfig.bucket_name = resourceConfig.bucket_name || `${slug}-assets`;
    resourceConfig.binding_name = resourceConfig.binding_name || 'R2_BUCKET';
  } else if (type === 'kv') {
    resourceConfig.namespace_title = resourceConfig.namespace_title || `${slug}-kv`;
    resourceConfig.binding_name = resourceConfig.binding_name || 'KV';
  } else if (type === 'queues') {
    resourceConfig.queue_name = resourceConfig.queue_name || `${slug}-jobs`;
    resourceConfig.binding_name = resourceConfig.binding_name || 'QUEUE';
  } else if (type === 'durable_objects') {
    resourceConfig.class_name = resourceConfig.class_name || `${slug.replace(/-/g, '')}DO`;
    resourceConfig.binding_name = resourceConfig.binding_name || 'DO';
    resourceConfig.migrations_tag = resourceConfig.migrations_tag || 'v1';
  }

  const domain = domainPlaceholder || '';
  const clientTarget = DEPLOYABLE_TYPES.has(type)
    ? (role === 'website' || role === 'admin' ? role : 'backend')
    : 'backend';

  return {
    name,
    role,
    client_target: clientTarget,
    type,
    requires_artifact: requiresArtifact,
    status:          'draft',
    domain,
    url:             '',
    resource_config: resourceConfig,
    _infer_reason:   undefined,
  };
}

function serviceKey(s) {
  return `${s.name || s.role || s.client_target}:${s.type}`;
}

function findExistingService(byKey, byCtType, inf) {
  return byKey.get(serviceKey(inf)) ||
    byCtType.get(`${inf.client_target}:${inf.type}`) ||
    null;
}

function mergeServices(existing, inferred, { log }) {
  const byKey = new Map();
  const byCtType = new Map();
  for (const s of existing) {
    const copy = Object.assign({}, s);
    byKey.set(serviceKey(s), copy);
    if (s.client_target && s.type) byCtType.set(`${s.client_target}:${s.type}`, copy);
  }

  let added = 0;
  let updated = 0;

  for (const inf of inferred) {
    const prev = findExistingService(byKey, byCtType, inf);
    const key = prev ? serviceKey(prev) : serviceKey(inf);
    if (!prev) {
      const copy = Object.assign({}, inf);
      delete copy._infer_reason;
      byKey.set(key, copy);
      if (copy.client_target && copy.type) {
        byCtType.set(`${copy.client_target}:${copy.type}`, copy);
      }
      added++;
      if (log) {
        log.info('deploy_infer_added', `推断新增 deploy service: ${inf.name} (${inf.type})`, {
          name: inf.name, type: inf.type, role: inf.role, reason: inf._infer_reason,
        });
      }
      continue;
    }

    if (prev.status === 'active' && prev.resource_config && Object.keys(prev.resource_config).length > 0) {
      continue;
    }

    const merged = Object.assign({}, prev, {
      role:              inf.role || prev.role,
      requires_artifact: inf.requires_artifact,
      resource_config:   Object.assign({}, inf.resource_config, prev.resource_config || {}),
    });
    if (!prev.status || prev.status === 'pending') merged.status = inf.status || 'draft';
    byKey.set(key, merged);
    updated++;
  }

  return { services: [...byKey.values()], added, updated };
}

function inferSmokeBackendCheck(services, existingChecks) {
  const apiSvc = services.find(s =>
    (s.name === 'api' || s.client_target === 'backend') && s.type === 'workers'
  );
  if (!apiSvc) return existingChecks;

  const placeholder = `{deploy.services.${apiSvc.name}.url}/health`;
  const has = (existingChecks || []).some(c =>
    c && String(c.url || '').includes('backend') && String(c.url).includes('health')
  );
  if (has) return existingChecks;

  return (existingChecks || []).concat([{
    url:             placeholder,
    method:          'GET',
    expected_status: 200,
    client_targets:  ['backend'],
    scope:           'deploy',
    safe:            true,
  }]);
}

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.skillsRoot
 * @param {string[]} opts.clientTargets
 * @param {object} [opts.log]
 * @returns {{ configPath: string, added: number, updated: number, warnings: string[] }}
 */
function applyDeployInference({ projectRoot, skillsRoot, clientTargets, log }) {
  const warnings = [];
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`config.dev.json 解析失败: ${e.message}`);
    }
  }

  const catalog = loadCatalog(skillsRoot);
  const providerId = (config.deploy && config.deploy.provider) || 'cloudflare';
  const providerBlock = getProviderBlock(catalog, providerId);

  const artifacts = createArtifactPaths(createPipelinePaths(projectRoot));
  const prdBackendPath = artifacts.resolvePrdClientJsonPath('prd-backend.json');
  let prdBackend = null;
  if (fs.existsSync(prdBackendPath)) {
    try {
      prdBackend = JSON.parse(fs.readFileSync(prdBackendPath, 'utf8'));
    } catch (_) { /* */ }
  }

  const allPrdDocs = [];
  for (const ct of clientTargets) {
    const file = ct === 'backend' || ct === 'api' || ct === 'server'
      ? 'prd-backend.json'
      : (ct === 'web' || ct === 'website' ? 'prd-web.json' : `prd-${ct}.json`);
    const p = artifacts.resolvePrdClientJsonPath(file);
    if (!fs.existsSync(p)) continue;
    try {
      allPrdDocs.push(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (_) { /* */ }
  }

  const projectName = (prdBackend && prdBackend.project_name) ||
    (config.project && config.project.name) ||
    'my-project';
  const slug = slugify(projectName);

  const domainPlaceholder = (prdBackend && prdBackend.deploy && prdBackend.deploy.domain) ||
    (prdBackend && prdBackend.deploy && prdBackend.deploy.api && prdBackend.deploy.api.domain) ||
    '';

  const text = collectTextSignals(prdBackend, allPrdDocs);

  const audit = auditDeployResources({ prdBackend, clientTargets, allPrdDocs });
  for (const w of audit.warnings) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  const resourceSpecs = [
    ...explicitResources(prdBackend),
    ...heuristicResources(text, prdBackend),
  ];

  const targets = new Set(clientTargets.map(t => t.toLowerCase()));
  const inferred = [];

  for (const spec of resourceSpecs) {
    let type = spec.type;
    if (type === 'worker') type = 'workers';
    if (!DEPLOYABLE_TYPES.has(type) && !RESOURCE_TYPES.has(type)) {
      warnings.push(`未知资源类型 ${type}（role=${spec.role}），已跳过`);
      continue;
    }
    const defaults = getCatalogDefaults(providerBlock, type) || {};
    const entry = buildServiceEntry({
      role:               spec.role,
      type,
      slug,
      prdBackend,
      catalogDefaults:    defaults,
      domainPlaceholder:  type === 'workers' ? domainPlaceholder : '',
    });
    entry._infer_reason = spec.reason;
    if (spec.status === 'optional') entry.status = 'draft';
    inferred.push(entry);
  }

  const PAGE_TARGETS = { website: 'website', web: 'website', admin: 'admin' };
  for (const ct of clientTargets) {
    const norm = ct.toLowerCase();
    const role = PAGE_TARGETS[norm];
    if (!role) continue;
    const defaults = getCatalogDefaults(providerBlock, 'pages') || {};
    inferred.push(Object.assign(
      buildServiceEntry({
        role,
        type: 'pages',
        slug,
        catalogDefaults: defaults,
        domainPlaceholder: '',
      }),
      { _infer_reason: `client_target=${ct}` }
    ));
  }

  if (targets.has('backend') || targets.has('api') || targets.has('server')) {
    const hasApi = inferred.some(s => s.type === 'workers' && (s.role === 'api' || s.name === 'api'));
    if (!hasApi) {
      const defaults = getCatalogDefaults(providerBlock, 'workers') || {};
      inferred.push(Object.assign(
        buildServiceEntry({
          role: 'api',
          type: 'workers',
          slug,
          catalogDefaults: defaults,
          domainPlaceholder,
        }),
        { _infer_reason: 'client_targets includes backend' }
      ));
    }
  }

  const existing = (config.deploy && config.deploy.services) || [];
  const { services, added, updated } = mergeServices(existing, inferred, { log });

  const resourceDraftCount = services.filter(s =>
    !DEPLOYABLE_TYPES.has(s.type) && s.status === 'draft'
  ).length;
  if (resourceDraftCount > 0) {
    warnings.push(
      `${resourceDraftCount} 个云资源为 draft；prd-review 通过后将激活，deploy 可 provision（dev 默认含 draft）`
    );
  }

  config.deploy = Object.assign({}, config.deploy || {}, {
    provider: providerId,
    services,
  });

  if (!config.project) config.project = {};
  if (!config.project.name) config.project.name = projectName;

  config.smoke = config.smoke || {};
  config.smoke.checks = inferSmokeBackendCheck(services, config.smoke.checks);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  if (log) {
    log.info('file_updated', '已应用 deploy.services 推断结果', {
      path: configPath,
      services_count: services.length,
      added,
      updated,
      warnings,
    });
  }

  return {
    configPath,
    added,
    updated,
    warnings,
    services,
    resource_audit: {
      gap_count: audit.gaps.length,
      gaps: audit.gaps,
    },
  };
}

function isResourceService(service) {
  const t = (service.type || '').toLowerCase();
  return service.requires_artifact === false || RESOURCE_TYPES.has(t);
}

function shouldProvisionResource(service, configName, deployCfg) {
  const status = service.status || 'draft';
  if (status === 'skipped' || status === 'blocked') return false;
  if (status === 'active') return true;
  if (status === 'draft') {
    if (configName === 'release' && deployCfg.provision_draft_resources === false) return false;
    return deployCfg.provision_draft_resources !== false;
  }
  return false;
}

function persistServiceResourceConfig(projectRoot, configName, serviceName, patch) {
  const configPath = path.join(projectRoot, 'docs', `config.${configName}.json`);
  if (!fs.existsSync(configPath)) return;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return;
  }
  const services = (config.deploy && config.deploy.services) || [];
  const idx = services.findIndex(s => (s.name || s.role) === serviceName);
  if (idx < 0) return;
  services[idx].resource_config = Object.assign(
    {},
    services[idx].resource_config || {},
    patch.resource_config || patch
  );
  if (patch.status) services[idx].status = patch.status;
  config.deploy.services = services;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

module.exports = {
  applyDeployInference,
  auditDeployResources,
  normalizeResourceType,
  slugify,
  DEPLOYABLE_TYPES,
  RESOURCE_TYPES,
  KNOWN_KINDS,
  isResourceService,
  shouldProvisionResource,
  persistServiceResourceConfig,
};

if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => {
        const [k, ...v] = a.slice(2).split('=');
        return [k, v.join('=') || true];
      })
  );
  const projectRoot = args.project
    ? path.resolve(args.project)
    : process.env.AI_STD3_PROJECT
      ? path.resolve(process.env.AI_STD3_PROJECT)
      : process.cwd();
  const skillsRoot = process.env.CURSOR_SKILLS_ROOT ||
    path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

  const artifactsCli = createArtifactPaths(createPipelinePaths(projectRoot));
  const specPath = artifactsCli.resolvePrdSpecPath();
  let clientTargets = ['backend'];
  if (fs.existsSync(specPath)) {
    const content = fs.readFileSync(specPath, 'utf8');
    const targets = [];
    let inSection = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (/^##\s+客户端目标/.test(trimmed)) { inSection = true; continue; }
      if (inSection && /^##\s+/.test(trimmed)) break;
      if (!inSection) continue;
      const m = trimmed.match(/^-\s+([a-zA-Z][a-zA-Z0-9_-]*)(?:\s|$)/);
      if (m) targets.push(m[1].toLowerCase());
    }
    if (targets.length) clientTargets = [...new Set(targets)];
  }

  try {
    const r = applyDeployInference({ projectRoot, skillsRoot, clientTargets, log: null });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

'use strict';

const { ALLOWED_SLUGS } = require('./raw-input.cjs');

function collectSection(content, headingCandidates) {
  const headings = Array.isArray(headingCandidates) ? headingCandidates : [headingCandidates];
  const lines = content.split('\n');
  let inSection = false;
  const out = [];

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (inSection) break;
      const titleText = line
        .replace(/^##\s+/, '')
        .replace(/[\s*]+$/, '')
        .trim();
      if (headings.some((h) => titleText === h || titleText.startsWith(`${h} `))) {
        inSection = true;
        continue;
      }
    }
    if (!inSection) continue;
    if (/^\s*<!--/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;
    if (/^---+\s*$/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** @param {string} host e.g. notes.yunapp.org */
function normalizeHost(host) {
  const h = String(host || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return h;
}

function expandDomainPlaceholders(text, host) {
  const h = normalizeHost(host);
  let out = String(text || '').replace(/<domain>/gi, h);
  // 常见笔误：https://<domain>.website/ → https://<domain>/website/
  out = out.replace(new RegExp(`https://${h.replace(/\./g, '\\.')}\\.website/`, 'i'), `https://${h}/website/`);
  return out;
}

/**
 * @param {string} content req.md body
 */
function parseRawRequirements(content) {
  const domainBlock = collectSection(content, ['主域名 domain', '主域名']);
  const domainLine =
    domainBlock
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^下面使用/i.test(l) && !/^<domain>/i.test(l)) || '';
  const domainHost = normalizeHost(domainLine);

  const cloud = collectSection(content, ['云平台']).split('\n')[0]?.trim() || '';

  const targetsBlock = collectSection(content, ['端（Client Targets）', '端 (Client Targets)']);
  const clientTargets = [];
  const endpointUrls = {};

  for (const line of targetsBlock.split('\n')) {
    const m = line.match(/^-\s*(\w+)\s*[（(].*URL:\s*([^）)]+)[）)]/i);
    if (!m) {
      const slugOnly = line.match(/^-\s*(\w+)\s*[（(]/);
      if (slugOnly && ALLOWED_SLUGS.has(slugOnly[1].toLowerCase())) {
        const slug = slugOnly[1].toLowerCase();
        if (!clientTargets.includes(slug)) clientTargets.push(slug);
      }
      continue;
    }
    const slug = m[1].toLowerCase();
    if (!ALLOWED_SLUGS.has(slug)) continue;
    if (!clientTargets.includes(slug)) clientTargets.push(slug);
    const url = expandDomainPlaceholders(m[2].trim(), domainHost);
    endpointUrls[slug] = url;
  }

  const deployBlock = collectSection(content, ['部署说明']);
  const deployUrls = {};
  for (const line of deployBlock.split('\n')) {
    const m = line.match(/^(website|admin|backend)\s+使用\s+URL[：:]\s*(\S+)/i);
    if (m) deployUrls[m[1].toLowerCase()] = expandDomainPlaceholders(m[2], domainHost);
  }

  for (const slug of Object.keys(deployUrls)) {
    if (!endpointUrls[slug]) endpointUrls[slug] = deployUrls[slug];
  }

  const baseUrl = domainHost ? `https://${domainHost}` : '';

  return {
    domain_host: domainHost,
    base_url: baseUrl,
    cloud_platform: cloud,
    client_targets: clientTargets,
    endpoint_urls: endpointUrls,
  };
}

/**
 * Infer which artifacts likely need Agent edits when raw input changes.
 * @param {object} parsed parseRawRequirements()
 * @param {{ previous?: object }} [ctx]
 */
function inferImpactHints(parsed, ctx = {}) {
  const hints = [];
  if (parsed.domain_host) {
    hints.push({
      category: 'domain',
      severity: 'high',
      artifacts: [
        'docs/prd-spec.md',
        'docs/config.dev.json',
        'docs/config.release.json',
        'docs/*/prd.md',
      ],
      reason: `主域名/基址为 ${parsed.base_url}；须同步各端 URL 与 deploy/smoke 配置`,
      agent_action: '更新 prd-spec 部署与各端专属 URL；运行 apply-raw-input-config 同步 config',
      script_action: 'apply-raw-input-config 可自动写入 deploy.services 与 smoke',
    });
  }
  if (parsed.client_targets?.length) {
    hints.push({
      category: 'client_targets',
      severity: 'medium',
      artifacts: ['docs/prd-spec.md#client-targets', 'docs/*/feature_list.md'],
      reason: `声明端: ${parsed.client_targets.join(', ')}`,
      agent_action: '若端集合变化，改 prd-spec 端列表并派生各端文档',
      script_action: 'bootstrap --force 可重派生 feature_list',
    });
  }
  if (ctx.functional_change) {
    hints.push({
      category: 'features',
      severity: 'high',
      artifacts: ['docs/prd-spec.md#6-核心功能', 'docs/*/feature_list.md'],
      reason: '功能需求段落相对缓存有变更',
      agent_action: '由 Agent 按 prompts/raw-input-impact.md 增删改 feature 与派生稿',
      script_action: null,
    });
  }
  return hints;
}

function providerFromCloud(cloud) {
  const c = String(cloud || '').toLowerCase();
  if (c.includes('cloudflare')) return 'cloudflare';
  if (c.includes('aws') || c.includes('amazon')) return 'aws';
  if (c.includes('alibaba') || c.includes('阿里')) return 'alibaba_cloud';
  if (c.includes('tencent') || c.includes('腾讯')) return 'tencent_cloud';
  return 'manual';
}

module.exports = {
  collectSection,
  parseRawRequirements,
  inferImpactHints,
  providerFromCloud,
  normalizeHost,
  expandDomainPlaceholders,
};

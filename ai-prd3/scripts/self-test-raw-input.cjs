#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { parseRawRequirements, expandDomainPlaceholders } = require('./lib/req-parse.cjs');
const { syncDeployAndSmoke, validateDeployServicesCoverage } = require('./lib/sync-config-from-req.cjs');

const sample = `# req

## 功能需求
笔记 CRUD

## 云平台
Cloudflare

## 主域名 domain
notes.yunapp.org

下面使用 <domain>来引用该域名

## 端（Client Targets）
- website（URL: https://<domain>.website/）
- admin（URL: https://<domain>/admin/）
- backend（URL: https://<domain>/api/）
- mobile（Flutter）
`;

const parsed = parseRawRequirements(sample);
assert.strictEqual(parsed.domain_host, 'notes.yunapp.org');
assert.strictEqual(parsed.base_url, 'https://notes.yunapp.org');
assert.ok(parsed.endpoint_urls.website.includes('/website/'));
assert.ok(parsed.endpoint_urls.admin.endsWith('/admin/'));
assert.ok(parsed.endpoint_urls.backend.endsWith('/api/'));
assert.deepStrictEqual(
  parsed.client_targets.sort(),
  ['admin', 'backend', 'mobile', 'website'].sort(),
);

const cfg = syncDeployAndSmoke(
  { deploy: { services: [] }, smoke: { checks: [] } },
  parsed,
  ['website', 'admin', 'backend', 'mobile'],
);
const cov = validateDeployServicesCoverage(cfg, ['website', 'admin', 'backend', 'mobile']);
assert.strictEqual(cov.ok, true, cov.missing);
assert.strictEqual(cfg.deploy.services.length, 3);
assert.strictEqual(cfg.smoke.base_url, 'https://notes.yunapp.org');
assert.strictEqual(cfg.deploy.provider, 'cloudflare');

assert.strictEqual(
  expandDomainPlaceholders('https://<domain>.website/', 'notes.yunapp.org'),
  'https://notes.yunapp.org/website/',
);

console.log('self-test-raw-input: passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseRawRequirements, expandDomainPlaceholders } = require('./lib/req-parse.cjs');
const { syncDeployAndSmoke, validateDeployServicesCoverage } = require('./lib/sync-config-from-req.cjs');
const {
  loadRawInputContent,
  detectRawInputDrift,
  sha256Text,
  RAW_INPUT_SNAPSHOT_REL,
} = require('./lib/raw-input.cjs');

const sample = `# req

## 功能需求
笔记 CRUD

## 云平台
Cloudflare

## 主域名 domain
notes.yunapp.org

## 端（Client Targets）
- website（URL: https://<domain>/website/）
- admin（URL: https://<domain>/admin/）
- backend（URL: https://<domain>/api/）
`;

const parsed = parseRawRequirements(sample);
assert.strictEqual(parsed.domain_host, 'notes.yunapp.org');
assert.strictEqual(parsed.base_url, 'https://notes.yunapp.org');

const cfg = syncDeployAndSmoke(
  { deploy: { services: [] }, smoke: { checks: [] } },
  parsed,
  ['website', 'admin', 'backend'],
);
assert.strictEqual(validateDeployServicesCoverage(cfg, ['website', 'admin', 'backend']).ok, true);
assert.strictEqual(cfg.deploy.services.length, 3);

assert.strictEqual(
  expandDomainPlaceholders('https://<domain>.website/', 'notes.yunapp.org'),
  'https://notes.yunapp.org/website/',
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-prd3-raw-'));
const inline = `${sample}\n## 鉴权信息\nin config.env\n`;
const loaded = loadRawInputContent(tmp, {}, { rawInputText: inline });
assert.strictEqual(loaded.ok, true);
assert.strictEqual(loaded.source, 'inline');
assert.strictEqual(loaded.path, RAW_INPUT_SNAPSHOT_REL);
assert.ok(fs.existsSync(path.join(tmp, RAW_INPUT_SNAPSHOT_REL)));
assert.strictEqual(loaded.content_hash, sha256Text(inline));

const drift1 = detectRawInputDrift(tmp, { rawInputText: inline, updateCache: true });
assert.strictEqual(drift1.ok, true);
assert.strictEqual(drift1.changed, true);

const drift2 = detectRawInputDrift(tmp, {});
assert.strictEqual(drift2.ok, true);
assert.strictEqual(drift2.source, 'inline');
assert.strictEqual(drift2.changed, false);

fs.mkdirSync(path.join(tmp, 'inputs'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'inputs', 'req.md'), `${sample}\nfile-marker\n`, 'utf8');
const fromFile = loadRawInputContent(tmp, JSON.parse(fs.readFileSync(path.join(tmp, '.pipeline', 'stages.json'), 'utf8')), {});
assert.strictEqual(fromFile.source, 'inline', '缓存为 inline 时不应被文件覆盖');

fs.rmSync(tmp, { recursive: true, force: true });

const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-prd3-raw-'));
fs.mkdirSync(path.join(tmp2, 'inputs'), { recursive: true });
fs.writeFileSync(path.join(tmp2, 'inputs', 'req.md'), sample, 'utf8');
const fileLoad = loadRawInputContent(tmp2, {}, {});
assert.strictEqual(fileLoad.source, 'file');
assert.strictEqual(fileLoad.path, 'inputs/req.md');
fs.rmSync(tmp2, { recursive: true, force: true });

console.log('self-test-raw-input: passed');

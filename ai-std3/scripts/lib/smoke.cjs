#!/usr/bin/env node
/**
 * smoke.cjs — stage: smoke
 *
 * 规范: docs/spec/std3.md §1 smoke.cjs
 *
 * 读取 docs/config.dev.json.smoke.checks[]，对每条 check 发 HTTP 请求并校验。
 */

'use strict';

const fs          = require('fs');
const path        = require('path');
const http        = require('http');
const https       = require('https');
const { URL }     = require('url');
const { readStages, updateStage, sha256Text } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[smoke] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages) { console.error('[smoke] ❌ stages.json 不存在'); process.exit(1); }

const deploy = stages.stages.deploy;
if (!['completed', 'skipped'].includes(deploy.status)) {
  console.error('[smoke] ❌ 上游门闸失败：deploy 未完成或跳过');
  process.exit(1);
}

updateStage(projectRoot, 'smoke', { status: 'running', started_at: new Date().toISOString() });

// ── 读取 smoke checks ──────────────────────────────────────────────────────
const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }

const smokeCfg = cfg.smoke || {};
const checks   = smokeCfg.checks || [];

if (checks.length === 0) {
  console.log('[smoke] ℹ 无 smoke.checks 配置，跳过 smoke');
  updateStage(projectRoot, 'smoke', {
    status: 'completed',
    completed_at: new Date().toISOString(),
    outputs: { checks: [], skip_reason: '无 smoke checks 配置' },
    validation: { passed: true, checked_at: new Date().toISOString(), summary: 'skipped (no checks)' },
  });
  process.exit(0);
}

// ── 解析 {deploy.services.*.url} 占位符 ────────────────────────────────────
const deployedServices = (deploy.outputs && deploy.outputs.services) || [];
function resolvePlaceholders(str) {
  return str.replace(/\{deploy\.services\.(\w+)\.url\}/g, (_, target) => {
    const svc = deployedServices.find(s => s.client_target === target);
    return (svc && svc.url) || str;
  });
}

// ── HTTP 请求 ──────────────────────────────────────────────────────────────
function httpGet(urlStr, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 4096) body = body.slice(0, 4096); });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ── 执行检查 ───────────────────────────────────────────────────────────────
async function runChecks() {
  const results = [];
  let anyFailed = false;
  const timeoutS = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.smoke_s) || 120;

  for (const check of checks) {
    const url = resolvePlaceholders(check.url || check.path || '');
    if (!url || url.startsWith('{')) {
      console.warn(`[smoke] ⚠ 无法解析 URL: ${check.url || check.path}，跳过`);
      results.push({ name: check.name || url, url, passed: false, error: '无法解析 URL' });
      anyFailed = true;
      continue;
    }

    const expectedStatus = check.expected_status || 200;
    const bodyContains   = check.body_contains || null;

    try {
      const startMs = Date.now();
      const { statusCode, body } = await httpGet(url, timeoutS * 1000);
      const latencyMs = Date.now() - startMs;

      let passed = statusCode === expectedStatus;
      let error  = '';

      if (passed && bodyContains && !body.includes(bodyContains)) {
        passed = false;
        error  = `响应体不含: "${bodyContains}"`;
      }

      if (!passed && !error) error = `状态码 ${statusCode} ≠ ${expectedStatus}`;

      console.log(`[smoke] ${passed ? '✅' : '❌'} ${url} → ${statusCode} (${latencyMs}ms)${error ? ' ' + error : ''}`);
      results.push({ name: check.name || url, url, status_code: statusCode, passed, latency_ms: latencyMs, error });
      if (!passed) anyFailed = true;
    } catch (e) {
      console.error(`[smoke] ❌ ${url} → 请求失败: ${e.message}`);
      results.push({ name: check.name || url, url, passed: false, error: e.message });
      anyFailed = true;
    }
  }

  if (anyFailed) {
    updateStage(projectRoot, 'smoke', {
      status: 'failed',
      outputs: { checks: results },
      validation: { passed: false, summary: '部分 smoke check 失败' },
    });
    process.exit(4);
  }

  updateStage(projectRoot, 'smoke', {
    status: 'completed',
    completed_at: new Date().toISOString(),
    inputs: { summary_hash: sha256Text(JSON.stringify(results)) },
    outputs: { checks: results },
    validation: { passed: true, checked_at: new Date().toISOString(), summary: `${results.length} checks passed` },
  });

  console.log(`[smoke] ✅ smoke 完成（${results.length} checks）`);
  process.exit(0);
}

runChecks().catch(e => {
  console.error(`[smoke] ❌ 未预期错误: ${e.message}`);
  process.exit(1);
});

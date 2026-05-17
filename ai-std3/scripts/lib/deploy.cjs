#!/usr/bin/env node
/**
 * deploy.cjs — stage: deploy
 *
 * 规范: docs/spec/std3.md §1 deploy.cjs
 *
 * 读取 docs/config.dev.json 与 docs/config.env，调用对应 provider 部署。
 * 目前仅实现 manual（无操作）与 cloudflare（pages wrangler）。
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const { readStages, updateStage, sha256Text } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[deploy] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages || stages.stages.build.status !== 'completed') {
  console.error('[deploy] ❌ 上游门闸失败：build 未完成');
  process.exit(1);
}

updateStage(projectRoot, 'deploy', { status: 'running', started_at: new Date().toISOString() });

// ── 读取配置 ───────────────────────────────────────────────────────────────
const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }

const deployCfg = cfg.deploy || {};
const enabled   = deployCfg.enabled !== false;

if (!enabled) {
  console.log('[deploy] ℹ deploy.enabled=false，跳过部署');
  updateStage(projectRoot, 'deploy', {
    status: 'skipped',
    completed_at: new Date().toISOString(),
    outputs: { environment: 'dev', services: [], skip_reason: 'deploy.enabled=false' },
    validation: { passed: true, checked_at: new Date().toISOString(), summary: 'skipped' },
  });
  process.exit(0);
}

// ── Destructive 保护 ────────────────────────────────────────────────────────
const autorunAllowDestructive =
  cfg.pipeline && cfg.pipeline.autorun && cfg.pipeline.autorun.allow_destructive_deploy;
if (!autorunAllowDestructive && !args['explicitConfirm']) {
  console.error('[deploy] ❌ Destructive deploy 未授权。');
  console.error('[deploy]   设置 config.dev.json pipeline.autorun.allow_destructive_deploy=true');
  console.error('[deploy]   或添加 --explicit-confirm 手工确认。');
  process.exit(1);
}

// ── 加载 config.env ────────────────────────────────────────────────────────
const envPath = path.join(projectRoot, 'docs', 'config.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ── 执行部署 ───────────────────────────────────────────────────────────────
const provider = (deployCfg.provider || process.env.CLOUD_PROVIDER || 'manual').toLowerCase();
const services  = deployCfg.services || [];
const artifacts = stages.stages.build.outputs.artifacts || [];
const deployed  = [];

console.log(`[deploy] provider: ${provider}`);

for (const svc of services) {
  const artifact = artifacts.find(a => a.client_target === svc.client_target);
  if (!artifact || artifact.status !== 'completed') {
    console.warn(`[deploy] ⚠ ${svc.client_target}: 无有效构建产物，跳过`);
    deployed.push({ client_target: svc.client_target, status: 'skipped', url: '' });
    continue;
  }

  console.log(`[deploy] ▶ 部署 ${svc.client_target} (${provider})`);
  let deployedUrl = svc.url || '';

  if (provider === 'cloudflare') {
    // Cloudflare Pages: wrangler pages deploy <artifact_path> --project-name <name>
    const projectName = svc.cloudflare_project || svc.service_name || `${path.basename(projectRoot)}-${svc.client_target}`;
    const artPath     = artifact.artifact_path;
    const r = spawnSync('npx', ['wrangler', 'pages', 'deploy', artPath, '--project-name', projectName], {
      cwd: projectRoot, stdio: 'inherit', env: process.env, timeout: 300000,
    });
    if (r.status !== 0) {
      console.error(`[deploy] ❌ ${svc.client_target} 部署失败`);
      deployed.push({ client_target: svc.client_target, status: 'failed', url: '' });
      updateStage(projectRoot, 'deploy', {
        status: 'failed',
        outputs: { environment: 'dev', services: deployed },
        validation: { passed: false, summary: `${svc.client_target} deploy failed` },
      });
      process.exit(1);
    }
    deployedUrl = deployedUrl || `https://${projectName}.pages.dev`;
  } else if (provider === 'manual') {
    console.log(`[deploy] ℹ ${svc.client_target}: manual deploy，跳过命令执行`);
  } else {
    console.warn(`[deploy] ⚠ ${provider}: 暂不支持自动部署，请手工部署后更新 stages.json`);
  }

  deployed.push({ client_target: svc.client_target, status: 'completed', url: deployedUrl });
  console.log(`[deploy] ✅ ${svc.client_target} → ${deployedUrl}`);
}

updateStage(projectRoot, 'deploy', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(JSON.stringify(deployed)) },
  outputs: { environment: 'dev', provider, services: deployed },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `${deployed.length} services deployed` },
});

console.log(`[deploy] ✅ deploy 完成`);
process.exit(0);

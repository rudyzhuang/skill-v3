#!/usr/bin/env node
/**
 * build.cjs — stage: build
 *
 * 规范: docs/spec/std3.md §1 build.cjs
 *
 * 读取 docs/config.dev.json 的 build.commands，逐端执行构建命令。
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

if (!args.project) { console.error('[build] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages || stages.stages.merge_push.status !== 'completed') {
  console.error('[build] ❌ 上游门闸失败：merge_push 未完成');
  process.exit(1);
}

updateStage(projectRoot, 'build', { status: 'running', started_at: new Date().toISOString() });

// ── 读取构建配置 ────────────────────────────────────────────────────────────
const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
if (!fs.existsSync(cfgPath)) {
  console.error('[build] ❌ docs/config.dev.json 不存在');
  process.exit(1);
}

let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
catch (e) { console.error(`[build] ❌ config.dev.json 解析失败: ${e.message}`); process.exit(1); }

const buildCfg = cfg.build || {};
const clientTargets = buildCfg.client_targets || stages.stages.prd.outputs.client_targets || [];
const timeoutS  = (cfg.timeouts && cfg.timeouts.stages && cfg.timeouts.stages.build_s) || 600;
const buildCmds = buildCfg.commands || {};

const artifacts = [];
let anyFailed = false;

for (const target of clientTargets) {
  const cmdRaw = buildCmds[target] || buildCmds.default || null;
  if (!cmdRaw) {
    console.warn(`[build] ⚠ ${target}: 无构建命令，跳过`);
    artifacts.push({ client_target: target, status: 'skipped', artifact_path: '' });
    continue;
  }

  console.log(`[build] ▶ ${target}: ${cmdRaw}`);
  const [cmd, ...cmdArgs] = cmdRaw.split(/\s+/);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: timeoutS * 1000,
    env: process.env,
    shell: true,
  });

  const artPath = (buildCfg.artifact_paths && buildCfg.artifact_paths[target]) || `dist/${target}`;
  if (result.status === 0) {
    console.log(`[build] ✅ ${target} 构建成功`);
    artifacts.push({ client_target: target, status: 'completed', artifact_path: artPath, command: cmdRaw });
  } else {
    console.error(`[build] ❌ ${target} 构建失败（退出码 ${result.status}）`);
    artifacts.push({ client_target: target, status: 'failed', artifact_path: '', command: cmdRaw });
    anyFailed = true;
  }
}

if (anyFailed) {
  updateStage(projectRoot, 'build', {
    status: 'failed',
    outputs: { artifacts },
    validation: { passed: false, summary: '有构建失败的端' },
  });
  process.exit(1);
}

updateStage(projectRoot, 'build', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(clientTargets.join('|')) },
  outputs: { artifacts },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `${artifacts.length} targets built` },
});

console.log(`[build] ✅ build 完成（${artifacts.length} targets）`);
process.exit(0);

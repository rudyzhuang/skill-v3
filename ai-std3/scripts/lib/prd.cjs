#!/usr/bin/env node
/**
 * prd.cjs — stage: prd
 *
 * 规范: docs/spec/std3.md §1 prd.cjs
 *
 * 职责：
 *   脚本：bootstrap（初始化 stages.json）、validate（检查 Agent 产出文件）、write（写完成态）
 *   Agent：产出 docs/prd-spec.md、docs/<target>/prd.md、docs/<target>/feature_list.md、docs/config.dev.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initStages, updateStage, readStages, sha256File } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[prd] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

// ── 1. Bootstrap ───────────────────────────────────────────────────────────
const stages = initStages(projectRoot);
const docsDir = path.join(projectRoot, 'docs');
fs.mkdirSync(docsDir, { recursive: true });

updateStage(projectRoot, 'prd', {
  status: 'running',
  started_at: new Date().toISOString(),
});

// ── 2. 增量检测 ────────────────────────────────────────────────────────────
const reqPath  = path.join(projectRoot, 'inputs', 'req.md');
const reqHash  = sha256File(reqPath);
const cur      = stages.stages.prd;

if (!args.force && cur.status === 'completed' && cur.inputs && cur.inputs.req_hash === reqHash) {
  console.log('[prd] ⏭ inputs/req.md 哈希未变且已 completed，跳过（--force 强制重跑）');
  process.exit(0);
}

// ── 3. 检查 Agent 产出 ─────────────────────────────────────────────────────
const prdSpecPath    = path.join(docsDir, 'prd-spec.md');
const configDevPath  = path.join(docsDir, 'config.dev.json');

const missing = [];
if (!fs.existsSync(prdSpecPath))   missing.push('docs/prd-spec.md');
if (!fs.existsSync(configDevPath)) missing.push('docs/config.dev.json');

// 检查 prd-spec.md 是否含 ## 客户端目标 / ## Client Targets
if (fs.existsSync(prdSpecPath)) {
  const spec = fs.readFileSync(prdSpecPath, 'utf8');
  if (!/^##\s+(客户端目标|Client Targets)/m.test(spec)) {
    missing.push('docs/prd-spec.md 缺少 ## 客户端目标 章节');
  }
}

if (missing.length > 0) {
  console.error('[prd] ❌ Agent 产出文件缺失：');
  for (const m of missing) console.error(`  • ${m}`);
  console.error('');
  console.error('[prd] → 请按 ai-std3/prompts/prd-spec-author.md 产出以下文件后重跑：');
  console.error('[prd]   docs/prd-spec.md（含 ## 客户端目标 H2 与 ## 核心功能 表）');
  console.error('[prd]   docs/<client_target>/prd.md（每个端）');
  console.error('[prd]   docs/<client_target>/feature_list.md（每个端）');
  console.error('[prd]   docs/config.dev.json（部署/smoke 配置初稿）');
  updateStage(projectRoot, 'prd', { status: 'failed', validation: { passed: false, summary: '缺少 Agent 产出' } });
  process.exit(4);
}

// ── 4. 解析 client_targets ─────────────────────────────────────────────────
const ALLOWED_TARGETS = ['website','admin','backend','mobile','miniapp','desktop','agent'];
const prdSpec  = fs.readFileSync(prdSpecPath, 'utf8');
const clientTargets = [];

const ctSection = prdSpec.match(/^##\s+(客户端目标|Client Targets)[\s\S]*?(?=\n##|\s*$)/m)?.[0] || '';
for (const t of ALLOWED_TARGETS) {
  if (new RegExp(`\\b${t}\\b`, 'i').test(ctSection)) clientTargets.push(t);
}

// 检查每个 client_target 对应的 prd.md 与 feature_list.md
const targetMissing = [];
for (const t of clientTargets) {
  const prdMd  = path.join(docsDir, t, 'prd.md');
  const featMd = path.join(docsDir, t, 'feature_list.md');
  if (!fs.existsSync(prdMd))  targetMissing.push(`docs/${t}/prd.md`);
  if (!fs.existsSync(featMd)) targetMissing.push(`docs/${t}/feature_list.md`);
}

if (targetMissing.length > 0) {
  console.error('[prd] ❌ 缺少以下端文档：');
  for (const m of targetMissing) console.error(`  • ${m}`);
  updateStage(projectRoot, 'prd', { status: 'failed', validation: { passed: false, summary: '缺少端文档' } });
  process.exit(4);
}

// ── 5. config.dev.json 基本校验（非明文密钥） ──────────────────────────────
try {
  const cfg = JSON.parse(fs.readFileSync(configDevPath, 'utf8'));
  const cfgStr = JSON.stringify(cfg);
  // 粗略扫描明文密钥特征
  const forbidden = ['api_token','api_key','secret','password','token'].filter(k => {
    const re = new RegExp(`"${k}"\\s*:\\s*"[^"]+"`, 'i');
    return re.test(cfgStr);
  });
  if (forbidden.length > 0) {
    console.warn(`[prd] ⚠ config.dev.json 中疑似有明文密钥字段: ${forbidden.join(', ')}（请确认）`);
  }
} catch (e) {
  console.error(`[prd] ❌ docs/config.dev.json 不是合法 JSON: ${e.message}`);
  updateStage(projectRoot, 'prd', { status: 'failed', validation: { passed: false, summary: 'config.dev.json 解析失败' } });
  process.exit(1);
}

// ── 6. 写完成态 ────────────────────────────────────────────────────────────
const summaryHash = sha256File(prdSpecPath);
updateStage(projectRoot, 'prd', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { req_hash: reqHash, summary_hash: summaryHash },
  outputs: { client_targets: clientTargets },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `client_targets: ${clientTargets.join(', ')}` },
});

console.log(`[prd] ✅ prd 完成。client_targets: ${clientTargets.join(', ')}`);
process.exit(0);

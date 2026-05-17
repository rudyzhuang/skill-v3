#!/usr/bin/env node
/**
 * verify-req.cjs — 校验 inputs/req.md 必填字段与 inputs/config.env 密钥
 *
 * 用法:
 *   node ~/.cursor/skills/ai-std3/scripts/verify-req.cjs --project=<业务项目根>
 *
 * 退出码:
 *   0  = 全部通过
 *   1  = 文件缺失或脚本错误
 *   2  = 字段未填写完整（等用户补全后重跑）
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const args = {};
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (arg.startsWith('--')) args[arg.slice(2)] = true;
}

if (!args.project) {
  console.error('[verify-req] 必须提供 --project=<业务项目根>');
  process.exit(1);
}

const projectRoot  = path.resolve(args.project);
const reqPath      = path.join(projectRoot, 'inputs', 'req.md');
const configEnvPath = path.join(projectRoot, 'inputs', 'config.env');

// ── req.md 必填 H2 节 ──────────────────────────────────────────────────────
const REQUIRED_SECTIONS = [
  { heading: '项目中文名称', key: 'project_name_cn', placeholder: 'PROJECT_NAME_CN: 请填写项目中文名称' },
  { heading: '项目英文名称', key: 'project_name_en', placeholder: 'PROJECT_NAME_EN: 请填写项目英文名称' },
  { heading: '功能需求',     key: 'functional_requirements', placeholder: 'DETAIL: 请填写功能需求' },
  { heading: 'App 要求',    key: 'app_requirements',  placeholder: 'TODO: 请填写 App 要求' },
  { heading: '部署要求',     key: 'deploy_requirements', placeholder: 'TODO: 请填写部署要求' },
  { heading: '云平台',       key: 'cloud_platform', placeholder: 'TODO: 请填写云平台，如 Cloudflare' },
];
const REQUIRED_HEADING_GROUPS = [
  {
    key: 'domain',
    headings: ['主域名', '主域名 domain'],
    placeholder: 'TODO: 请填写主域名，如 notes.example.com',
  },
];

// ── config.env provider → 必需密钥 ────────────────────────────────────────
const PROVIDER_REQUIRED_KEYS = {
  cloudflare:     ['CLOUDFLARE_API_TOKEN'],
  vercel:         ['VERCEL_TOKEN'],
  aws:            ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  google_cloud:   ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'],
  azure:          ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID'],
  tencent_cloud:  ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'],
  alibaba_cloud:  ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  huawei_cloud:   ['HUAWEI_CLOUD_ACCESS_KEY_ID', 'HUAWEI_CLOUD_SECRET_ACCESS_KEY'],
  manual:         [],
};

// ── 工具函数 ───────────────────────────────────────────────────────────────

function extractSection(content, heading) {
  const lines = content.split('\n');
  let inSection = false;
  const out = [];
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (inSection) break;
      const title = line.replace(/^##\s+/, '').replace(/[\s*]+$/, '').trim();
      if (title === heading) { inSection = true; continue; }
    }
    if (!inSection) continue;
    if (/^\s*<!--/.test(line)) continue;
    if (/^\s*$/.test(line))    continue;
    if (/^---+\s*$/.test(line)) continue;
    out.push(line.trim());
  }
  return out.join('\n').trim();
}

function hasContent(text, placeholder) {
  if (!text) return false;
  if (text === placeholder.trim()) return false;
  if (/^TODO:/i.test(text)) return false;
  return true;
}

function parseEnvFile(envPath) {
  const vars = {};
  if (!fs.existsSync(envPath)) return vars;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const missing = [];

// 1. 检查 req.md
if (!fs.existsSync(reqPath)) {
  console.error(`[verify-req] ❌ inputs/req.md 不存在，请先运行 setup-inputs.cjs`);
  process.exit(1);
}
const reqContent = fs.readFileSync(reqPath, 'utf8');

for (const { heading, key, placeholder } of REQUIRED_SECTIONS) {
  const text = extractSection(reqContent, heading);
  if (!hasContent(text, placeholder)) {
    missing.push({ heading, key, found: (text || '（空）').slice(0, 60) });
  }
}

for (const { key, headings, placeholder } of REQUIRED_HEADING_GROUPS) {
  let ok = false;
  let last = '';
  for (const h of headings) {
    const t = extractSection(reqContent, h);
    last = t || last;
    if (hasContent(t, placeholder)) { ok = true; break; }
  }
  if (!ok) {
    missing.push({ heading: headings.join(' / '), key, found: (last || '（空）').slice(0, 60) });
  }
}

// 2. 检查 config.env
if (!fs.existsSync(configEnvPath)) {
  missing.push({ heading: 'inputs/config.env', key: 'config_env', found: '文件不存在' });
} else {
  const env = parseEnvFile(configEnvPath);
  const provider = (env.CLOUD_PROVIDER || '').toLowerCase().trim();
  if (!provider) {
    missing.push({ heading: 'config.env CLOUD_PROVIDER', key: 'cloud_provider', found: '（空）' });
  } else {
    const required = PROVIDER_REQUIRED_KEYS[provider] || [];
    for (const k of required) {
      if (!env[k] || !env[k].trim()) {
        missing.push({ heading: `config.env ${k}`, key: k, found: '（空）' });
      }
    }
  }
}

// 3. 输出结果
if (missing.length > 0) {
  console.error('[verify-req] ❌ 以下必填字段缺失或仍为占位符：');
  for (const f of missing) {
    console.error(`  • ${f.heading}  (key=${f.key})  当前值: "${f.found}"`);
  }
  console.error('');
  console.error('[verify-req] 请补全上述字段后重新运行。');
  process.exit(2);
}

const total = REQUIRED_SECTIONS.length + REQUIRED_HEADING_GROUPS.length + 1; // +1 for config.env
console.log(`[verify-req] ✅ 校验通过（req.md 必填字段 + config.env 均已填写）`);
console.log(`[verify-req] 项目: ${projectRoot}`);
process.exit(0);

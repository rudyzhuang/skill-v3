#!/usr/bin/env node
/**
 * setup-inputs.cjs — 初始化业务项目 inputs/req.md 与 inputs/config.env
 *
 * 若文件已存在则跳过（不覆盖）。
 *
 * 用法:
 *   node ~/.cursor/skills/ai-std3/scripts/setup-inputs.cjs --project=<业务项目根>
 *
 * 退出码:
 *   0  = 成功（新建或已存在均视为成功）
 *   1  = 参数错误 / 模板文件缺失
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
  console.error('[setup-inputs] 必须提供 --project=<业务项目根>');
  process.exit(1);
}

const projectRoot = path.resolve(args.project);
const skillDir    = path.resolve(__dirname, '..');
const inputsDir   = path.join(projectRoot, 'inputs');

const TEMPLATES = [
  {
    src:  path.join(skillDir, 'docs', 'templates', 'req-template.md'),
    dest: path.join(inputsDir, 'req.md'),
    label: 'inputs/req.md',
  },
  {
    src:  path.join(skillDir, 'docs', 'templates', 'config.env.template'),
    dest: path.join(inputsDir, 'config.env'),
    label: 'inputs/config.env',
  },
];

fs.mkdirSync(inputsDir, { recursive: true });

let anyCreated = false;
for (const { src, dest, label } of TEMPLATES) {
  if (!fs.existsSync(src)) {
    console.error(`[setup-inputs] ❌ 模板文件不存在: ${src}`);
    console.error(`[setup-inputs] 请确认 ai-std3 skill 完整安装于 ~/.cursor/skills/ai-std3/`);
    process.exit(1);
  }
  if (fs.existsSync(dest)) {
    console.log(`[setup-inputs] ✓ 已存在，跳过: ${label}`);
  } else {
    fs.copyFileSync(src, dest);
    console.log(`[setup-inputs] ✅ 已创建: ${label}`);
    anyCreated = true;
  }
}

if (anyCreated) {
  console.log('');
  console.log('[setup-inputs] 请打开并填写 inputs/req.md 中所有带 * 的必填字段。');
  console.log('[setup-inputs] 请在 inputs/config.env 中填写 CLOUD_PROVIDER 与对应密钥。');
  console.log('[setup-inputs] 填写完成后运行:');
  console.log(`[setup-inputs]   node ~/.cursor/skills/ai-std3/scripts/verify-req.cjs --project=${projectRoot}`);
}

process.exit(0);

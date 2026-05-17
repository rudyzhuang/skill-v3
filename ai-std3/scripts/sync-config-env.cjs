#!/usr/bin/env node
/**
 * sync-config-env.cjs — 将 inputs/config.env 同步到 docs/config.env（覆盖写入）
 *
 * 用法:
 *   node ~/.cursor/skills/ai-std3/scripts/sync-config-env.cjs --project=<业务项目根>
 *
 * 退出码:
 *   0  = 成功
 *   1  = 文件缺失或参数错误
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
  console.error('[sync-config-env] 必须提供 --project=<业务项目根>');
  process.exit(1);
}

const projectRoot = path.resolve(args.project);
const src  = path.join(projectRoot, 'inputs', 'config.env');
const dest = path.join(projectRoot, 'docs', 'config.env');

if (!fs.existsSync(src)) {
  console.error(`[sync-config-env] ❌ inputs/config.env 不存在: ${src}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[sync-config-env] ✅ 已同步: inputs/config.env → docs/config.env`);
process.exit(0);

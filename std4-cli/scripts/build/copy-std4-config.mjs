#!/usr/bin/env node
/**
 * 构建期：将运维/本地的 `inputs/config.env` 复制为 `bundled/std4-config.env`，随 CLI 包分发。
 * 不打印文件内容；源缺失时非零退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const src = path.join(repoRoot, 'inputs', 'config.env');
const destDir = path.join(repoRoot, 'bundled');
const dest = path.join(destDir, 'std4-config.env');

if (!fs.existsSync(src)) {
  console.error(
    `[copy-std4-config] missing inputs/config.env (expected path=${src})`
  );
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.error(`[copy-std4-config] wrote ${path.relative(repoRoot, dest)}`);

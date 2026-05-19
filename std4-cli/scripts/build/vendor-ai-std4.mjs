#!/usr/bin/env node
/**
 * 构建期：从 Git 拉取 skill-v3 子树至 vendor/ai-std4/，执行 npm install 并校验入口。
 * 环境变量：STD4_SKILL_REPO、STD4_SKILL_REF、STD4_SKILL_SUBDIR（可选覆盖默认）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TARGET_DIR = path.join(REPO_ROOT, 'vendor', 'ai-std4');
const ENTRY = path.join(TARGET_DIR, 'scripts', 'run-pipeline.cjs');

const DEFAULT_REPO = 'https://github.com/rudyzhuang/skill-v3.git';
const DEFAULT_REF = 'main';
const DEFAULT_SUBDIR = 'ai-std4';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  return r.status ?? 1;
}

function gitCloneAtRef(repo, ref, dest) {
  let st = run('git', ['clone', '--depth', '1', '--branch', ref, repo, dest]);
  if (st === 0) return 0;
  st = run('git', ['clone', '--depth', '1', repo, dest]);
  if (st !== 0) return st;
  st = run('git', ['-C', dest, 'fetch', '--depth', '1', 'origin', ref]);
  if (st !== 0) return st;
  st = run('git', ['-C', dest, 'checkout', '--detach', 'FETCH_HEAD']);
  return st;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function usage() {
  console.error(`用法: node scripts/build/vendor-ai-std4.mjs [--if-missing]
环境变量:
  STD4_SKILL_REPO=${DEFAULT_REPO}
  STD4_SKILL_REF=${DEFAULT_REF}
  STD4_SKILL_SUBDIR=${DEFAULT_SUBDIR}`);
}

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  usage();
  process.exit(0);
}

const ifMissing = argv.includes('--if-missing');
if (ifMissing && fs.existsSync(ENTRY)) {
  process.exit(0);
}

const repo = process.env.STD4_SKILL_REPO?.trim() || DEFAULT_REPO;
const ref = process.env.STD4_SKILL_REF?.trim() || DEFAULT_REF;
const subdir = (process.env.STD4_SKILL_SUBDIR?.trim() || DEFAULT_SUBDIR).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-vendor-'));
try {
  const stClone = gitCloneAtRef(repo, ref, tmp);
  if (stClone !== 0) {
    console.error('[vendor-ai-std4] git clone/checkout 失败');
    process.exit(2);
  }

  const src = path.join(tmp, ...subdir.split('/'));
  if (!fs.existsSync(src)) {
    console.error(`[vendor-ai-std4] 子目录不存在: ${subdir}`);
    process.exit(3);
  }

  rmrf(TARGET_DIR);
  fs.mkdirSync(path.dirname(TARGET_DIR), { recursive: true });
  fs.cpSync(src, TARGET_DIR, { recursive: true });

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const stNpm = run(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: TARGET_DIR, env: process.env });
  if (stNpm !== 0) {
    console.error('[vendor-ai-std4] npm install 失败');
    process.exit(4);
  }

  if (!fs.existsSync(ENTRY)) {
    console.error(`[vendor-ai-std4] 入口缺失: ${path.relative(REPO_ROOT, ENTRY)}`);
    process.exit(5);
  }
} finally {
  rmrf(tmp);
}

process.exit(0);

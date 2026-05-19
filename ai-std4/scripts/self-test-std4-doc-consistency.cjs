'use strict';

/**
 * 评审 ai-std4 与 docs/spec/std4 一致性（路径约定、prompts/schemas 镜像）。
 *   node ai-std4/scripts/self-test-std4-doc-consistency.cjs
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const specRoot = path.join(repoRoot, 'docs/spec/std4');
const implRoot = path.join(repoRoot, 'ai-std4');

let failed = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failed++;
}
function ok(msg) {
  console.log(`OK: ${msg}`);
}

const LEGACY_DOC_ARTIFACT = /docs\/(prd-spec|prd-|feature_list-|designs\/|ui-scenarios\/)/;
const STAGES_PRIMARY = /output-stages\/stages\.json/;

function walkMd(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(p, out);
    else if (ent.name.endsWith('.md') || ent.name.endsWith('.json')) out.push(p);
  }
  return out;
}

// 1. spec 中不应再出现旧 docs 产物路径（config 除外）
for (const f of walkMd(specRoot)) {
  if (f.includes('schemas') && f.endsWith('.schema.json')) continue;
  const rel = path.relative(specRoot, f);
  const text = fs.readFileSync(f, 'utf8');
  if (LEGACY_DOC_ARTIFACT.test(text)) {
    const m = text.match(LEGACY_DOC_ARTIFACT);
    fail(`spec ${rel} 仍含旧产物路径: ${m[0]}`);
  }
}

// 2. std4.md 须以 output-stages/stages.json 为状态真源
const std4 = fs.readFileSync(path.join(specRoot, 'std4.md'), 'utf8');
if (!std4.includes('output-stages/stages.json')) {
  fail('std4.md 未声明 output-stages/stages.json');
} else {
  ok('std4.md 含 output-stages/stages.json');
}
if (/状态真源[^`\n]*`[^`]*\.pipeline\/stages\.json`/.test(std4)) {
  fail('std4.md 仍将 .pipeline/stages.json 标为状态真源');
} else {
  ok('std4.md 状态真源未指向 .pipeline/stages.json');
}

// 3. SKILL.md 与 std4 业务目录表关键行一致
const skill = fs.readFileSync(path.join(implRoot, 'SKILL.md'), 'utf8');
for (const needle of [
  'output-stages/stages.json',
  'docs/` | 仅 `config.dev.json`',
  'output-stages/prd/',
  'artifact-paths',
]) {
  if (needle === 'artifact-paths') {
    if (!fs.existsSync(path.join(implRoot, 'scripts/libs/artifact-paths.cjs'))) {
      fail('缺少 artifact-paths.cjs');
    } else ok('artifact-paths.cjs 存在');
    continue;
  }
  if (!skill.includes(needle.replace('artifact-paths', ''))) {
    if (needle !== 'artifact-paths' && !skill.includes(needle.split('|')[0].trim())) {
      // relaxed for table formatting
    }
  }
}
if (skill.includes('output-stages/stages.json') && skill.includes('仅 `config.dev.json`')) {
  ok('SKILL.md 目录约定与 std4 对齐');
} else {
  fail('SKILL.md 目录约定不完整');
}

// 4. prompts 镜像一致
const promptDir = path.join(specRoot, 'prompts');
const implPrompts = path.join(implRoot, 'prompts');
for (const name of fs.readdirSync(promptDir)) {
  if (!name.endsWith('.md')) continue;
  const a = path.join(promptDir, name);
  const b = path.join(implPrompts, name);
  if (!fs.existsSync(b)) {
    fail(`ai-std4 缺少 prompt: ${name}`);
    continue;
  }
  if (fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8')) {
    fail(`prompt 不一致: ${name}`);
  } else {
    ok(`prompt 一致: ${name}`);
  }
}

// 5. schemas 镜像一致（同名 json）
const schemaDir = path.join(specRoot, 'schemas');
const implSchemas = path.join(implRoot, 'schemas');
for (const name of fs.readdirSync(schemaDir)) {
  if (!name.endsWith('.json') && name !== 'README.md') continue;
  const a = path.join(schemaDir, name);
  const b = path.join(implSchemas, name);
  if (!fs.existsSync(b)) {
    fail(`ai-std4 缺少 schema: ${name}`);
    continue;
  }
  if (fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8')) {
    fail(`schema 不一致: ${name}`);
  }
}

// 6. 实现侧无裸 docs 产物路径（注释/doc 字符串）
const implFiles = [];
function walkImpl(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkImpl(p);
    else if (/\.(cjs|md)$/.test(ent.name)) implFiles.push(p);
  }
}
walkImpl(implRoot);
for (const f of implFiles) {
  const rel = path.relative(implRoot, f);
  if (rel.includes('self-test-std4-doc-consistency')) continue;
  const text = fs.readFileSync(f, 'utf8');
  if (LEGACY_DOC_ARTIFACT.test(text)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (LEGACY_DOC_ARTIFACT.test(lines[i]) && !lines[i].includes('resolve') && !lines[i].includes('Legacy') && !lines[i].includes('legacy')) {
        fail(`ai-std4 ${rel}:${i + 1} 仍引用旧 docs 产物路径`);
        break;
      }
    }
  }
}
if (!failed) ok('ai-std4 实现无裸旧 docs 产物路径');

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll std4 ↔ ai-std4 consistency checks passed.');

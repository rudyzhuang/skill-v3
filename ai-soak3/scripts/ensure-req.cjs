#!/usr/bin/env node
/**
 * ensure-req.cjs  —  ai-soak3 辅助脚本
 * 校验业务项目的 inputs/req.md 是否存在且包含必填字段。
 *
 * 规范真源：~/.cursor/skills/ai-soak3/docs/spec/soak3.md §4
 *
 * 用法:
 *   node ~/.cursor/skills/ai-soak3/scripts/ensure-req.cjs --project=<业务项目根目录>
 *
 * 退出码:
 *   0 = req.md 存在且必填字段全部有实质内容，可继续执行
 *   1 = req.md 不存在，已从模板创建，等待用户填写后重试
 *   2 = req.md 存在但必填字段空缺，列出缺失项
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ──────────────────────── 参数解析 ───────────────────────────
const args = {};
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (arg.startsWith('--')) args[arg.slice(2)] = true;
}

if (!args.project) {
  console.error('[ensure-req] 必须提供 --project=<业务项目根目录>');
  process.exit(1);
}

const projectRoot = path.resolve(args.project);
const skillDir    = args['skill-dir']
  ? path.resolve(args['skill-dir'])
  : path.resolve(__dirname, '..');

const reqPath      = path.join(projectRoot, 'inputs', 'req.md');
const templatePath = path.join(skillDir, 'docs', 'templates', 'req-template.md');

// ──────────────────────── 必填字段定义 ───────────────────────
/**
 * 每项：
 *   heading  - H2 标题文本（不含 ##）
 *   key      - 字段标识（用于错误输出）
 *   todoText - 模板中的占位文本，若内容仅为此则视为未填写
 */
/** 单 H2 必填项 */
const REQUIRED_FIELDS = [
  { heading: '功能需求', key: 'functional_requirements', todoText: 'TODO: 请填写功能需求' },
  { heading: '云平台', key: 'cloud_platform', todoText: 'TODO: 请填写云平台，如 Cloudflare' },
  { heading: '鉴权信息', key: 'credentials', todoText: 'TODO: 请描述凭证位置，如"所需凭证已在同级目录 config.env"' },
];

/** 多标题择一（如「主域名」/「主域名 domain」） */
const REQUIRED_FIELD_GROUPS = [
  {
    key: 'domain',
    headings: ['主域名 domain', '主域名'],
    todoText: 'TODO: 请填写主域名，如 example.yunapp.com',
  },
];

// ──────────────────────── 工具函数 ───────────────────────────

/** 提取某个 H2 标题下的内容文本（去掉注释行与空行）
 *  标题匹配时忽略末尾的 ` *`（模板中用于标记必填的星号）
 */
function extractSection(content, heading) {
  const lines = content.split('\n');
  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (inSection) break; // 遇到下一个 H2 就结束
      // 去掉 ## 前缀、末尾空格、末尾 * 号（模板必填标记）
      const titleText = line.replace(/^##\s+/, '').replace(/[\s*]+$/, '').trim();
      if (titleText === heading) {
        inSection = true;
        continue;
      }
    }
    if (!inSection) continue;
    // 跳过 HTML 注释、纯空行、水平分隔线
    if (/^\s*<!--/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;
    if (/^---+\s*$/.test(line)) continue;
    sectionLines.push(line.trim());
  }

  return sectionLines.join('\n').trim();
}

/** 判断提取到的内容是否为「有实质内容」（非空、非 TODO 占位符） */
function hasSubstantialContent(text, todoText) {
  if (!text) return false;
  if (text === todoText.trim()) return false;
  if (/^TODO:/i.test(text)) return false;
  return true;
}

// ──────────────────────── 主流程 ─────────────────────────────

// 1. req.md 不存在 → 从模板创建
if (!fs.existsSync(reqPath)) {
  console.log(`[ensure-req] inputs/req.md 不存在于: ${projectRoot}`);

  if (!fs.existsSync(templatePath)) {
    console.error(`[ensure-req] ❌ 模板文件也不存在: ${templatePath}`);
    console.error('[ensure-req] 请确认 ai-soak3 skill 完整安装于 ~/.cursor/skills/ai-soak3/');
    process.exit(1);
  }

  const inputsDir = path.join(projectRoot, 'inputs');
  fs.mkdirSync(inputsDir, { recursive: true });
  fs.copyFileSync(templatePath, reqPath);

  console.log(`[ensure-req] ✅ 已从模板创建: ${reqPath}`);
  console.log('');
  console.log('[ensure-req] 请打开并填写以下必填字段后，重新运行 ensure-req.cjs：');
  for (const f of REQUIRED_FIELDS) {
    console.log(`  • ## ${f.heading}  ← 必填`);
  }
  console.log('');
  console.log(`[ensure-req] 提示：真实密钥/Token 请写在 inputs/config.env，req.md 中只描述路径。`);
  process.exit(1);
}

// 2. req.md 存在 → 校验必填字段
const content = fs.readFileSync(reqPath, 'utf8');
const missing = [];

for (const field of REQUIRED_FIELDS) {
  const text = extractSection(content, field.heading);
  if (!hasSubstantialContent(text, field.todoText)) {
    missing.push({ ...field, found: text || '（空）' });
  }
}

for (const group of REQUIRED_FIELD_GROUPS) {
  let ok = false;
  let lastText = '';
  for (const heading of group.headings) {
    const text = extractSection(content, heading);
    lastText = text || lastText;
    if (hasSubstantialContent(text, group.todoText)) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    missing.push({
      heading: group.headings.join(' | '),
      key: group.key,
      todoText: group.todoText,
      found: lastText || '（空）',
    });
  }
}

if (missing.length > 0) {
  console.error(`[ensure-req] ❌ inputs/req.md 存在，但以下必填字段缺失或仍为占位符：`);
  for (const f of missing) {
    console.error(`  • ## ${f.heading}  (key=${f.key})  当前值: "${f.found.slice(0, 60)}"`);
  }
  console.error('');
  console.error('[ensure-req] 请填写上述字段后重新运行。');
  process.exit(2);
}

// 3. 全部通过
const requiredCount = REQUIRED_FIELDS.length + REQUIRED_FIELD_GROUPS.length;
console.log(`[ensure-req] ✅ inputs/req.md 校验通过（${requiredCount} 个必填字段均已填写）`);
console.log(`[ensure-req] 项目: ${projectRoot}`);
process.exit(0);

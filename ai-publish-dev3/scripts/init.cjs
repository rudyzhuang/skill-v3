'use strict';

/**
 * 可选：对齐 v2 inventory/init 体验（publish3.md §4.1）。
 * 当前仅输出指引，不写密钥、不替代 ai-prd3 的配置初始化。
 */
const fs = require('fs');
const path = require('path');
const { parseRunArgs, requireProject } = require('./lib/paths.cjs');

function main() {
  const args = parseRunArgs(process.argv, { environment: 'dev' });
  const root = requireProject(args.project);
  const templates = path.join(root, 'docs', 'templates');
  const hasTemplates = fs.existsSync(templates);
  console.error('ai-publish-dev3 init（占位）');
  console.error(`- 项目根: ${root}`);
  console.error(`- 配置模板目录: ${hasTemplates ? templates : '（未找到 docs/templates）'}`);
  console.error('- 请从 docs/templates 拷贝 config.dev.json.template、stages.json.template、config.env.template 等到业务路径；详见 SKILL.md 与 docs/spec/publish3.md。');
  process.exit(0);
}

main();

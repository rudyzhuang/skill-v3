'use strict';

/**
 * 子进程入口：重置 SDK 可恢复的 codegen feature（避免 run-pipeline require 缓存旧 recovery 模块）
 *
 *   node ai-std4/scripts/libs/recovery-reset-codegen.cjs --project=<业务项目根>
 */

const fs   = require('fs');
const path = require('path');
const { createPipelinePaths } = require('./pipeline-paths.cjs');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || true];
    })
);

const projectRoot = args.project
  ? path.resolve(String(args.project))
  : process.env.AI_STD4_PROJECT
    ? path.resolve(process.env.AI_STD4_PROJECT)
    : process.cwd();

const paths = createPipelinePaths(projectRoot);
const stagesPath = paths.stagesJsonPath;
if (!fs.existsSync(stagesPath)) {
  process.stderr.write(`[recovery-reset-codegen] 未找到 ${stagesPath}\n`);
  process.exit(1);
}

const { resetCodegenSdkFailures } = require('./pipeline-recovery.cjs');
let stages;
try {
  stages = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
} catch (e) {
  process.stderr.write(`[recovery-reset-codegen] stages.json 解析失败: ${e.message}\n`);
  process.exit(1);
}

const { reset } = resetCodegenSdkFailures(projectRoot, stages, null);
fs.writeFileSync(stagesPath, JSON.stringify(stages, null, 2) + '\n', 'utf8');

if (reset.length > 0) {
  process.stdout.write(`reset feature_ids: ${reset.join(', ')}\n`);
}
process.exit(0);

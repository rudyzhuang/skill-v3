'use strict';

/**
 * register-project.cjs
 * 读取 docs/config.dev.json 中的 project.name
 * 写入 <skills_root>/_projects/<project.name>/runtime.json
 */

const fs   = require('fs');
const path = require('path');
const { createLogger, formatLocalTimeShort } = require('./logger.cjs');

/**
 * 生成稳定的项目 ID（基于路径的简单哈希）
 * @param {string} rootPath
 * @returns {string}
 */
function generateProjectId(rootPath) {
  // 简单 djb2 哈希
  let hash = 5381;
  for (let i = 0; i < rootPath.length; i++) {
    hash = ((hash << 5) + hash) ^ rootPath.charCodeAt(i);
    hash = hash >>> 0; // 转无符号32位
  }
  return `proj-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.skillsRoot
 * @param {string} [opts.runId]
 * @param {object} [opts.logger]
 * @returns {{ runtimeJsonPath: string, projectId: string, projectName: string }}
 */
function registerProject({ projectRoot, skillsRoot, runId, logger: externalLogger }) {
  const log = externalLogger || createLogger({ projectRoot, stage: 'setup', runId });

  // ── 读取 config.dev.json ─────────────────────────────────────────
  const configDevPath = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(configDevPath)) {
    throw new Error(`docs/config.dev.json 不存在: ${configDevPath}`);
  }

  let configDev;
  try {
    configDev = JSON.parse(fs.readFileSync(configDevPath, 'utf8'));
  } catch (e) {
    throw new Error(`docs/config.dev.json 解析失败: ${e.message}`);
  }

  const projectName = configDev.project && configDev.project.name;
  if (!projectName) {
    throw new Error('docs/config.dev.json 缺少 project.name 字段');
  }

  // ── 生成稳定项目 ID ──────────────────────────────────────────────
  const projectId = generateProjectId(projectRoot);

  // ── 写入 runtime.json ────────────────────────────────────────────
  const projectRegistryDir = path.join(skillsRoot, '_projects', projectName);
  fs.mkdirSync(projectRegistryDir, { recursive: true });

  const runtimeJsonPath = path.join(projectRegistryDir, 'runtime.json');
  const now = formatLocalTimeShort();

  let existing = {};
  const isUpdate = fs.existsSync(runtimeJsonPath);
  if (isUpdate) {
    try {
      existing = JSON.parse(fs.readFileSync(runtimeJsonPath, 'utf8'));
    } catch (_) { existing = {}; }
  }

  const runtime = Object.assign({}, existing, {
    project_id:           projectId,
    root_path:            projectRoot,
    name:                 projectName,
    last_registered_at:   now,
    skill:                'ai-std4',
  });

  fs.writeFileSync(runtimeJsonPath, JSON.stringify(runtime, null, 2) + '\n', 'utf8');
  const stat = fs.statSync(runtimeJsonPath);

  if (isUpdate) {
    log.info('file_updated', `已更新项目注册信息: ${projectName}`, {
      path: runtimeJsonPath,
      size_bytes: stat.size,
      project_id: projectId,
    });
  } else {
    log.info('file_created', `已注册新项目: ${projectName}`, {
      path: runtimeJsonPath,
      size_bytes: stat.size,
      project_id: projectId,
      from_template: false,
    });
  }

  return { runtimeJsonPath, projectId, projectName };
}

// 独立运行支持
if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => {
        const [k, ...v] = a.slice(2).split('=');
        return [k, v.join('=') || true];
      })
  );

  const projectRoot = args.project
    ? path.resolve(args.project)
    : process.env.AI_STD4_PROJECT
      ? path.resolve(process.env.AI_STD4_PROJECT)
      : process.cwd();

  const skillsRoot = process.env.CURSOR_SKILLS_ROOT
    || path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

  try {
    registerProject({ projectRoot, skillsRoot, runId: args['run-id'] });
    process.exit(0);
  } catch (err) {
    console.error(`[ERROR] register-project 失败: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { registerProject, generateProjectId };

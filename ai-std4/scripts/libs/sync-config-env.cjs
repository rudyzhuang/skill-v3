'use strict';

/**
 * sync-config-env.cjs
 * 将 inputs/config.env 覆盖写入 docs/config.env
 * 自动追加 config.env / docs/config.env 到 .gitignore
 * 若 docs/config.dev.json 不存在，从 templates/config.json.template 拷贝并填入基础字段
 * 若 docs/config.release.json 不存在，同上
 */

const fs   = require('fs');
const path = require('path');
const { createLogger } = require('./logger.cjs');
const { parseEnv } = require('./verify-inputs.cjs');
const { loadProjectEnv } = require('./pipeline-config.cjs');

/**
 * 解析 req.md 获取项目名称（## 项目名称 * 节的第一行实质内容）
 * @param {string} content
 * @returns {string|null}
 */
function extractProjectName(content) {
  const match = content.match(/^## 项目名称 \*\s*\n([\s\S]*?)(?=^## |\z)/m);
  if (!match) return null;

  const body = match[1];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('<!--') || t.startsWith('-->') || t === '-->') continue;
    return t;
  }
  return null;
}

/**
 * 确保 .gitignore 包含指定条目
 * @param {string} gitignorePath
 * @param {string[]} entries
 * @param {object} log
 */
function ensureGitignore(gitignorePath, entries, log) {
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
  }

  const lines = content.split('\n');
  let changed = false;

  for (const entry of entries) {
    const alreadyIncluded = lines.some(l => l.trim() === entry);
    if (!alreadyIncluded) {
      content = content.endsWith('\n') || content === ''
        ? content + entry + '\n'
        : content + '\n' + entry + '\n';
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(gitignorePath, content, 'utf8');
    const stat = fs.statSync(gitignorePath);
    log.info('file_updated', `已更新 .gitignore，追加 config.env 条目`, {
      path: gitignorePath,
      size_bytes: stat.size,
    });
  } else {
    log.info('file_skipped', '.gitignore 已包含 config.env 条目，跳过', {
      path: gitignorePath,
    });
  }
}

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.skillsRoot
 * @param {string} [opts.runId]
 * @param {object} [opts.logger]
 * @returns {{ configDevPath: string, configReleasePath: string, configEnvDestPath: string }}
 */
function syncConfigEnv({ projectRoot, skillsRoot, runId, logger: externalLogger }) {
  const log = externalLogger || createLogger({ projectRoot, stage: 'setup', runId });

  const inputsConfigEnv = path.join(projectRoot, 'inputs', 'config.env');
  if (!fs.existsSync(inputsConfigEnv)) {
    throw new Error(`inputs/config.env 不存在: ${inputsConfigEnv}`);
  }

  // ── 1. 同步 docs/config.env ──────────────────────────────────────
  const docsDir = path.join(projectRoot, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });

  const destConfigEnv = path.join(docsDir, 'config.env');
  const configEnvContent = fs.readFileSync(inputsConfigEnv, 'utf8');
  fs.writeFileSync(destConfigEnv, configEnvContent);
  const destStat = fs.statSync(destConfigEnv);
  log.info('file_updated', `已同步 inputs/config.env → docs/config.env`, {
    path: destConfigEnv,
    size_bytes: destStat.size,
  });

  const envVars = parseEnv(configEnvContent);
  loadProjectEnv(projectRoot, { source: 'inputs' });

  // ── 2. 更新 .gitignore ───────────────────────────────────────────
  const gitignorePath = path.join(projectRoot, '.gitignore');
  ensureGitignore(gitignorePath, ['inputs/config.env', 'docs/config.env'], log);

  // ── 3. 读取 req.md 提取项目名 ────────────────────────────────────
  const reqMdPath = path.join(projectRoot, 'inputs', 'req.md');
  let projectName = 'my-project';
  if (fs.existsSync(reqMdPath)) {
    const reqContent = fs.readFileSync(reqMdPath, 'utf8');
    projectName = extractProjectName(reqContent) || 'my-project';
  }

  // ── 4. 创建 config.dev.json / config.release.json ───────────────
  const templatePath = path.join(skillsRoot, 'ai-std4', 'templates', 'config.json.template');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`config.json.template 不存在: ${templatePath}`);
  }

  const templateContent = fs.readFileSync(templatePath, 'utf8');
  let templateObj;
  try {
    templateObj = JSON.parse(templateContent);
  } catch (e) {
    throw new Error(`config.json.template 解析失败: ${e.message}`);
  }

  // 填入基础字段
  const pipelineModel = envVars.PIPELINE_MODEL && envVars.PIPELINE_MODEL.trim();
  const baseConfig = Object.assign({}, templateObj, {
    project: {
      name: projectName,
    },
  });
  if (pipelineModel) {
    if (!baseConfig.pipeline) baseConfig.pipeline = {};
    baseConfig.pipeline.model = pipelineModel;
  }

  const configFiles = [
    { name: 'config.dev.json',     destPath: path.join(docsDir, 'config.dev.json') },
    { name: 'config.release.json', destPath: path.join(docsDir, 'config.release.json') },
  ];

  for (const { name, destPath } of configFiles) {
    if (fs.existsSync(destPath)) {
      // 仅更新 project.name（若已存在则读出 merge）
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(destPath, 'utf8'));
      } catch (e) {
        existing = {};
      }
      if (!existing.project) existing.project = {};
      let updated = false;
      if (!existing.project.name) {
        existing.project.name = projectName;
        updated = true;
      }
      if (pipelineModel) {
        if (!existing.pipeline) existing.pipeline = {};
        if (existing.pipeline.model !== pipelineModel) {
          existing.pipeline.model = pipelineModel;
          updated = true;
        }
      }
      const tplGit = (baseConfig.git || templateObj.git || {});
      if (!existing.git) existing.git = {};
      for (const key of ['remote', 'default_branch', 'remote_url', 'auto_commit', 'allow_push']) {
        if (existing.git[key] === undefined && tplGit[key] !== undefined) {
          existing.git[key] = tplGit[key];
          updated = true;
        }
      }
      if (updated) {
        fs.writeFileSync(destPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
        const stat = fs.statSync(destPath);
        log.info('file_updated', `已更新 ${name}（project.name / pipeline.model）`, {
          path: destPath,
          size_bytes: stat.size,
        });
      } else {
        log.info('file_skipped', `${name} 已存在且无变更，跳过覆盖`, {
          path: destPath,
        });
      }
    } else {
      fs.writeFileSync(destPath, JSON.stringify(baseConfig, null, 2) + '\n', 'utf8');
      const stat = fs.statSync(destPath);
      log.info('file_created', `从模板创建 ${name}`, {
        path: destPath,
        size_bytes: stat.size,
        from_template: true,
      });
    }
  }

  return {
    configDevPath:     configFiles[0].destPath,
    configReleasePath: configFiles[1].destPath,
    configEnvDestPath: destConfigEnv,
  };
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
    syncConfigEnv({ projectRoot, skillsRoot, runId: args['run-id'] });
    process.exit(0);
  } catch (err) {
    console.error(`[ERROR] sync-config-env 失败: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { syncConfigEnv, extractProjectName };

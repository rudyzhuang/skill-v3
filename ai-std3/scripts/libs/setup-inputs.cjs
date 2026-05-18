'use strict';

/**
 * setup-inputs.cjs
 * 从 ai-std3/templates/ 拷贝 req-template.md → inputs/req.md
 *                            config.env.template → inputs/config.env
 * 已存在则跳过（file_skipped），否则拷贝（file_created）
 */

const fs   = require('fs');
const path = require('path');
const { createLogger } = require('./logger.cjs');

/**
 * @param {object} opts
 * @param {string} opts.projectRoot   - 业务项目根绝对路径
 * @param {string} opts.skillsRoot    - skill 安装根目录（~/.cursor/skills 或 CURSOR_SKILLS_ROOT）
 * @param {string} [opts.runId]       - run_id（可选）
 * @param {object} [opts.logger]      - 外部传入的 logger（可选，否则自建）
 * @returns {{ reqMdPath: string, configEnvPath: string }}
 */
function setupInputs({ projectRoot, skillsRoot, runId, logger: externalLogger }) {
  const log = externalLogger || createLogger({ projectRoot, stage: 'setup', runId });

  const inputsDir = path.join(projectRoot, 'inputs');
  fs.mkdirSync(inputsDir, { recursive: true });

  const templatesDir = path.join(skillsRoot, 'ai-std3', 'templates');

  const files = [
    {
      src:  path.join(templatesDir, 'req-template.md'),
      dest: path.join(inputsDir, 'req.md'),
    },
    {
      src:  path.join(templatesDir, 'config.env.template'),
      dest: path.join(inputsDir, 'config.env'),
    },
  ];

  for (const { src, dest } of files) {
    if (fs.existsSync(dest)) {
      log.info('file_skipped', `文件已存在，跳过拷贝: ${dest}`, {
        path: dest,
      });
    } else {
      if (!fs.existsSync(src)) {
        throw new Error(`模板文件不存在: ${src}`);
      }
      const content = fs.readFileSync(src);
      fs.writeFileSync(dest, content);
      const stat = fs.statSync(dest);
      log.info('file_created', `从模板创建文件: ${dest}`, {
        path: dest,
        size_bytes: stat.size,
        from_template: true,
      });
    }
  }

  return {
    reqMdPath:    files[0].dest,
    configEnvPath: files[1].dest,
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
    : process.env.AI_STD3_PROJECT
      ? path.resolve(process.env.AI_STD3_PROJECT)
      : process.cwd();

  const skillsRoot = process.env.CURSOR_SKILLS_ROOT
    || path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

  try {
    setupInputs({ projectRoot, skillsRoot, runId: args['run-id'] });
    process.exit(0);
  } catch (err) {
    console.error(`[ERROR] setup-inputs 失败: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { setupInputs };

'use strict';

/**
 * verify-inputs.cjs
 * 校验 inputs/req.md 所有带 * 的 H2 节内容非空
 * 校验 inputs/config.env 中 CLOUD_PROVIDER 与对应密钥非空
 * 通过 → 退出码 0
 * 未通过 → 退出码 2，打印 missing[]
 */

const fs   = require('fs');
const path = require('path');
const { createLogger } = require('./logger.cjs');

/**
 * 解析 config.env 键值对（忽略注释和空行）
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseEnv(content) {
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

/**
 * 从文本中剥离所有 HTML 注释（含多行注释块 <!-- ... -->）
 * @param {string} text
 * @returns {string}
 */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 检查 req.md 中所有带 * 的 H2 节（## xxx *）内容非空
 * @param {string} content
 * @returns {string[]} 内容为空的节标题列表
 */
function checkRequiredSections(content) {
  const missing = [];
  // 匹配所有 H2 节：## 标题 *
  const h2Pattern = /^## (.+\*)\s*$/gm;
  let match;

  while ((match = h2Pattern.exec(content)) !== null) {
    const title = match[1].trim();
    const startIdx = match.index + match[0].length;

    // 找到下一个 ## 或文件末尾
    const nextH2Match = /^## /m.exec(content.slice(startIdx));
    const sectionContent = nextH2Match
      ? content.slice(startIdx, startIdx + nextH2Match.index)
      : content.slice(startIdx);

    // 剥离 HTML 注释（含多行），再检查是否有实质内容
    const stripped = stripHtmlComments(sectionContent);
    const substantialLines = stripped.split('\n').filter(l => l.trim() !== '');

    if (substantialLines.length === 0) {
      missing.push(title);
    }
  }

  return missing;
}

/**
 * 检查 config.env 的 CLOUD_PROVIDER 与对应密钥
 * @param {Record<string, string>} env
 * @returns {string[]} 缺失的字段列表
 */
function checkCloudProvider(env) {
  const missing = [];
  const provider = env['CLOUD_PROVIDER'];

  if (!provider) {
    missing.push('CLOUD_PROVIDER');
    return missing;
  }

  if (provider === 'cloudflare') {
    if (!env['CLOUDFLARE_API_TOKEN']) {
      missing.push('CLOUDFLARE_API_TOKEN');
    }
    // CLOUDFLARE_ACCOUNT_ID 推荐填写但非严格必须
  } else if (provider === 'aws') {
    if (!env['AWS_ACCESS_KEY_ID'])     missing.push('AWS_ACCESS_KEY_ID');
    if (!env['AWS_SECRET_ACCESS_KEY']) missing.push('AWS_SECRET_ACCESS_KEY');
    if (!env['AWS_REGION'])            missing.push('AWS_REGION');
  } else if (provider === 'gcp') {
    if (!env['GCP_PROJECT_ID'])               missing.push('GCP_PROJECT_ID');
    if (!env['GCP_SERVICE_ACCOUNT_KEY_JSON']) missing.push('GCP_SERVICE_ACCOUNT_KEY_JSON');
  } else if (provider === 'manual') {
    // manual 模式不需要额外密钥
  } else {
    missing.push(`CLOUD_PROVIDER 值无效（当前: ${provider}，允许: cloudflare|aws|gcp|manual）`);
  }

  return missing;
}

/**
 * Cursor / 流水线环境变量（inputs/config.env）
 * @param {Record<string, string>} env
 * @returns {string[]}
 */
function checkCursorAgentEnv(env) {
  const missing = [];
  if (!env['CURSOR_API_KEY'] || !String(env['CURSOR_API_KEY']).trim()) {
    missing.push('CURSOR_API_KEY');
  }
  return missing;
}

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} [opts.runId]
 * @param {object} [opts.logger]
 * @returns {{ passed: boolean, missing: string[], warnings: string[] }}
 */
function verifyInputs({ projectRoot, runId, logger: externalLogger }) {
  const log = externalLogger || createLogger({ projectRoot, stage: 'setup', runId });

  const reqMdPath    = path.join(projectRoot, 'inputs', 'req.md');
  const configEnvPath = path.join(projectRoot, 'inputs', 'config.env');
  const missing = [];
  const warnings = [];

  // ── 校验 req.md ────────────────────────────────────────────────
  if (!fs.existsSync(reqMdPath)) {
    missing.push('inputs/req.md 文件不存在');
  } else {
    const content = fs.readFileSync(reqMdPath, 'utf8');
    const missingReqSections = checkRequiredSections(content);
    for (const section of missingReqSections) {
      missing.push(`req.md 节 [${section}] 内容为空`);
    }
  }

  // ── 校验 config.env ─────────────────────────────────────────────
  if (!fs.existsSync(configEnvPath)) {
    missing.push('inputs/config.env 文件不存在');
  } else {
    const content = fs.readFileSync(configEnvPath, 'utf8');
    const env = parseEnv(content);
    const missingEnvKeys = checkCloudProvider(env);
    for (const key of missingEnvKeys) {
      missing.push(`config.env 缺失字段: ${key}`);
    }
    const missingCursor = checkCursorAgentEnv(env);
    for (const key of missingCursor) {
      missing.push(`config.env 缺失字段: ${key}`);
    }
    if (!env['CURSOR_SKILLS_ROOT'] || !String(env['CURSOR_SKILLS_ROOT']).trim()) {
      warnings.push('CURSOR_SKILLS_ROOT 未设置，将使用默认 ~/.cursor/skills');
    }
    if (!env['PIPELINE_MODEL'] || !String(env['PIPELINE_MODEL']).trim()) {
      warnings.push('PIPELINE_MODEL 未设置，将使用 config 默认 composer-2');
    }
  }

  const passed = missing.length === 0;
  const checkedAt = new Date().toLocaleString('zh-CN', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  if (passed) {
    log.info('validation_pass', '输入校验通过', {
      checks: ['req.md 必填节', 'config.env 云平台密钥', 'CURSOR_API_KEY'],
      warnings,
    });
  } else {
    log.error('validation_fail', `输入校验未通过，缺少 ${missing.length} 项`, {
      missing,
      invalid: [],
    });
  }

  return { passed, missing, warnings, checkedAt };
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

  const result = verifyInputs({ projectRoot, runId: args['run-id'] });
  if (!result.passed) {
    console.error('\n缺失项：');
    result.missing.forEach(m => console.error(`  - ${m}`));
    process.exit(2);
  }
  process.exit(0);
}

module.exports = {
  verifyInputs,
  parseEnv,
  checkRequiredSections,
  checkCloudProvider,
  checkCursorAgentEnv,
  stripHtmlComments,
};

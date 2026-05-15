'use strict';

const fs = require('fs');
const path = require('path');
const { configJsonPath, configEnvPath, stagesPath } = require('./lib/paths.cjs');
const { collectForbiddenKeyViolations } = require('./lib/forbidden-scan.cjs');
const { parseConfigEnv, validateEnvKeys } = require('./lib/config-env.cjs');
const { matchArtifactsForService } = require('./lib/artifacts.cjs');

const ENV = 'dev';

/**
 * @param {string} projectRoot
 * @param {{ requireDeploy?: boolean }} [opts]
 * @returns {{ ok: boolean, message?: string, config?: object, stages?: object }}
 */
function runPreflight(projectRoot, opts = {}) {
  const cfgPath = configJsonPath(projectRoot, ENV);
  const envPath = configEnvPath(projectRoot);
  const stPath = stagesPath(projectRoot);

  if (!fs.existsSync(cfgPath)) {
    return { ok: false, message: `缺少 ${path.relative(projectRoot, cfgPath)}` };
  }
  if (!fs.existsSync(envPath)) {
    return { ok: false, message: `缺少 ${path.relative(projectRoot, envPath)}` };
  }
  if (!fs.existsSync(stPath)) {
    return { ok: false, message: `缺少 ${path.relative(projectRoot, stPath)}` };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    return { ok: false, message: `config.dev.json 解析失败: ${e.message}` };
  }

  if (config._schema && config._schema.environment && config._schema.environment !== 'dev') {
    return { ok: false, message: 'config.dev.json._schema.environment 必须为 dev' };
  }

  const patterns = (config.security && config.security.forbidden_json_key_patterns) || [];
  const bad = collectForbiddenKeyViolations(config, patterns);
  if (bad.length) {
    return { ok: false, message: `forbidden 键扫描失败:\n${bad.join('\n')}` };
  }

  try {
    parseConfigEnv(envPath);
  } catch (e) {
    return { ok: false, message: `读取 docs/config.env 失败: ${e.message}` };
  }

  let stages;
  try {
    stages = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  } catch (e) {
    return { ok: false, message: `stages.json 解析失败: ${e.message}` };
  }

  const deployEnabled = !!(config.deploy && config.deploy.enabled);
  if (deployEnabled) {
    const providerRaw = (config.deploy && config.deploy.provider) || 'manual';
    const provider = String(providerRaw).toLowerCase();
    const allowExit8Test =
      process.env.AI_PUBLISH_DEV3_SELFTEST === '1' && String(providerRaw).toLowerCase() === 'exit8-test';
    if (deployEnabled && !allowExit8Test && provider !== 'manual' && provider !== 'cloudflare') {
      return {
        ok: false,
        message: `preflight: deploy.provider="${providerRaw}" 尚无自动化实现；请改为 manual、cloudflare 或扩展 providers（publish3.md §4.1）。`,
      };
    }

    const mp = stages.stages && stages.stages.merge_push;
    const bu = stages.stages && stages.stages.build;
    if (!mp || mp.status !== 'completed' || !mp.validation || mp.validation.passed !== true) {
      return { ok: false, message: 'deploy 门闸: stages.merge_push 须为 completed 且 validation.passed=true' };
    }
    if (!bu || bu.status !== 'completed' || !bu.validation || bu.validation.passed !== true) {
      return { ok: false, message: 'deploy 门闸: stages.build 须为 completed 且 validation.passed=true' };
    }
    const services = (config.deploy && config.deploy.services) || [];
    if (!services.some((s) => s && s.client_target)) {
      return { ok: false, message: 'deploy.enabled=true 时 deploy.services 须至少包含一条带 client_target 的 service' };
    }
    const arts = (bu.outputs && bu.outputs.artifacts) || [];
    for (const svc of services) {
      if (!svc || !svc.client_target) continue;
      const matches = matchArtifactsForService(svc, arts);
      if (matches.length !== 1) {
        return {
          ok: false,
          message: `artifact 一对一映射失败: (${svc.client_target},${svc.sub_platform || ''}) artifact_ref=${svc.artifact_ref || 'n/a'} → ${matches.length} 条`,
        };
      }
    }

    if (deployEnabled) {
      const depCfg = config.deploy;
      if (!depCfg.provider || !Array.isArray(depCfg.services)) {
        return { ok: false, message: 'deploy.enabled=true 时须设置 deploy.provider 与 deploy.services[]' };
      }
    }

    if (deployEnabled && String(providerRaw).toLowerCase() === 'cloudflare') {
      let envMap;
      try {
        envMap = parseConfigEnv(envPath);
      } catch (e) {
        return { ok: false, message: `preflight cloudflare: 读取 config.env 失败: ${e.message}` };
      }
      const vr = validateEnvKeys(envMap, ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], { requireNonEmpty: true });
      if (!vr.ok) {
        return { ok: false, message: `preflight cloudflare: ${vr.message}` };
      }
    }
  }

  return { ok: true, config, stages };
}

if (require.main === module) {
  const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
  const args = parseRunArgs(process.argv, { environment: 'dev' });
  const root = requireProject(args.project);
  const r = runPreflight(root, { requireDeploy: args.requireDeploy });
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  console.error('preflight ok (dev)');
  process.exit(0);
}

module.exports = { runPreflight, ENV };

'use strict';

const fs = require('fs');
const path = require('path');
const { configJsonPath, configEnvPath, stagesPath } = require('./lib/paths.cjs');
const { collectForbiddenKeyViolations } = require('./lib/forbidden-scan.cjs');

const ENV = 'release';

/**
 * @param {string} projectRoot
 * @param {{ requireDeploy?: boolean }} [opts]
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
    return { ok: false, message: `config.release.json 解析失败: ${e.message}` };
  }

  if (config._schema && config._schema.environment && config._schema.environment !== 'release') {
    return { ok: false, message: 'config.release.json._schema.environment 必须为 release' };
  }

  const patterns = (config.security && config.security.forbidden_json_key_patterns) || [];
  const bad = collectForbiddenKeyViolations(config, patterns);
  if (bad.length) {
    return { ok: false, message: `forbidden 键扫描失败:\n${bad.join('\n')}` };
  }

  let stages;
  try {
    stages = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  } catch (e) {
    return { ok: false, message: `stages.json 解析失败: ${e.message}` };
  }

  const deployEnabled = !!(config.deploy && config.deploy.enabled);
  if (deployEnabled || opts.requireDeploy) {
    const mp = stages.stages && stages.stages.merge_push;
    const bu = stages.stages && stages.stages.build;
    if (!mp || mp.status !== 'completed' || !mp.validation || mp.validation.passed !== true) {
      return { ok: false, message: 'deploy 门闸: stages.merge_push 须为 completed 且 validation.passed=true' };
    }
    if (!bu || bu.status !== 'completed' || !bu.validation || bu.validation.passed !== true) {
      return { ok: false, message: 'deploy 门闸: stages.build 须为 completed 且 validation.passed=true' };
    }
    const services = (config.deploy && config.deploy.services) || [];
    const arts = (bu.outputs && bu.outputs.artifacts) || [];
    for (const svc of services) {
      if (!svc || !svc.client_target) continue;
      const sub = svc.sub_platform || '';
      const matches = arts.filter(
        (a) =>
          a &&
          a.client_target === svc.client_target &&
          (a.sub_platform || '') === sub &&
          a.status === 'success' &&
          a.artifact_path
      );
      if (matches.length !== 1) {
        return {
          ok: false,
          message: `artifact 一对一映射失败: service (${svc.client_target},${sub}) 匹配到 ${matches.length} 条成功产物`,
        };
      }
    }
  }

  return { ok: true, config, stages };
}

if (require.main === module) {
  const { parseRunArgs, requireProject } = require('./lib/paths.cjs');
  const args = parseRunArgs(process.argv, { environment: 'release' });
  const root = requireProject(args.project);
  const r = runPreflight(root, { requireDeploy: args.requireDeploy });
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  console.error('preflight ok (release)');
  process.exit(0);
}

module.exports = { runPreflight, ENV };

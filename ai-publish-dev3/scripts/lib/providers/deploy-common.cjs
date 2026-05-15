'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseConfigEnv } = require('../config-env.cjs');

/**
 * @param {string} cmd
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {(s:string)=>void} log
 */
function runCmd(cmd, cwd, env, log) {
  log(`exec: ${cmd} (cwd=${cwd})`);
  const r = spawnSync(cmd, { cwd, env, shell: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) {
    const err = new Error((r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 2000));
    err.exitCode = r.status;
    throw err;
  }
  return r;
}

/**
 * 合并 docs/config.env 到子进程环境（键名大小写保留）。
 * @param {string} projectRoot
 * @returns {{ childEnv: NodeJS.ProcessEnv, envMap: Map<string,string> }}
 */
function mergeConfigEnvIntoProcess(projectRoot) {
  const envPath = path.join(projectRoot, 'docs', 'config.env');
  const envMap = parseConfigEnv(envPath);
  const out = { ...process.env };
  for (const [k, v] of envMap.entries()) {
    out[k] = v;
  }
  return { childEnv: out, envMap };
}

/**
 * @param {string} projectRoot
 * @param {{ artifact_path: string }} art
 */
function resolveArtifactPath(projectRoot, art) {
  const p = art && art.artifact_path ? String(art.artifact_path) : '';
  if (!p) {
    const e = new Error('artifact_path 为空');
    e.code = 'CONFIG';
    throw e;
  }
  return path.isAbsolute(p) ? p : path.join(projectRoot, p);
}

/**
 * 静态站点类部署：目录用自身，文件用所在目录。
 * @param {string} artifactAbs
 */
function deployableDir(artifactAbs) {
  const stat = fs.statSync(artifactAbs);
  return stat.isDirectory() ? artifactAbs : path.dirname(artifactAbs);
}

/**
 * @param {object} svc
 */
function resolveServiceName(svc) {
  const rc = svc && svc.resource_config && typeof svc.resource_config === 'object' ? svc.resource_config : {};
  return (
    (svc.service_name && String(svc.service_name).trim()) ||
    (rc.project_name && String(rc.project_name).trim()) ||
    (rc.script_name && String(rc.script_name).trim()) ||
    svc.client_target ||
    'app'
  );
}

module.exports = {
  runCmd,
  mergeConfigEnvIntoProcess,
  resolveArtifactPath,
  deployableDir,
  resolveServiceName,
};

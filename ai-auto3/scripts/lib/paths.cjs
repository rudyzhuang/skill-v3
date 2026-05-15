'use strict';

const fs = require('fs');
const path = require('path');

/** `<cursor_skills_root>`：本文件位于 `ai-auto3/scripts/lib/`，上溯三级到 skills 根 */
function skillsRootFromThisFile() {
  return path.resolve(__dirname, '..', '..', '..');
}

function skillDir(skillName) {
  return path.join(skillsRootFromThisFile(), skillName);
}

function scriptPath(skillName, relFromSkill) {
  return path.join(skillDir(skillName), relFromSkill);
}

function requireAbsoluteProject(projectOpt) {
  if (!projectOpt || !String(projectOpt).trim()) {
    const e = new Error('missing --project=<absolute path to business project root>');
    e.code = 'NO_PROJECT';
    throw e;
  }
  const abs = path.resolve(String(projectOpt).trim());
  if (!path.isAbsolute(abs)) {
    const e = new Error('--project must be an absolute path');
    e.code = 'PROJECT_NOT_ABS';
    throw e;
  }
  if (!fs.existsSync(abs)) {
    const e = new Error(`--project path does not exist: ${abs}`);
    e.code = 'PROJECT_NOENT';
    throw e;
  }
  return abs;
}

function stagesJsonPath(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'stages.json');
}

function configDevPath(projectRoot) {
  return path.join(projectRoot, 'docs', 'config.dev.json');
}

function configReleasePath(projectRoot) {
  return path.join(projectRoot, 'docs', 'config.release.json');
}

function configEnvPath(projectRoot) {
  return path.join(projectRoot, 'docs', 'config.env');
}

function agentSessionsDir(projectRoot) {
  return path.join(projectRoot, '.agent-sessions');
}

function pipelineLockPath(projectRoot) {
  return path.join(projectRoot, '.agent-sessions', 'locks', 'pipeline.pid');
}

module.exports = {
  skillsRootFromThisFile,
  skillDir,
  scriptPath,
  requireAbsoluteProject,
  stagesJsonPath,
  configDevPath,
  configReleasePath,
  configEnvPath,
  agentSessionsDir,
  pipelineLockPath,
};

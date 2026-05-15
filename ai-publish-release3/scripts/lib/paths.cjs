'use strict';

const path = require('path');
const fs = require('fs');

/**
 * @param {string[]} argv
 * @param {{ environment: 'dev'|'release' }} ctx
 */
function parseRunArgs(argv, ctx) {
  const args = {
    _: [],
    project: null,
    fromStage: null,
    forceRerun: false,
    dryRun: false,
    sessionId: null,
    requireDeploy: false,
    requireSmoke: false,
    invokedByAutorun: false,
    confirmDeploy: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--project=')) args.project = a.slice('--project='.length);
    else if (a === '--project') args.project = argv[++i];
    else if (a.startsWith('--from-stage=')) args.fromStage = a.slice('--from-stage='.length);
    else if (a === '--from-stage') args.fromStage = argv[++i];
    else if (a === '--force-rerun') args.forceRerun = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--session-id=')) args.sessionId = a.slice('--session-id='.length);
    else if (a === '--session-id') args.sessionId = argv[++i];
    else if (a === '--require-deploy') args.requireDeploy = true;
    else if (a === '--require-smoke') args.requireSmoke = true;
    else if (a === '--invoked-by-autorun') args.invokedByAutorun = true;
    else if (a === '--confirm-deploy') args.confirmDeploy = true;
    else if (!a.startsWith('-')) args._.push(a);
  }
  return args;
}

function requireProject(projectArg) {
  if (!projectArg || !path.isAbsolute(projectArg)) {
    console.error('必须提供业务项目根的绝对路径：--project=<root>');
    process.exit(1);
  }
  const root = path.resolve(projectArg);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error('项目根不存在或不是目录:', root);
    process.exit(1);
  }
  return root;
}

function configJsonPath(projectRoot, env) {
  return path.join(projectRoot, 'docs', env === 'dev' ? 'config.dev.json' : 'config.release.json');
}

function configEnvPath(projectRoot) {
  return path.join(projectRoot, 'docs', 'config.env');
}

function stagesPath(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'stages.json');
}

module.exports = {
  parseRunArgs,
  requireProject,
  configJsonPath,
  configEnvPath,
  stagesPath,
};

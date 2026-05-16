'use strict';

const path = require('path');
const fs = require('fs');

function parseRunArgs(argv) {
  const args = {
    project: null,
    forceRerun: false,
    dryRun: false,
    sessionId: null,
    requireUiE2e: false,
    invokedByAutorun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--project=')) args.project = a.slice('--project='.length);
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--force-rerun') args.forceRerun = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--session-id=')) args.sessionId = a.slice('--session-id='.length);
    else if (a === '--require-ui-e2e') args.requireUiE2e = true;
    else if (a === '--invoked-by-autorun') args.invokedByAutorun = true;
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

function configJsonPath(projectRoot) {
  return path.join(projectRoot, 'docs', 'config.dev.json');
}

function stagesPath(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'stages.json');
}

function skillRoot() {
  return path.resolve(__dirname, '..', '..');
}

module.exports = {
  parseRunArgs,
  requireProject,
  configJsonPath,
  stagesPath,
  skillRoot,
};

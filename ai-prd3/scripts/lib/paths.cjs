'use strict';

const path = require('path');
const fs = require('fs');

/**
 * @param {string[]} argv process.argv
 */
function parseArgs(argv) {
  const args = {
    _: [],
    project: null,
    force: false,
    lang: 'cn',
    allowFillMissingKeys: false,
    json: null,
    timeoutSec: null,
    noTimeout: false,
    sessionId: '',
    rawInput: null,
    failOnChange: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--project=')) args.project = a.slice('--project='.length);
    else if (a === '--project') args.project = argv[++i];
    else if (a.startsWith('--raw-input=')) args.rawInput = a.slice('--raw-input='.length);
    else if (a === '--raw-input') args.rawInput = argv[++i];
    else if (a === '--fail-on-change') args.failOnChange = true;
    else if (a === '--force') args.force = true;
    else if (a === '--no-timeout') args.noTimeout = true;
    else if (a.startsWith('--lang=')) args.lang = a.slice('--lang='.length);
    else if (a === '--allow-fill-missing-keys') args.allowFillMissingKeys = true;
    else if (a.startsWith('--session-id=')) args.sessionId = a.slice('--session-id='.length).trim();
    else if (a === '--session-id') args.sessionId = String(argv[++i] || '').trim();
    else if (a.startsWith('--json=')) args.json = a.slice('--json='.length);
    else if (a.startsWith('--timeout-sec=')) args.timeoutSec = Number(a.slice('--timeout-sec='.length), 10);
    else if (!a.startsWith('-')) args._.push(a);
  }
  return args;
}

function requireProject(args) {
  if (!args.project || !path.isAbsolute(args.project)) {
    console.error('必须提供业务项目根的绝对路径：--project=<root>');
    process.exit(1);
  }
  const root = path.resolve(args.project);
  if (!fs.existsSync(root)) {
    console.error('项目根不存在:', root);
    process.exit(1);
  }
  return root;
}

/** @param {string} modulePath __filename */
function skillDirFrom(modulePath) {
  const dir = path.dirname(modulePath);
  return path.basename(dir) === 'lib' ? path.join(dir, '..', '..') : path.join(dir, '..');
}

function stagesPath(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'stages.json');
}

function prdSpecPath(projectRoot) {
  return path.join(projectRoot, 'docs', 'prd-spec.md');
}

module.exports = {
  parseArgs,
  requireProject,
  skillDirFrom,
  stagesPath,
  prdSpecPath,
};

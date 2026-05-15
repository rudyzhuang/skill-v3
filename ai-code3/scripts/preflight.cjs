'use strict';

const fs = require('fs');
const path = require('path');
const stagesIo = require('./lib/stages-io.cjs');
const secret = require('./lib/secret-scan.cjs');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function run(ctx) {
  const { projectRoot } = ctx;
  const errs = [];
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    errs.push('--project must be an absolute path');
  } else if (!fs.existsSync(projectRoot)) {
    errs.push(`project root not found: ${projectRoot}`);
  }

  if (errs.length === 0) {
    try {
      const doc = stagesIo.readStagesSync(projectRoot);
      stagesIo.assertSchemaSupported(doc);
    } catch (e) {
      errs.push(e.message || String(e));
    }
  }

  const dev = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(dev)) {
    errs.push(`missing ${dev}`);
  } else {
    try {
      const j = loadJson(dev);
      const fp = secret.extractForbiddenPatterns(j);
      const r = secret.scanConfigObject(j, fp);
      if (!r.ok) errs.push(...r.errors);
    } catch (e) {
      errs.push(`config.dev.json: ${e.message}`);
    }
  }

  const rel = path.join(projectRoot, 'docs', 'config.release.json');
  if (fs.existsSync(rel)) {
    try {
      const j = loadJson(rel);
      const r = secret.scanConfigObject(j, secret.extractForbiddenPatterns(j));
      if (!r.ok) errs.push(...r.errors);
    } catch (e) {
      errs.push(`config.release.json: ${e.message}`);
    }
  }

  if (errs.length) {
    console.error(errs.join('\n'));
    return 1;
  }
  return 0;
}

module.exports = { run };

if (require.main === module) {
  const { parseCommonArgs } = require('./lib/cli-args.cjs');
  const o = parseCommonArgs(process.argv);
  if (!o.project) {
    console.error('missing --project=<absolute>');
    process.exit(1);
  }
  run({ projectRoot: o.project, options: o }).then((c) => process.exit(c));
}

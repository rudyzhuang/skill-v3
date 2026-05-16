'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, requireProject, prdSpecPath } = require('./lib/paths.cjs');
const { scanJsonSecrets } = require('./lib/secret-scan.cjs');
const { validateDeployServicesCoverage } = require('./lib/sync-config-from-req.cjs');
const { parseClientTargets, tryLegacyYaml } = require('./prd-parse-client-targets.cjs');

const SUPPORTED_SCHEMA_MAX = 1;

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function validateOne(obj, label, forbidden) {
  if (!obj._schema || typeof obj._schema.version !== 'number') {
    return `${label}:missing_schema_version`;
  }
  if (obj._schema.version > SUPPORTED_SCHEMA_MAX) {
    return `${label}:unsupported_schema:${obj._schema.version}`;
  }
  const scan = scanJsonSecrets(obj, forbidden);
  if (!scan.ok) return `${label}:secret_scan:${scan.errors.join(';')}`;
  return null;
}

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  const devPath = path.join(root, 'docs', 'config.dev.json');
  const relPath = path.join(root, 'docs', 'config.release.json');
  for (const p of [devPath, relPath]) {
    if (!fs.existsSync(p)) {
      console.error('缺少配置文件', p);
      process.exit(1);
    }
  }
  const dev = loadJson(devPath);
  const rel = loadJson(relPath);
  const forbidden = dev.security?.forbidden_json_key_patterns || [];
  const errs = [
    validateOne(dev, 'config.dev.json', forbidden),
    validateOne(rel, 'config.release.json', forbidden),
  ].filter(Boolean);
  if (errs.length) {
    console.error(JSON.stringify({ ok: false, errors: errs }, null, 2));
    process.exit(1);
  }

  const specPath = prdSpecPath(root);
  if (fs.existsSync(specPath)) {
    let p = parseClientTargets(fs.readFileSync(specPath, 'utf8'));
    if (!p.ok) {
      const leg = tryLegacyYaml(fs.readFileSync(specPath, 'utf8'));
      if (leg?.length) p = { ok: true, slugs: leg };
    }
    if (p.ok) {
      const cov = validateDeployServicesCoverage(dev, p.slugs);
      if (!cov.ok) {
        console.error(
          JSON.stringify(
            {
              ok: false,
              errors: [`config.dev.json:deploy.services_missing:${cov.missing.join(',')}`],
              hint: '运行 node scripts/run.cjs apply-raw-input-config --project=<root>',
            },
            null,
            2,
          ),
        );
        process.exit(1);
      }
    }
  }

  console.log(JSON.stringify({ ok: true }, null, 2));
}

main();

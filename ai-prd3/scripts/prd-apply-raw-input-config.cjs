'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs, requireProject } = require('./lib/paths.cjs');
const { detectRawInputDrift, readStages, writeStages } = require('./lib/raw-input.cjs');
const { parseRawRequirements, collectSection } = require('./lib/req-parse.cjs');
const { syncDeployAndSmoke, validateDeployServicesCoverage } = require('./lib/sync-config-from-req.cjs');
const { parseClientTargets, tryLegacyYaml } = require('./prd-parse-client-targets.cjs');

function loadDeclaredTargets(root) {
  const specPath = path.join(root, 'docs', 'prd-spec.md');
  if (!fs.existsSync(specPath)) return [];
  let p = parseClientTargets(fs.readFileSync(specPath, 'utf8'));
  if (!p.ok) {
    const leg = tryLegacyYaml(fs.readFileSync(specPath, 'utf8'));
    if (leg?.length) return leg;
  }
  return p.ok ? p.slugs : [];
}

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  const drift = detectRawInputDrift(root, { rawInputOverride: args.rawInput });
  if (!drift.ok) {
    console.error(JSON.stringify(drift, null, 2));
    process.exit(1);
  }

  const text = fs.readFileSync(drift.abs_path, 'utf8');
  const parsed = parseRawRequirements(text);
  const fromSpec = loadDeclaredTargets(root);
  const declared = fromSpec.length ? fromSpec : parsed.client_targets;

  const updated = [];
  for (const label of ['config.dev.json', 'config.release.json']) {
    const cfgPath = path.join(root, 'docs', label);
    if (!fs.existsSync(cfgPath)) continue;
    const cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const next = syncDeployAndSmoke(cur, parsed, declared);
    next.metadata = next.metadata || {};
    next.metadata.updated_at = new Date().toISOString();
    next.metadata.raw_input_sync = drift.path;
    fs.writeFileSync(cfgPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    updated.push(label);
  }

  const dev = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'config.dev.json'), 'utf8'));
  const coverage = validateDeployServicesCoverage(dev, declared);

  const stages = readStages(root) || {};
  stages.stages = stages.stages || {};
  stages.stages.prd = stages.stages.prd || {};
  stages.stages.prd.inputs = stages.stages.prd.inputs || {};
  const functionalSection = collectSection(text, ['功能需求']);
  stages.stages.prd.inputs.raw_input_path = drift.path;
  stages.stages.prd.inputs.raw_input_hash = drift.content_hash;
  stages.stages.prd.inputs.raw_input_refs = [drift.path];
  stages.stages.prd.inputs.raw_input_functional_hash = crypto
    .createHash('sha256')
    .update(functionalSection, 'utf8')
    .digest('hex');
  stages.pipeline = stages.pipeline || {};
  stages.pipeline.raw_input = {
    path: drift.path,
    content_hash: drift.content_hash,
    synced_at: new Date().toISOString(),
  };
  writeStages(root, stages);

  detectRawInputDrift(root, { updateCache: true });

  const out = {
    ok: coverage.ok,
    updated_configs: updated,
    parsed_summary: {
      domain_host: parsed.domain_host,
      base_url: parsed.base_url,
      endpoint_urls: parsed.endpoint_urls,
    },
    deploy_coverage: coverage,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(coverage.ok ? 0 : 1);
}

main();

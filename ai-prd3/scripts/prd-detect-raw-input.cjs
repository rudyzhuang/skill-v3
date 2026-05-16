'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, requireProject } = require('./lib/paths.cjs');
const { detectRawInputDrift, loadRawInputContent, readStages } = require('./lib/raw-input.cjs');
const { parseRawRequirements, inferImpactHints, collectSection } = require('./lib/req-parse.cjs');
const { validateDeployServicesCoverage } = require('./lib/sync-config-from-req.cjs');
const { parseClientTargets, tryLegacyYaml } = require('./prd-parse-client-targets.cjs');

function buildLoadOpts(args) {
  return {
    rawInputOverride: args.rawInput,
    rawInputText: args.rawInputText,
    rawInputStdin: args.rawInputStdin,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  const stages = readStages(root) || {};
  const loadOpts = buildLoadOpts(args);
  const drift = detectRawInputDrift(root, loadOpts);
  if (!drift.ok) {
    console.error(JSON.stringify(drift, null, 2));
    process.exit(1);
  }

  const loaded = loadRawInputContent(root, stages, loadOpts);
  const text = loaded.text;
  const parsed = parseRawRequirements(text);
  const functionalSection = collectSection(text, ['功能需求']);
  const cachedFunctional = stages.stages?.prd?.inputs?.raw_input_functional_hash || '';
  const functionalHash = require('crypto')
    .createHash('sha256')
    .update(functionalSection, 'utf8')
    .digest('hex');
  const functionalChange = !!cachedFunctional && cachedFunctional !== functionalHash;

  const specPath = path.join(root, 'docs', 'prd-spec.md');
  let declared = parsed.client_targets;
  if (fs.existsSync(specPath)) {
    let p = parseClientTargets(fs.readFileSync(specPath, 'utf8'));
    if (!p.ok) {
      const leg = tryLegacyYaml(fs.readFileSync(specPath, 'utf8'));
      if (leg?.length) p = { ok: true, slugs: leg };
    }
    if (p.ok) declared = p.slugs;
  }

  const devPath = path.join(root, 'docs', 'config.dev.json');
  let configCoverage = { ok: true, missing: [] };
  if (fs.existsSync(devPath)) {
    const dev = JSON.parse(fs.readFileSync(devPath, 'utf8'));
    configCoverage = validateDeployServicesCoverage(dev, declared);
  }

  const impact_hints = inferImpactHints(parsed, { functional_change: functionalChange });

  const report = {
    ok: true,
    raw_input: {
      source: drift.source,
      path: drift.path,
      content_hash: drift.content_hash,
      cached_hash: drift.cached_hash,
      cached_source: drift.cached_source,
      changed: drift.changed,
      first_seen: drift.first_seen,
      inline_origin: drift.inline_origin,
    },
    parsed,
    functional_requirements_changed: functionalChange,
    impact_hints,
    config_deploy_coverage: configCoverage,
    requires_agent: drift.changed && (functionalChange || impact_hints.some((h) => h.category === 'domain')),
    requires_apply_config: !!parsed.domain_host,
    next_steps: [],
  };

  if (drift.changed) {
    report.next_steps.push('Agent: 阅读 prompts/raw-input-impact.md，按 impact_hints 更新 docs/prd-spec.md 与各端 prd');
    if (parsed.domain_host) {
      report.next_steps.push('运行: node scripts/run.cjs apply-raw-input-config --project=<root>');
    }
    if (functionalChange) {
      report.next_steps.push('功能变更后: validate-prd && write-prd [--force]');
    }
  }
  if (!configCoverage.ok) {
    report.next_steps.push(`config.deploy.services 缺少: ${configCoverage.missing.join(', ')} → apply-raw-input-config`);
  }

  const reportDir = path.join(root, '.pipeline', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'raw-input-drift.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  report.report_path = path.relative(root, reportPath);

  detectRawInputDrift(root, { ...loadOpts, updateCache: true });

  console.log(JSON.stringify(report, null, 2));
  if (args.failOnChange && drift.changed) process.exit(2);
  process.exit(0);
}

main();

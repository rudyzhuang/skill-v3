'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { parseArgs, requireProject, stagesPath, prdSpecPath, skillDirFrom } = require('./lib/paths.cjs');
const { specUsesLegacyYamlClientTargets } = require('./prd-parse-client-targets.cjs');
const { markPrdFailed } = require('./lib/stage-status.cjs');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalFile(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  const skillDir = skillDirFrom(__filename);
  const scriptDir = path.join(skillDir, 'scripts');

  const stagesFile = stagesPath(root);
  if (!fs.existsSync(stagesFile)) {
    console.error('缺少', stagesFile);
    process.exit(1);
  }
  const stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  if (stages.stages?.prd?.status === 'completed' && stages.stages?.prd?.validation?.passed && !args.force) {
    console.error('prd 已完成：手工重跑须加 --force 或用户确认');
    process.exit(1);
  }

  const chain = [
    ['node', path.join(scriptDir, 'prd-validate-spec.cjs'), `--project=${root}`],
    ['node', path.join(scriptDir, 'prd-validate-derived.cjs'), `--project=${root}`],
    ['node', path.join(scriptDir, 'prd-validate-config.cjs'), `--project=${root}`],
  ];
  for (const c of chain) {
    const r = spawnSync(c[0], c.slice(1), { stdio: 'inherit' });
    if (r.status !== 0) {
      markPrdFailed(root, `write_chain_failed:${path.basename(c[1])}`);
      process.exit(r.status || 1);
    }
  }

  const stagesFresh = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  const specPath = prdSpecPath(root);
  const summaryHash = sha256Hex(Buffer.from(canonicalFile(specPath), 'utf8'));
  const now = new Date().toISOString();
  const declared = stagesFresh.client_targets?.declared || [];

  stagesFresh.stages.prd = stagesFresh.stages.prd || {};
  stagesFresh.stages.prd.status = 'completed';
  stagesFresh.stages.prd.completed_at = now;
  stagesFresh.stages.prd.inputs = stagesFresh.stages.prd.inputs || {};
  stagesFresh.stages.prd.inputs.summary_hash = summaryHash;
  stagesFresh.stages.prd.inputs.source_prd_spec = 'docs/inputs/prd-spec.md';
  stagesFresh.stages.prd.outputs = stagesFresh.stages.prd.outputs || {};
  stagesFresh.stages.prd.outputs.client_targets = declared.slice();
  stagesFresh.stages.prd.outputs.timed_out = false;
  stagesFresh.stages.prd.outputs.timeout_reason = null;
  stagesFresh.stages.prd.outputs.duration_ms = null;
  stagesFresh.stages.prd.validation = stagesFresh.stages.prd.validation || {};
  stagesFresh.stages.prd.validation.passed = true;
  stagesFresh.stages.prd.validation.checked_at = now;
  const legacyNote =
    stagesFresh.client_targets?._bootstrap_note === 'legacy_yaml_client_targets' ||
    specUsesLegacyYamlClientTargets(canonicalFile(specPath), declared);
  if (legacyNote) {
    delete stagesFresh.client_targets._bootstrap_note;
    stagesFresh.stages.prd.validation.summary = 'validate_chain_ok;legacy_yaml_client_targets';
  } else {
    stagesFresh.stages.prd.validation.summary = 'validate_chain_ok';
  }

  const req = stagesFresh.stages.prd.validation.required_files;
  if (Array.isArray(req)) {
    for (const item of req) {
      if (!item || !item.path) continue;
      const abs = path.join(root, item.path);
      const exists = fs.existsSync(abs);
      item.exists = exists;
      item.valid = exists;
    }
  }

  stagesFresh.stages.prd.blocking_issues = [];

  stagesFresh.client_targets = stagesFresh.client_targets || {};
  stagesFresh.client_targets.generated = declared.slice();

  const gen = [];
  for (const slug of declared) {
    gen.push(`docs/${slug}/prd.md`, `docs/${slug}/feature_list.md`);
  }
  gen.push('docs/config.dev.json', 'docs/config.release.json', 'docs/config.env', 'docs/inputs/prd-spec.md');
  stagesFresh.stages.prd.generated_files = [...new Set(gen)];

  stagesFresh.pipeline = stagesFresh.pipeline || {};
  stagesFresh.pipeline.updated_at = now;
  stagesFresh.pipeline.updated_by = 'ai-prd3';

  fs.writeFileSync(stagesFile, `${JSON.stringify(stagesFresh, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, summary_hash: summaryHash }, null, 2));
}

main();

'use strict';

const fs = require('fs');
const path = require('path');
const { detectCursorAgentBin } = require('./detect-agent-bin.cjs');

const STRICT_STAGES = ['codegen', 'build', 'deploy', 'smoke', 'ui_e2e'];
const STRICT_STAGES_PUBLISH = ['deploy', 'smoke'];

function isSoakStrict() {
  return process.env.AI_SOAK3_STRICT === '1' || process.env.AI_SOAK3_STRICT === 'true';
}

function readDriftReport(projectRoot) {
  const p = path.join(projectRoot, '.pipeline', 'reports', 'raw-input-drift.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build autorun plan when soak strict or drift present.
 * @param {string} projectRoot
 * @param {{ featureIds?: string[], forceRerun?: string|null }} opts
 */
function buildSoakAutorunPlan(projectRoot, opts = {}) {
  const drift = readDriftReport(projectRoot);
  const strict = isSoakStrict();
  const impacts = drift?.feature_impacts || [];
  const runFromDrift = drift?.run_feature_ids || [];
  const impacted = drift?.impacted_feature_ids || [];
  const configOnly = !!drift?.config_only;

  const forceRerunStages = new Set();
  if (strict) {
    for (const s of STRICT_STAGES) forceRerunStages.add(s);
  }
  if (configOnly) {
    for (const s of STRICT_STAGES_PUBLISH) forceRerunStages.add(s);
  }

  let scopedFeatureIds = null;
  if (runFromDrift.length > 0) {
    scopedFeatureIds = runFromDrift.slice();
  } else if (strict && opts.featureIds?.length) {
    scopedFeatureIds = opts.featureIds.slice();
  }

  const incrementalFeatureIds = impacted.length
    ? impacted.slice()
    : impacts
        .filter((x) => x.type === 'I')
        .flatMap((x) => x.feature_ids || []);

  let blockReason = null;
  if (strict) {
    const cg = readStagesCodegen(projectRoot);
    const skipped = cg?.agent?.skipped === true || cg?.impl_codegen_status === 'skipped';
    const cfgDev = readConfigDev(projectRoot);
    const agentBin = detectCursorAgentBin(cfgDev);
    if (skipped && !agentBin) {
      blockReason =
        'AI_SOAK3_STRICT=1 但 stages.codegen.outputs.agent.skipped=true 且未探测到 cursor-agent（请运行 ensure-agent-env.cjs）';
    }
  }

  return {
    strict,
    drift,
    forceRerunStages: [...forceRerunStages],
    forceRerunCsv: [...forceRerunStages].join(','),
    scopedFeatureIds,
    incrementalFeatureIds,
    configOnly,
    blockReason,
    designRerunFeatureIds:
      scopedFeatureIds && scopedFeatureIds.length
        ? scopedFeatureIds
        : null,
  };
}

function readConfigDev(projectRoot) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readStagesCodegen(projectRoot) {
  const p = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(p)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return doc.stages?.codegen?.outputs || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} stageKey
 * @param {string|null} forceRerun single stage from CLI
 * @param {string[]} forceRerunStages from soak plan
 */
function shouldForceRerunStage(stageKey, forceRerun, forceRerunStages = []) {
  const sk = String(stageKey || '').replace(/-/g, '_');
  if (forceRerun && (normalizeSingle(forceRerun) === sk || forceRerun === 'all')) return true;
  if (forceRerunStages.includes(sk)) return true;
  if (sk === 'deploy_smoke' && forceRerunStages.some((s) => s === 'deploy' || s === 'smoke')) {
    return true;
  }
  return false;
}

function normalizeSingle(s) {
  return String(s || '').replace(/-/g, '_');
}

/**
 * Whether to skip a code/publish stage under soak scoped run.
 */
function shouldSkipUnderSoakStrict(stageKey, featureIds, soakPlan) {
  if (!soakPlan?.strict) return false;
  if (shouldForceRerunStage(stageKey, null, soakPlan.forceRerunStages)) return false;
  const sk = String(stageKey || '').replace(/-/g, '_');
  if (!STRICT_STAGES.includes(sk) && sk !== 'deploy_smoke') return false;
  if (soakPlan.scopedFeatureIds?.length) {
    const scope = new Set(soakPlan.scopedFeatureIds);
    const touched = featureIds.some((id) => scope.has(id));
    if (touched) return false;
  }
  return true;
}

module.exports = {
  isSoakStrict,
  readDriftReport,
  buildSoakAutorunPlan,
  shouldForceRerunStage,
  shouldSkipUnderSoakStrict,
  STRICT_STAGES,
};

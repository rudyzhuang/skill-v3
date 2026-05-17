'use strict';

const fs = require('fs');
const path = require('path');
const { collectSection } = require('./req-parse.cjs');
const { parseCoreFeatures } = require('./prd-spec-features.cjs');

const BRAND_PATTERNS = [/真实笔记/i, /RealNotes/i, /应用中文名/i, /英文名/i];
const ICON_PATTERNS = [/图标/i, /启动图/i, /splash/i, /app icon/i];

/**
 * @param {string} reqText
 * @param {object} opts
 * @returns {object}
 */
function classifyFeatureImpacts(reqText, opts = {}) {
  const {
    functionalChange = false,
    driftChanged = false,
    specFeatures = [],
    parsed = {},
  } = opts;

  const funcText = collectSection(reqText, ['功能需求']);
  const existingIds = new Set(specFeatures.map((f) => f.featureId));
  const byTarget = (slug) =>
    specFeatures.filter((f) => f.relatedTargets.includes(slug)).map((f) => f.featureId);

  const suggestedNew = [];
  const suggestedImpacted = [];

  const wantsBrand = BRAND_PATTERNS.some((re) => re.test(funcText));
  const wantsIcon = ICON_PATTERNS.some((re) => re.test(funcText));

  if (wantsBrand) {
    const brandInSpec = specFeatures.find(
      (f) => /品牌|BRAND|RealNotes|真实笔记/i.test(`${f.featureId} ${f.name} ${f.description}`)
    );
    if (brandInSpec) {
      if (!suggestedImpacted.includes(brandInSpec.featureId)) suggestedImpacted.push(brandInSpec.featureId);
    } else {
      const mobileIds = byTarget('mobile');
      if (mobileIds.length) {
        for (const id of mobileIds) {
          if (/MOB|FLUTTER|mobile/i.test(id) && !suggestedImpacted.includes(id)) {
            suggestedImpacted.push(id);
          }
        }
      } else {
        suggestedNew.push('MOB-BRAND-001');
      }
    }
  }

  if (wantsIcon) {
    const iconInSpec = specFeatures.find((f) => /ICON|SPLASH|图标|启动/i.test(`${f.featureId} ${f.name}`));
    if (iconInSpec) {
      if (!suggestedImpacted.includes(iconInSpec.featureId)) suggestedImpacted.push(iconInSpec.featureId);
    } else {
      suggestedNew.push('APP-ICON-001');
    }
  }

  const newFeatureIds = suggestedNew.filter((id) => !existingIds.has(id));
  const impactedFeatureIds = [...new Set(suggestedImpacted.filter((id) => existingIds.has(id)))];

  const orthogonalFeatureIds = newFeatureIds.slice();
  const configOnly =
    driftChanged && !functionalChange && !newFeatureIds.length && !impactedFeatureIds.length;

  const featureImpacts = [];

  if (configOnly || (driftChanged && parsed.domain_host)) {
    featureImpacts.push({
      type: 'C',
      label: 'config_only',
      feature_ids: [],
      reason: '域名/URL/部署配置变更；落盘 config.*.json（apply-raw-input-config）',
      pipeline_scope: 'deploy,smoke',
    });
  }

  for (const id of orthogonalFeatureIds) {
    featureImpacts.push({
      type: 'N',
      label: 'new_feature_full_pipeline',
      feature_ids: [id],
      reason: 'req 新增能力，prd-spec 尚无对应 feature_id',
      pipeline_scope: 'design,contract,design_review,codegen,typecheck,test,code_review,merge_push,build',
    });
  }

  for (const id of impactedFeatureIds) {
    if (orthogonalFeatureIds.includes(id)) continue;
    featureImpacts.push({
      type: 'I',
      label: 'impacted_feature_incremental',
      feature_ids: [id],
      reason: '既有 feature 须随 req 变更；codegen 使用 incremental 模式',
      pipeline_scope:
        'design,contract,design_review,codegen,typecheck,test,code_review,merge_push,build',
      codegen_mode: 'incremental',
      reviews: { delta_review_rounds: 2, full_feature_review: true },
    });
  }

  if (functionalChange && !featureImpacts.some((x) => x.type === 'I' || x.type === 'N')) {
    featureImpacts.push({
      type: 'O',
      label: 'functional_change_agent_triage',
      feature_ids: [],
      reason: '功能需求段落变更；须 Agent 对照 prd-spec 判定 O/I/N 并更新 §6',
      pipeline_scope: 'agent_prd_only',
    });
  }

  const runFeatureIds = [
    ...new Set([...newFeatureIds, ...impactedFeatureIds]),
  ];

  const requiresScopedPipeline = runFeatureIds.length > 0 || configOnly;

  return {
    config_only: configOnly,
    new_feature_ids: newFeatureIds,
    impacted_feature_ids: impactedFeatureIds,
    orthogonal_feature_ids: orthogonalFeatureIds,
    run_feature_ids: runFeatureIds,
    feature_impacts: featureImpacts,
    requires_agent:
      driftChanged &&
      (functionalChange || newFeatureIds.length > 0 || impactedFeatureIds.length > 0),
    requires_scoped_pipeline: requiresScopedPipeline,
  };
}

function loadSpecFeatures(projectRoot) {
  const specPath = path.join(projectRoot, 'docs', 'prd-spec.md');
  if (!fs.existsSync(specPath)) return [];
  return parseCoreFeatures(fs.readFileSync(specPath, 'utf8'));
}

module.exports = { classifyFeatureImpacts, loadSpecFeatures, parseCoreFeatures };

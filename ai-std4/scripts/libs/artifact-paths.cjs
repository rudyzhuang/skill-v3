'use strict';

/**
 * 业务项目内容产物路径（docs/ 仅保留 config.*）：
 *   output-stages/prd/                  — prd-spec.md、prd-*.json、feature_list-*.md
 *   output-stages/design/               — <feature_id>.design.json
 *   output-stages/create-ui-scenarios/  — <feature_id>.scenarios.yaml
 *
 * 读取时优先新路径，回退 legacy docs/ 布局（只读兼容）。
 */

const fs   = require('fs');
const path = require('path');

function relFromRoot(projectRoot, absPath) {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

function firstExisting(...candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates.find(Boolean) || candidates[0];
}

/**
 * @param {ReturnType<import('./pipeline-paths.cjs').createPipelinePaths>} pp
 */
function createArtifactPaths(pp) {
  const root    = pp.projectRoot;
  const docsDir = path.join(root, 'docs');

  const prdDir = () => {
    const d = pp.stageOutputDir('prd');
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  const designDir = () => {
    const d = pp.stageOutputDir('design');
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  const uiScenariosDir = () => {
    const d = pp.stageOutputDir('create-ui-scenarios');
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  const prdSpecPath      = () => path.join(prdDir(), 'prd-spec.md');
  const prdSpecPathLegacy = () => path.join(docsDir, 'prd-spec.md');

  function resolvePrdSpecPath() {
    return firstExisting(prdSpecPath(), prdSpecPathLegacy());
  }

  function prdClientJsonPath(fileName) {
    return path.join(prdDir(), fileName);
  }

  function resolvePrdClientJsonPath(fileName) {
    return firstExisting(
      prdClientJsonPath(fileName),
      path.join(docsDir, fileName),
    );
  }

  function featureListPath(clientTarget) {
    return path.join(prdDir(), `feature_list-${clientTarget}.md`);
  }

  function resolveFeatureListPath(clientTarget) {
    return firstExisting(
      featureListPath(clientTarget),
      path.join(docsDir, `feature_list-${clientTarget}.md`),
    );
  }

  function designPath(featureId) {
    return path.join(designDir(), `${featureId}.design.json`);
  }

  function resolveDesignPath(featureId) {
    return firstExisting(
      designPath(featureId),
      path.join(docsDir, 'designs', `${featureId}.design.json`),
    );
  }

  function uiScenarioPath(featureId) {
    return path.join(uiScenariosDir(), `${featureId}.scenarios.yaml`);
  }

  function resolveUiScenarioPath(featureId) {
    return firstExisting(
      uiScenarioPath(featureId),
      path.join(docsDir, 'ui-scenarios', `${featureId}.scenarios.yaml`),
    );
  }

  function prdClientJsonRel(fileName) {
    return relFromRoot(root, prdClientJsonPath(fileName));
  }

  function featureListRel(clientTarget) {
    return relFromRoot(root, featureListPath(clientTarget));
  }

  function prdSpecRel() {
    return relFromRoot(root, prdSpecPath());
  }

  function designRel(featureId) {
    return relFromRoot(root, designPath(featureId));
  }

  function uiScenarioRel(featureId) {
    return relFromRoot(root, uiScenarioPath(featureId));
  }

  /** stages.prd.outputs.sources 用：项目根相对路径 */
  function prdSourceRel(fileName) {
    return prdClientJsonRel(fileName);
  }

  return {
    docsDir,
    prdDir,
    designDir,
    uiScenariosDir,
    prdSpecPath,
    prdSpecPathLegacy,
    resolvePrdSpecPath,
    prdClientJsonPath,
    resolvePrdClientJsonPath,
    featureListPath,
    resolveFeatureListPath,
    designPath,
    resolveDesignPath,
    uiScenarioPath,
    resolveUiScenarioPath,
    prdSpecRel,
    prdClientJsonRel,
    featureListRel,
    designRel,
    uiScenarioRel,
    prdSourceRel,
    relFromRoot,
  };
}

module.exports = { createArtifactPaths, relFromRoot, firstExisting };

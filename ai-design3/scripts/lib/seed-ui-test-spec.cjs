'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const WEB_TARGETS = new Set(['website', 'admin']);
const MOBILE_TARGET = 'mobile';

/** Heuristic UI copy expectations so bootstrap placeholders (feature id only) fail Browser MCP. */
function defaultWebExpectText(featureId, clientTarget) {
  const id = String(featureId || '').toUpperCase();
  if (clientTarget === 'admin') {
    if (id.includes('LOGIN')) return '登录';
    if (id.includes('LIST')) return '笔记';
    if (id.includes('DELETE')) return '删除';
    return '管理';
  }
  if (clientTarget === 'website') {
    if (id.includes('EMPTY')) return '暂无';
    if (id.includes('NAV') || id.includes('HOME')) return '笔记';
    return '笔记';
  }
  return '笔记';
}

/**
 * @param {string} featureId
 * @param {string} clientTarget
 * @param {string[]} [acceptance]
 */
function buildWebUiScenario(featureId, clientTarget, acceptance = []) {
  const textFromAcceptance = acceptance.find((a) => typeof a === 'string' && a.length >= 2 && a.length <= 40);
  const expectText = textFromAcceptance || defaultWebExpectText(featureId, clientTarget);
  return {
    id: `${featureId}-ui-web-smoke`,
    client_target: clientTarget,
    platform: 'web',
    feature_id: featureId,
    steps: [
      { action: 'navigate', url: '{base_url}/' },
      { action: 'snapshot' },
    ],
    expect: [
      { type: 'url_contains', value: clientTarget === 'admin' ? '/admin' : '/website' },
      { type: 'text_present', value: expectText },
    ],
  };
}

function buildMobileUiScenario(featureId) {
  return {
    id: `${featureId}-ui-mobile-smoke`,
    client_target: MOBILE_TARGET,
    platform: 'android',
    feature_id: featureId,
    steps: [{ action: 'wait', value: '1' }],
    expect: [{ type: 'text_present', value: '笔记' }],
  };
}

/**
 * Write `<feature>.test-spec.yaml` with ui_scenarios when missing (does not remove .md).
 * @returns {boolean} true if file was written
 */
function ensureUiTestSpecYaml(baseDir, featureId, clientTarget, designDoc) {
  const yamlPath = path.join(baseDir, `${featureId}.test-spec.yaml`);
  if (fs.existsSync(yamlPath)) return false;

  const ct = String(clientTarget || '').trim();
  const acceptance = Array.isArray(designDoc?.acceptance) ? designDoc.acceptance : [];
  const scenarios = [];

  if (WEB_TARGETS.has(ct)) {
    scenarios.push(buildWebUiScenario(featureId, ct, acceptance));
  } else if (ct === MOBILE_TARGET) {
    scenarios.push(buildMobileUiScenario(featureId));
  } else {
    return false;
  }

  const doc = {
    required_test_levels: ['unit', 'integration', 'ui_e2e'],
    ui_scenarios: scenarios,
  };
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf8');
  return true;
}

module.exports = {
  WEB_TARGETS,
  ensureUiTestSpecYaml,
  buildWebUiScenario,
};

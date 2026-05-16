'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function loadDevConfig(projectRoot) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function contractsDir(projectRoot, config) {
  const rel =
    (config.pipeline && config.pipeline.paths && config.pipeline.paths.contracts_dir) ||
    'docs/contracts';
  return path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
}

/**
 * @param {string} absPath
 * @returns {object[]}
 */
function parseScenariosFromFile(absPath, featureId) {
  if (!fs.existsSync(absPath)) return [];
  const raw = fs.readFileSync(absPath, 'utf8');
  const ext = path.extname(absPath).toLowerCase();
  let doc;
  if (ext === '.json') {
    doc = JSON.parse(raw);
  } else if (ext === '.yaml' || ext === '.yml') {
    doc = yaml.load(raw);
  } else {
    return [];
  }
  const list = Array.isArray(doc?.ui_scenarios) ? doc.ui_scenarios : [];
  return list.map((s) => ({
    ...s,
    feature_id: s.feature_id || featureId,
  }));
}

/**
 * @param {string} projectRoot
 * @param {object} [config]
 * @returns {{ scenarios: object[], sources: string[] }}
 */
function collectUiScenarios(projectRoot, config) {
  const cfg = config || loadDevConfig(projectRoot);
  const root = contractsDir(projectRoot, cfg);
  const scenarios = [];
  const sources = [];
  if (!fs.existsSync(root)) {
    return { scenarios, sources };
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const featureId = ent.name;
    const dir = path.join(root, featureId);
    const candidates = [
      `${featureId}.test-spec.yaml`,
      `${featureId}.test-spec.yml`,
      `${featureId}.test-spec.json`,
    ];
    for (const name of candidates) {
      const abs = path.join(dir, name);
      if (!fs.existsSync(abs)) continue;
      const parsed = parseScenariosFromFile(abs, featureId);
      if (parsed.length) {
        scenarios.push(...parsed);
        sources.push(path.relative(projectRoot, abs));
      }
      break;
    }
  }
  return { scenarios, sources };
}

module.exports = {
  loadDevConfig,
  collectUiScenarios,
  parseScenariosFromFile,
};

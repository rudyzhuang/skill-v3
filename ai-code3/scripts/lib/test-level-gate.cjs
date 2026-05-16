'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED_LEVELS = new Set(['unit', 'integration', 'ui_e2e']);
const IGNORE_DIRS = new Set([
  '.git',
  '.pipeline',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
]);

function normalizeLevel(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  if (s === 'int') return 'integration';
  if (s === 'e2e' || s === 'ui' || s === 'ui-e2e') return 'ui_e2e';
  if (ALLOWED_LEVELS.has(s)) return s;
  return '';
}

function normalizeLevelList(values) {
  const out = [];
  for (const v of values || []) {
    const n = normalizeLevel(v);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function parseLevelsFromText(text) {
  const oneLine = text.match(/required_test_levels\s*:\s*\[([^\]]*)\]/i);
  if (oneLine && oneLine[1]) {
    return oneLine[1]
      .split(',')
      .map((s) => s.replace(/['"]/g, '').trim())
      .filter(Boolean);
  }
  const lines = String(text || '').split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*required_test_levels\s*:\s*$/i.test(l));
  if (idx < 0) return [];
  const vals = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = line.match(/^\s*-\s*["']?([a-zA-Z_ -]+)["']?\s*$/);
    if (!m) break;
    vals.push(m[1].trim());
  }
  return vals;
}

function readUiScenariosFromTestSpec(testSpecAbs) {
  if (!testSpecAbs || !fs.existsSync(testSpecAbs)) return [];
  const raw = fs.readFileSync(testSpecAbs, 'utf8');
  const ext = path.extname(testSpecAbs).toLowerCase();
  if (ext === '.json') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j?.ui_scenarios) ? j.ui_scenarios : [];
    } catch {
      return [];
    }
  }
  if (ext === '.yaml' || ext === '.yml') {
    try {
      const YAML = require('yaml');
      const j = YAML.parse(raw);
      return Array.isArray(j?.ui_scenarios) ? j.ui_scenarios : [];
    } catch {
      return [];
    }
  }
  return [];
}

function readRequiredLevelsFromTestSpec(testSpecAbs) {
  if (!testSpecAbs || !fs.existsSync(testSpecAbs)) {
    return { requiredLevels: [], source: 'none', uiScenarios: [] };
  }
  const raw = fs.readFileSync(testSpecAbs, 'utf8');
  const ext = path.extname(testSpecAbs).toLowerCase();
  const uiScenarios = readUiScenariosFromTestSpec(testSpecAbs);
  if (ext === '.json') {
    try {
      const j = JSON.parse(raw);
      return {
        requiredLevels: normalizeLevelList(j?.required_test_levels),
        source: 'test_spec.required_test_levels',
        uiScenarios,
      };
    } catch {
      return { requiredLevels: [], source: 'test_spec.invalid_json', uiScenarios: [] };
    }
  }
  return {
    requiredLevels: normalizeLevelList(parseLevelsFromText(raw)),
    source: 'test_spec.required_test_levels',
    uiScenarios,
  };
}

function collectFilesRecursive(rootAbs) {
  const out = [];
  function walk(dirAbs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        walk(abs);
      } else if (ent.isFile()) {
        out.push(abs);
      }
    }
  }
  walk(rootAbs);
  return out;
}

function classifyTestLevel(relPath) {
  const p = relPath.replace(/\\/g, '/').toLowerCase();
  const inTestTree = /(^|\/)(test|tests|__tests__)(\/|$)/.test(p);
  const byTestName = p.includes('.test.') || p.includes('.spec.');
  if (
    p.includes('/integration_test/') ||
    p.includes('/tests/e2e/') ||
    p.includes('/e2e/') ||
    p.includes('/ui_e2e/') ||
    p.includes('.e2e.') ||
    p.includes('_e2e.')
  ) {
    return 'ui_e2e';
  }
  if (!inTestTree && !byTestName) return '';
  if (
    p.includes('/integration/') ||
    p.includes('/tests/integration/') ||
    p.includes('/integration-tests/') ||
    p.includes('/it/') ||
    p.includes('.integration.') ||
    p.includes('.int.')
  ) {
    return 'integration';
  }
  if (p.includes('/unit/') || p.includes('.unit.')) {
    return 'unit';
  }
  return '';
}

function evaluateWorktreeTestCoverage({
  projectRoot,
  worktreePath,
  testSpecAbs,
  fallbackRequiredLevels = [],
}) {
  const fromSpec = readRequiredLevelsFromTestSpec(testSpecAbs);
  const requiredLevels = fromSpec.requiredLevels.length
    ? fromSpec.requiredLevels
    : normalizeLevelList(fallbackRequiredLevels);
  const source = fromSpec.requiredLevels.length ? fromSpec.source : 'config.fallback_required_test_levels';
  if (!requiredLevels.length) {
    return {
      required_levels: [],
      missing_levels: [],
      files_by_level: {},
      ui_scenarios_count: fromSpec.uiScenarios?.length || 0,
      source: source === 'config.fallback_required_test_levels' ? 'none' : source,
    };
  }
  const files = collectFilesRecursive(worktreePath);
  const filesByLevel = { unit: [], integration: [], ui_e2e: [] };
  for (const abs of files) {
    const rel = path.relative(worktreePath, abs);
    const level = classifyTestLevel(rel);
    if (level && filesByLevel[level]) filesByLevel[level].push(rel);
  }
  const missingLevels = requiredLevels.filter((l) => {
    if (l === 'ui_e2e') {
      const hasFiles = filesByLevel.ui_e2e && filesByLevel.ui_e2e.length > 0;
      const hasScenarios = (fromSpec.uiScenarios || []).length > 0;
      return !hasFiles && !hasScenarios;
    }
    return !filesByLevel[l] || filesByLevel[l].length === 0;
  });
  return {
    required_levels: requiredLevels,
    missing_levels: missingLevels,
    files_by_level: filesByLevel,
    ui_scenarios_count: (fromSpec.uiScenarios || []).length,
    source,
  };
}

module.exports = {
  normalizeLevel,
  normalizeLevelList,
  readRequiredLevelsFromTestSpec,
  readUiScenariosFromTestSpec,
  evaluateWorktreeTestCoverage,
};

'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED_LEVELS = new Set(['unit', 'integration']);
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

function readRequiredLevelsFromTestSpec(testSpecAbs) {
  if (!testSpecAbs || !fs.existsSync(testSpecAbs)) {
    return { requiredLevels: [], source: 'none' };
  }
  const raw = fs.readFileSync(testSpecAbs, 'utf8');
  const ext = path.extname(testSpecAbs).toLowerCase();
  if (ext === '.json') {
    try {
      const j = JSON.parse(raw);
      return {
        requiredLevels: normalizeLevelList(j?.required_test_levels),
        source: 'test_spec.required_test_levels',
      };
    } catch {
      return { requiredLevels: [], source: 'test_spec.invalid_json' };
    }
  }
  return {
    requiredLevels: normalizeLevelList(parseLevelsFromText(raw)),
    source: 'test_spec.required_test_levels',
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
      source: source === 'config.fallback_required_test_levels' ? 'none' : source,
    };
  }
  const files = collectFilesRecursive(worktreePath);
  const filesByLevel = { unit: [], integration: [] };
  for (const abs of files) {
    const rel = path.relative(worktreePath, abs);
    const level = classifyTestLevel(rel);
    if (level && filesByLevel[level]) filesByLevel[level].push(rel);
  }
  const missingLevels = requiredLevels.filter((l) => !filesByLevel[l] || filesByLevel[l].length === 0);
  return {
    required_levels: requiredLevels,
    missing_levels: missingLevels,
    files_by_level: filesByLevel,
    source,
  };
}

module.exports = {
  normalizeLevel,
  normalizeLevelList,
  readRequiredLevelsFromTestSpec,
  evaluateWorktreeTestCoverage,
};

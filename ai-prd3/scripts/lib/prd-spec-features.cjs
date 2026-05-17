'use strict';

/**
 * Parse docs/prd-spec.md §6 core features table.
 * @param {string} specText
 */
function parseCoreFeatures(specText) {
  const lines = String(specText || '').split('\n');
  const out = [];
  let inCore = false;
  let inTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+6\.\s*核心功能\s*$/.test(line)) {
      inCore = true;
      continue;
    }
    if (inCore && /^##\s+/.test(line) && !/^##\s+6\.\s*核心功能\s*$/.test(line)) {
      break;
    }
    if (!inCore) continue;
    if (!inTable && /^\|\s*功能 ID\s*\|\s*名称\s*\|\s*涉及端\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable || !line.startsWith('|')) continue;
    if (/^\|\s*[-: ]+\|/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((v) => v.trim());
    if (cells.length < 7) continue;
    const [featureId, name, targets, priority, phase, description, acceptance] = cells;
    if (!featureId || /^功能 ID$/i.test(featureId)) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(featureId)) continue;
    out.push({
      featureId,
      name,
      relatedTargets: String(targets || '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
      priority: priority || 'must',
      phase: phase || 'mvp',
      description,
      acceptance,
    });
  }
  return out;
}

module.exports = { parseCoreFeatures };

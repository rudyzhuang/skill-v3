'use strict';

const fs = require('fs');
const path = require('path');

let AjvCtor;
let addFormats;
try {
  AjvCtor = require('ajv');
  addFormats = require('ajv-formats');
} catch (_) {
  AjvCtor = null;
}

function loadValidator(skillRoot) {
  if (!AjvCtor) {
    throw new Error('Missing dependency "ajv". Run: npm install (in ai-design3/)');
  }
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const schemaPath = path.join(skillRoot, 'templates', 'schemas', 'design-review-output.v1.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  return ajv.compile(schema);
}

function validateDesignReviewPayload(payload, skillRoot) {
  const v = loadValidator(skillRoot);
  const ok = v(payload);
  return {
    ok: !!ok,
    errors: ok ? [] : (v.errors || []).map((e) => `${e.instancePath} ${e.message}`),
    data: payload,
  };
}

function isBlockingGap(g) {
  if (!g || typeof g !== 'object') return false;
  if (g.blocking === true) return true;
  return String(g.severity || '').toLowerCase() === 'blocking';
}

/**
 * 展开为 per-feature 条目列表
 * @returns {{ feature_id: string, outputs: object, gaps: object[] }[]}
 */
function expandFeaturePayloads(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.features) && payload.features.length) {
    return payload.features.map((row) => ({
      feature_id: String(row.feature_id || '').trim(),
      outputs: row.outputs || {},
      gaps: Array.isArray(row.gaps) ? row.gaps : [],
    }));
  }
  const fid = String(payload.feature_id || '').trim();
  if (fid) {
    return [
      {
        feature_id: fid,
        outputs: payload.outputs || {},
        gaps: Array.isArray(payload.gaps) ? payload.gaps : [],
      },
    ];
  }
  return [];
}

/**
 * 合并 gaps / alignment 到 stages.design_review（不置 completed）
 */
function mergeDesignReviewIntoStages(stages, payloads, { replaceGapsForFeatures = null } = {}) {
  const doc = stages;
  doc.stages = doc.stages || {};
  doc.stages.design_review = doc.stages.design_review || {};
  doc.stages.design_review.outputs = doc.stages.design_review.outputs || {};
  const existing = Array.isArray(doc.stages.design_review.outputs.gaps)
    ? doc.stages.design_review.outputs.gaps
    : [];
  const replaceSet =
    replaceGapsForFeatures instanceof Set
      ? replaceGapsForFeatures
      : new Set((replaceGapsForFeatures || []).map(String));

  let kept = existing;
  if (replaceSet.size) {
    kept = existing.filter((g) => !replaceSet.has(String(g?.feature_id || '').trim()));
  }

  const added = [];
  const summaries = [];
  let worstDecision = doc.stages.design_review.outputs.decision || 'pending';

  const rank = (d) => {
    const x = String(d || '').toLowerCase();
    if (x === 'failed') return 4;
    if (x === 'needs_contract_fix') return 3;
    if (x === 'needs_design_fix') return 2;
    if (x === 'pending') return 1;
    return 0;
  };

  for (const row of payloads) {
    const fid = row.feature_id;
    if (!fid) continue;
    for (const g of row.gaps || []) {
      added.push({ ...g, feature_id: g.feature_id || fid });
    }
    const sum = String(row.outputs?.alignment_summary || '').trim();
    if (sum) summaries.push(`[${fid}] ${sum}`);
    const dec = row.outputs?.decision;
    if (dec && rank(dec) > rank(worstDecision)) worstDecision = dec;
  }

  doc.stages.design_review.outputs.gaps = [...kept, ...added];
  if (summaries.length) {
    doc.stages.design_review.outputs.alignment_summary = summaries.join('\n');
  }
  if (worstDecision && worstDecision !== 'pending') {
    doc.stages.design_review.outputs.decision = worstDecision;
  }
  return doc;
}

module.exports = {
  validateDesignReviewPayload,
  expandFeaturePayloads,
  mergeDesignReviewIntoStages,
  isBlockingGap,
};

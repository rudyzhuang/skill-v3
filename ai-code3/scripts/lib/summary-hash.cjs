'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256HexFromString(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function stableStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function readFileSafe(projectRoot, rel) {
  if (!rel) return '';
  const p = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

/**
 * §13.1 codegen.inputs.summary_hash
 * @param {object} stagesDoc
 * @param {string} projectRoot
 * @param {string[]} featureIds
 */
function computeCodegenInputHash(stagesDoc, projectRoot, featureIds) {
  const contract = stagesDoc.stages?.contract?.outputs?.artifacts || [];
  const dr = stagesDoc.stages?.design_review?.outputs || {};
  const parts = [
    'feature_ids:',
    stableStringify(featureIds),
    '\nartifacts:',
  ];
  for (const art of contract) {
    const paths = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'];
    for (const k of paths) {
      const rel = art[k];
      parts.push(`\n${k}:${rel}\n`);
      parts.push(readFileSafe(projectRoot, rel));
    }
  }
  parts.push('\ndesign_review_decision:', String(dr.decision || ''));
  parts.push('\nalignment_summary:', String(dr.alignment_summary || ''));
  return sha256HexFromString(parts.join(''));
}

function computeUpstreamHashForStage(stagesDoc, stageKey, projectRoot, featureIds) {
  const s = stagesDoc.stages || {};
  switch (stageKey) {
    case 'codegen':
      return computeCodegenInputHash(stagesDoc, projectRoot, featureIds);
    case 'typecheck': {
      const cg = s.codegen?.inputs?.summary_hash || '';
      const wt = stableStringify(s.codegen?.outputs?.worktrees || []);
      return sha256HexFromString(`typecheck|${cg}|${wt}`);
    }
    case 'test': {
      const th = s.typecheck?.inputs?.summary_hash || '';
      const wt = stableStringify(s.typecheck?.inputs?.worktrees || []);
      return sha256HexFromString(`test|${th}|${wt}`);
    }
    case 'code_review': {
      const th = s.test?.inputs?.summary_hash || '';
      return sha256HexFromString(`code_review|${th}`);
    }
    case 'merge_push': {
      const cr = s.code_review?.inputs?.summary_hash || '';
      const tb = s.merge_push?.inputs?.target_branch || 'main';
      const ap = String(s.merge_push?.inputs?.allow_push ?? '');
      return sha256HexFromString(`merge_push|${cr}|${tb}|${ap}`);
    }
    case 'build': {
      const mp = s.merge_push?.inputs?.summary_hash || '';
      const bc = stableStringify(s.build?.inputs?.client_targets || {});
      return sha256HexFromString(`build|${mp}|${bc}`);
    }
    default:
      return '';
  }
}

/**
 * 附录 A.3：已完成则跳过（不含 force-rerun）
 */
function shouldSkipStage(stagesDoc, stageKey, projectRoot, featureIds, forceRerun) {
  if (forceRerun && (forceRerun === stageKey || forceRerun === 'all')) return false;
  const st = stagesDoc.stages?.[stageKey];
  if (!st) return false;
  if (st.status !== 'completed' || !st.validation?.passed) return false;
  const stored = st.inputs?.summary_hash || '';
  if (!stored) return false;
  let expected = '';
  if (stageKey === 'codegen') {
    expected = computeCodegenInputHash(stagesDoc, projectRoot, featureIds);
  } else {
    expected = computeUpstreamHashForStage(stagesDoc, stageKey, projectRoot, featureIds);
  }
  return stored === expected;
}

module.exports = {
  sha256HexFromString,
  stableStringify,
  computeCodegenInputHash,
  computeUpstreamHashForStage,
  shouldSkipStage,
};

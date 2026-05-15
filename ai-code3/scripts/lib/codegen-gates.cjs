'use strict';

/** §7.2 codegen 前置门闸（供 codegen / preflight 复用） */
function assertCodegenGates(doc) {
  const dr = doc.stages?.design_review;
  if (!dr || dr.status !== 'completed' || !dr.validation?.passed || dr.outputs?.decision !== 'passed') {
    return 'codegen blocked: design_review must be completed with validation.passed and outputs.decision=passed';
  }
  const ct = doc.stages?.contract;
  if (!ct || ct.status !== 'completed' || !ct.validation?.passed) {
    return 'codegen blocked: contract must be completed with validation.passed';
  }
  const ha = ct.outputs?.human_approval?.status;
  if (ha !== 'approved' && ha !== 'not_required') {
    return `codegen blocked: contract.outputs.human_approval.status must be approved|not_required (got ${ha})`;
  }
  const arts = ct.outputs?.artifacts;
  if (!Array.isArray(arts) || arts.length === 0) {
    return 'codegen blocked: contract.outputs.artifacts[] missing';
  }
  return null;
}

module.exports = { assertCodegenGates };

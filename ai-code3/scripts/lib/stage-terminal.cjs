'use strict';

const stagesIo = require('./stages-io.cjs');

/**
 * 将阶段写入终态，满足 docs/spec/code3.md §4.3（不得长期滞留 running 无 completed_at/终态）。
 * @param {string} projectRoot
 * @param {object} doc
 * @param {string} stageKey
 * @param {'failed'|'blocked'} status
 * @param {{ summary?: string, validationExtras?: object }} extra
 */
function writeTerminal(projectRoot, doc, stageKey, status, extra = {}) {
  const now = new Date().toISOString();
  const st = doc.stages?.[stageKey] || {};
  const next = stagesIo.updateStage(doc, stageKey, {
    status,
    completed_at: now,
    validation: {
      ...st.validation,
      passed: false,
      summary: extra.summary || `${stageKey} ${status}`,
      ...extra.validationExtras,
    },
    outputs: {
      ...st.outputs,
      timed_out: extra.timedOut ?? st.outputs?.timed_out ?? false,
      timeout_reason: extra.timeoutReason ?? st.outputs?.timeout_reason ?? null,
    },
  });
  stagesIo.writeStagesSync(projectRoot, next);
  return next;
}

module.exports = { writeTerminal };

'use strict';

const fs = require('fs');
const path = require('path');
const { stagesPath, configJsonPath } = require('./lib/paths.cjs');
const { readStages } = require('./lib/stages-io.cjs');
const { loadDevConfig } = require('./lib/parse-ui-scenarios.cjs');

function runPreflight(projectRoot, { requireUiE2e } = {}) {
  const cfgPath = configJsonPath(projectRoot);
  if (!fs.existsSync(cfgPath)) {
    return { ok: false, message: '缺少 docs/config.dev.json' };
  }
  const stPath = stagesPath(projectRoot);
  if (!fs.existsSync(stPath)) {
    return { ok: false, message: '缺少 .pipeline/stages.json' };
  }
  const config = loadDevConfig(projectRoot);
  const ui = config.ui_e2e || {};
  if (!ui.enabled) {
    if (requireUiE2e) {
      return { ok: false, message: 'ui_e2e.enabled=false 但传入了 --require-ui-e2e' };
    }
    return { ok: true, config, skip: true, skipReason: 'ui_e2e.enabled=false' };
  }

  const doc = readStages(stPath);
  const smoke = doc.stages?.smoke;
  const requireSmoke = ui.require_smoke_passed !== false;
  if (requireSmoke) {
    if (!smoke || smoke.status !== 'completed' || !smoke.validation?.passed) {
      return { ok: false, message: '前置 smoke 未完成或未通过（ui_e2e.require_smoke_passed）' };
    }
  }

  const merge = doc.stages?.merge_push;
  if (!merge || merge.status !== 'completed') {
    return { ok: false, message: '前置 merge_push 未完成' };
  }

  const build = doc.stages?.build;
  const mobileArt = (build?.outputs?.artifacts || []).find((a) => a.client_target === 'mobile');
  if ((ui.mobile?.sub_platforms || []).length && (!build || build.status !== 'completed')) {
    return { ok: false, message: 'mobile ui_e2e 需要 stages.build（mobile）已完成' };
  }
  if (mobileArt && mobileArt.status && !['completed', 'success'].includes(mobileArt.status)) {
    return { ok: false, message: 'stages.build mobile 产物未 completed' };
  }

  return { ok: true, config, skip: false };
}

module.exports = { runPreflight };

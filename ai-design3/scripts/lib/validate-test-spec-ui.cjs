'use strict';

const YAML = require('yaml');

const WEB_TARGETS = new Set(['website', 'admin']);
const MOBILE_PLATFORMS = new Set(['android', 'ios']);
const WEB_PLATFORMS = new Set(['web']);
const ALLOWED_ACTIONS = new Set([
  'navigate',
  'click',
  'fill',
  'press_key',
  'wait',
  'snapshot',
  'scroll',
]);
const ALLOWED_EXPECT = new Set(['url_contains', 'text_present', 'element_present', 'status_code']);

/**
 * @param {unknown} doc parsed YAML/JSON
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateUiScenariosDocument(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return { ok: true, errors: [] };
  }
  const scenarios = doc.ui_scenarios;
  if (scenarios == null) return { ok: true, errors: [] };
  if (!Array.isArray(scenarios)) {
    return { ok: false, errors: ['ui_scenarios must be an array'] };
  }
  const seenIds = new Set();
  scenarios.forEach((sc, i) => {
    const prefix = `ui_scenarios[${i}]`;
    if (!sc || typeof sc !== 'object') {
      errors.push(`${prefix}: must be an object`);
      return;
    }
    const id = String(sc.id || '').trim();
    if (!id) errors.push(`${prefix}: missing id`);
    else if (seenIds.has(id)) errors.push(`${prefix}: duplicate id ${id}`);
    else seenIds.add(id);

    const ct = String(sc.client_target || '').trim();
    if (!ct) errors.push(`${prefix}: missing client_target`);

    const platform = String(sc.platform || '').trim().toLowerCase();
    if (!platform) errors.push(`${prefix}: missing platform`);
    else if (!WEB_PLATFORMS.has(platform) && !MOBILE_PLATFORMS.has(platform)) {
      errors.push(`${prefix}: platform must be web|android|ios`);
    }
    if (platform === 'web' && ct && !WEB_TARGETS.has(ct)) {
      errors.push(`${prefix}: web platform requires client_target website|admin`);
    }
    if ((platform === 'android' || platform === 'ios') && ct && ct !== 'mobile') {
      errors.push(`${prefix}: android|ios platform requires client_target mobile`);
    }

    if (!Array.isArray(sc.steps) || sc.steps.length < 1) {
      errors.push(`${prefix}: steps must be a non-empty array`);
    } else {
      sc.steps.forEach((step, si) => {
        const act = String(step?.action || '').trim().toLowerCase();
        if (!ALLOWED_ACTIONS.has(act)) {
          errors.push(`${prefix}.steps[${si}]: invalid action ${act}`);
        }
      });
    }

    if (!Array.isArray(sc.expect) || sc.expect.length < 1) {
      errors.push(`${prefix}: expect must be a non-empty array`);
    } else {
      sc.expect.forEach((ex, ei) => {
        const t = String(ex?.type || '').trim().toLowerCase();
        if (!ALLOWED_EXPECT.has(t)) {
          errors.push(`${prefix}.expect[${ei}]: invalid type ${t}`);
        }
      });
    }
  });

  const levels = doc.required_test_levels;
  if (Array.isArray(levels)) {
    const hasUi = levels.some((l) => String(l).trim().toLowerCase() === 'ui_e2e');
    if (hasUi && scenarios.length === 0) {
      errors.push('required_test_levels includes ui_e2e but ui_scenarios is empty');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {string} absPath
 * @param {string} prefix feature label for messages
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateTestSpecUiScenariosFile(absPath, prefix) {
  let raw;
  try {
    raw = require('fs').readFileSync(absPath, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`${prefix} read failed: ${e.message}`] };
  }
  if (!raw.trim()) return { ok: true, errors: [] };

  const ext = absPath.toLowerCase();
  let doc;
  if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
    try {
      doc = YAML.parse(raw);
    } catch (e) {
      return { ok: false, errors: [`${prefix} invalid YAML: ${e.message}`] };
    }
  } else if (ext.endsWith('.json')) {
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: [`${prefix} invalid JSON: ${e.message}`] };
    }
  } else {
    return { ok: true, errors: [] };
  }
  const r = validateUiScenariosDocument(doc);
  if (!r.ok) {
    return { ok: false, errors: r.errors.map((e) => `${prefix} ${e}`) };
  }
  return r;
}

module.exports = {
  validateUiScenariosDocument,
  validateTestSpecUiScenariosFile,
};

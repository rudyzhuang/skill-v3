'use strict';

/**
 * prd3.md §7.2：相对模板对现有 config 做 **additive** 补齐（仅补缺失键，不覆盖已有值）。
 * 仅处理「双方均为非 null 的 plain object」；数组与标量不递归合并。
 */

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * @param {unknown} target
 * @param {unknown} template
 */
function fillMissingFromTemplate(target, template) {
  const base =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? deepClone(target)
      : {};
  fillInto(base, template);
  return base;
}

/**
 * @param {Record<string, unknown>} a
 * @param {unknown} t
 */
function fillInto(a, t) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return;
  for (const k of Object.keys(t)) {
    if (!(k in a)) {
      a[k] = deepClone(t[k]);
    } else if (
      typeof a[k] === 'object' &&
      a[k] !== null &&
      !Array.isArray(a[k]) &&
      typeof t[k] === 'object' &&
      t[k] !== null &&
      !Array.isArray(t[k])
    ) {
      fillInto(/** @type {Record<string, unknown>} */ (a[k]), t[k]);
    }
  }
}

/**
 * @param {unknown} target
 * @param {unknown} template
 */
function wouldFillChange(target, template) {
  try {
    const filled = fillMissingFromTemplate(target, template);
    return JSON.stringify(filled) !== JSON.stringify(target);
  } catch {
    return true;
  }
}

module.exports = { fillMissingFromTemplate, wouldFillChange };

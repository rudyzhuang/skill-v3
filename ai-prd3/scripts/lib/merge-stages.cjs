'use strict';

/**
 * Deep-merge plain objects; arrays and scalars from overlay replace base.
 * @param {unknown} base
 * @param {unknown} overlay
 */
function deepMerge(base, overlay) {
  if (overlay === undefined) return base;
  if (overlay === null) return null;
  if (Array.isArray(overlay)) return overlay.slice();
  if (typeof overlay !== 'object') return overlay;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    const out = {};
    for (const k of Object.keys(overlay)) {
      out[k] = deepMerge(undefined, overlay[k]);
    }
    return out;
  }
  const out = { ...base };
  for (const k of Object.keys(overlay)) {
    out[k] = deepMerge(base[k], overlay[k]);
  }
  return out;
}

module.exports = { deepMerge };

'use strict';

/**
 * @param {unknown} value
 * @param {string[]} patterns
 * @param {string} [prefix]
 * @returns {string[]}
 */
function collectForbiddenKeyViolations(value, patterns, prefix = '') {
  const violations = [];
  if (value === null || value === undefined) return violations;
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      violations.push(...collectForbiddenKeyViolations(v, patterns, `${prefix}[${i}]`));
    });
    return violations;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      const kl = k.toLowerCase();
      for (const pat of patterns) {
        if (kl.includes(pat.toLowerCase())) {
          violations.push(`${p} (matches forbidden pattern "${pat}")`);
        }
      }
      violations.push(...collectForbiddenKeyViolations(value[k], patterns, p));
    }
  }
  return violations;
}

module.exports = { collectForbiddenKeyViolations };

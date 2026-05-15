'use strict';

/**
 * @param {unknown} value
 * @param {string[]} patterns lowercased substrings to match against key paths
 * @param {string} [prefix]
 * @returns {string[]} violations "path:key" messages
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
      // security.* 为模板元数据键名（如 secret_env_path），不参与 forbidden 子串匹配（publish3 §7.1.5 防误报）
      const underSecurity = p === 'security' || p.startsWith('security.');
      if (!underSecurity) {
        for (const pat of patterns) {
          if (kl.includes(pat.toLowerCase())) {
            violations.push(`${p} (matches forbidden pattern "${pat}")`);
          }
        }
      }
      violations.push(...collectForbiddenKeyViolations(value[k], patterns, p));
    }
  }
  return violations;
}

module.exports = { collectForbiddenKeyViolations };

'use strict';

/**
 * 确定性 expect[] 判定（脚本侧，不依赖 Agent）
 */

/**
 * @param {object} scenario
 * @param {{ lastUrl: string, body: string, pageText?: string }} state
 */
function evaluateWebExpects(scenario, state) {
  const expects = scenario.expect || [];
  const lastUrl = state.lastUrl || '';
  const haystack = `${state.pageText || ''}\n${state.body || ''}\n${lastUrl}`;

  for (const ex of expects) {
    const type = String(ex.type || '').toLowerCase();
    const value = String(ex.value || '');
    const hint = String(ex.selector_hint || '');

    if (type === 'text_present') {
      if (!value || !haystack.includes(value)) {
        return {
          passed: false,
          error: `expect text_present「${value}」未找到`,
          expected: value,
          actual: haystack.slice(0, 200),
        };
      }
    } else if (type === 'text_absent') {
      if (value && haystack.includes(value)) {
        return {
          passed: false,
          error: `expect text_absent「${value}」仍存在`,
          expected: `不含 ${value}`,
          actual: '仍匹配',
        };
      }
    } else if (type === 'url_contains') {
      if (!value || !lastUrl.includes(value)) {
        return {
          passed: false,
          error: `expect url_contains「${value}」未满足`,
          expected: value,
          actual: lastUrl || '(empty)',
        };
      }
    } else if (type === 'element_present') {
      if (!hint || !haystack.includes(hint)) {
        return {
          passed: false,
          error: `expect element_present「${hint}」未找到`,
          expected: hint,
          actual: haystack.slice(0, 200),
        };
      }
    } else if (type === 'element_absent') {
      if (hint && haystack.includes(hint)) {
        return {
          passed: false,
          error: `expect element_absent「${hint}」仍存在`,
          expected: `不含 ${hint}`,
          actual: '仍匹配',
        };
      }
    } else {
      return {
        passed: false,
        error: `未知 expect 类型: ${type}`,
        expected: type,
        actual: null,
      };
    }
  }

  return { passed: true, error: '', expected: null, actual: null };
}

function scenarioNeedsInteractiveSteps(scenario) {
  const interactive = new Set(['click', 'type', 'select', 'hover', 'snapshot', 'back']);
  return (scenario.steps || []).some((s) => interactive.has(String(s.action || '').toLowerCase()));
}

module.exports = {
  evaluateWebExpects,
  scenarioNeedsInteractiveSteps,
};

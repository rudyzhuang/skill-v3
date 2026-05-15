'use strict';

const ALLOWED = new Set([
  'website',
  'admin',
  'backend',
  'miniapp',
  'mobile',
  'desktop',
  'agent',
]);

const H2_CN = /^##\s+端\s*\(Client Targets\)\s*$/;
const H2_EN = /^##\s+Client Targets\s*$/;

/**
 * @param {string} line
 */
function listItemSlug(line) {
  const m = line.match(/^\s*-\s+(.+)$/);
  if (!m) return null;
  const rest = m[1].trim();
  const code = rest.match(/`([^`]+)`/);
  if (code) return code[1].trim();
  return rest.replace(/^-\s*/, '').trim();
}

/**
 * @param {string} content UTF-8 prd-spec.md 全文
 * @returns {{ ok: true, slugs: string[], legacy_yaml?: string } | { ok: false, error: string }}
 */
function parseClientTargets(content) {
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (H2_CN.test(lines[i]) || H2_EN.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    return { ok: false, error: 'missing_client_targets_heading' };
  }

  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      return { ok: false, error: 'no_client_targets_list' };
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (/^\s*-\s+/.test(line)) break;
    i++;
  }

  if (i >= lines.length) {
    return { ok: false, error: 'no_client_targets_list' };
  }

  const slugs = [];
  const seen = new Set();
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    if (/^\s*$/.test(line)) continue;
    if (!/^\s*-\s+/.test(line)) break;
    const s = listItemSlug(line);
    if (!s) return { ok: false, error: 'invalid_list_item' };
    if (!ALLOWED.has(s)) return { ok: false, error: `disallowed_slug:${s}` };
    if (!seen.has(s)) {
      seen.add(s);
      slugs.push(s);
    }
  }

  if (slugs.length === 0) {
    return { ok: false, error: 'empty_client_targets_list' };
  }
  return { ok: true, slugs };
}

/**
 * 可选：YAML 围栏 legacy（根键 client_targets）
 * @param {string} content
 */
function tryLegacyYaml(content) {
  const fence = content.match(/```(?:ya?ml)\s*\n([\s\S]*?)```/i);
  if (!fence) return null;
  const body = fence[1];
  if (!/^client_targets\s*:/m.test(body)) return null;
  try {
    // 极简提取：client_targets 下的列表项（不引入 yaml 依赖）
    const m = body.match(/client_targets\s*:\s*\n((?:\s*-\s*.+\n?)+)/);
    if (!m) return null;
    const lines = m[1].split('\n').filter((l) => /^\s*-\s+/.test(l));
    const slugs = [];
    const seen = new Set();
    for (const l of lines) {
      const s = listItemSlug(l);
      if (s && ALLOWED.has(s) && !seen.has(s)) {
        seen.add(s);
        slugs.push(s);
      }
    }
    return slugs.length ? slugs : null;
  } catch {
    return null;
  }
}

/**
 * 当前 prd-spec 是否走 §6.4 YAML legacy（无 §6.1 标题且 YAML 声明与 stages.declared 一致）。
 * @param {string} content
 * @param {string[]} declaredSlugs
 */
function specUsesLegacyYamlClientTargets(content, declaredSlugs) {
  const d = parseClientTargets(content);
  if (d.ok) return false;
  if (d.error !== 'missing_client_targets_heading') return false;
  const ly = tryLegacyYaml(content);
  if (!ly || !ly.length) return false;
  const a = [...declaredSlugs].sort().join(',');
  const b = [...ly].sort().join(',');
  return a === b;
}

module.exports = { parseClientTargets, tryLegacyYaml, specUsesLegacyYamlClientTargets, ALLOWED };

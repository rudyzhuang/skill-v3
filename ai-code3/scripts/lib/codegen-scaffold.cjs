'use strict';

const fs = require('fs');
const path = require('path');

/** 仅允许在 worktree 根下创建相对路径，防目录穿越 */
function safeJoin(worktreeRoot, rel) {
  const r = String(rel || '').replace(/^\//, '');
  if (!r || r.includes('..')) return null;
  const full = path.resolve(path.join(worktreeRoot, r));
  const root = path.resolve(worktreeRoot);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  return full;
}

/**
 * §7.6 / §7.9：从 design_snapshot 的 file_plan 创建空目录/空文件占位（不覆盖已有非空文件）。
 * @param {string} worktreePath
 * @param {string|null} designSnapshotAbs
 */
function applyScaffold(worktreePath, designSnapshotAbs) {
  const warnings = [];
  if (!designSnapshotAbs || !fs.existsSync(designSnapshotAbs)) {
    return { touched: 0, warnings };
  }
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(designSnapshotAbs, 'utf8'));
  } catch (e) {
    warnings.push(`design_snapshot parse: ${e.message}`);
    return { touched: 0, warnings };
  }
  const fp = snap.file_plan || {};
  const news = Array.isArray(fp.new_files) ? fp.new_files : [];
  const mods = Array.isArray(fp.modify_files) ? fp.modify_files : [];
  let touched = 0;
  for (const rel of [...news, ...mods]) {
    const full = safeJoin(worktreePath, rel);
    if (!full) {
      warnings.push(`skip unsafe path: ${rel}`);
      continue;
    }
    if (fs.existsSync(full)) continue;
    if (rel.endsWith('/') || rel.endsWith(path.sep)) {
      fs.mkdirSync(full, { recursive: true });
      touched += 1;
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '', 'utf8');
      touched += 1;
    }
  }
  return { touched, warnings };
}

module.exports = { applyScaffold, safeJoin };

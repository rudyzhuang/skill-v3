'use strict';

/**
 * 确定性「风格扫描」：遍历业务仓源码树片段，产出供设计/契约阶段引用的 JSON 快照。
 * 与 ai-design2 SKILL 中 P1「扫描 src/ 风格快照」对齐；结果落盘便于 V3 Git 评审（非仅内存）。
 */

const fs = require('fs');
const path = require('path');

const MAX_FILES_TOTAL = 5000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_IMPORT_LINES = 40;

function pathExistsDir(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function collectCandidateRoots(projectRoot, clientTarget) {
  const ct = String(clientTarget || '').trim() || 'website';
  const rels = [
    path.join('src', ct),
    path.join('apps', ct),
    path.join('packages', ct),
    path.join('src', 'shared'),
    'src',
  ];
  const out = [];
  const seen = new Set();
  for (const rel of rels) {
    const abs = path.join(projectRoot, rel);
    if (!pathExistsDir(abs)) continue;
    const key = rel.split(path.sep).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rel: key, abs });
  }
  return out;
}

function walkFiles(absRoot, maxFiles) {
  const files = [];
  if (maxFiles <= 0) return files;
  const stack = [absRoot];
  while (stack.length && files.length < maxFiles) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) break;
      const name = ent.name;
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build' || name === '.next') {
        continue;
      }
      const full = path.join(cur, name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function extOf(filePath) {
  const m = String(filePath).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '(noext)';
}

function readHead(abs, maxBytes) {
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(maxBytes, MAX_FILE_BYTES));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.slice(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function extractImports(head) {
  const lines = head.split(/\r?\n/);
  const imports = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('import ') || t.startsWith('export ')) {
      imports.push(t.length > 200 ? `${t.slice(0, 197)}...` : t);
      if (imports.length >= MAX_IMPORT_LINES) break;
    }
  }
  return imports;
}

function uniqStrings(arr) {
  const s = new Set();
  for (const x of arr || []) {
    if (x) s.add(String(x));
  }
  return [...s];
}

/**
 * @param {{ projectRoot: string, clientTarget: string, featureId: string, dryRun?: boolean }} opts
 * @returns {{ ok: boolean, relOut: string, payload: object, reason?: string }}
 */
function runStyleScan(opts) {
  const { projectRoot, clientTarget, featureId, dryRun } = opts;
  const roots = collectCandidateRoots(projectRoot, clientTarget);
  const extCounts = {};
  let total = 0;
  const sampleImports = [];
  const perRoot = [];

  for (const { rel, abs } of roots) {
    const budget = MAX_FILES_TOTAL - total;
    const files = walkFiles(abs, budget);
    let n = 0;
    for (const f of files) {
      if (total >= MAX_FILES_TOTAL) break;
      total++;
      n++;
      const ext = extOf(f);
      extCounts[ext] = (extCounts[ext] || 0) + 1;
      if (sampleImports.length < MAX_IMPORT_LINES && /\.(tsx?|jsx?|mts|cts)$/.test(f)) {
        const head = readHead(f, 8000);
        for (const line of extractImports(head)) {
          if (sampleImports.length >= MAX_IMPORT_LINES) break;
          sampleImports.push(line);
        }
      }
    }
    perRoot.push({ root: rel, files_seen: n });
  }

  const configProbe = [
    'package.json',
    'tsconfig.json',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc.cjs',
    '.eslintrc.js',
    '.eslintrc.json',
    'prettier.config.cjs',
    '.prettierrc',
    'tailwind.config.ts',
    'tailwind.config.js',
    'vite.config.ts',
    'next.config.js',
    'next.config.mjs',
    'biome.json',
    'biome.jsonc',
  ];
  const configPresent = [];
  for (const rel of configProbe) {
    if (fs.existsSync(path.join(projectRoot, rel))) {
      configPresent.push(rel.split(path.sep).join('/'));
    }
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const payload = {
    _schema: { name: 'skill-v3-style-scan', version: 1 },
    feature_id: String(featureId || ''),
    client_target: String(clientTarget || ''),
    scanned_at: now,
    scan_roots_attempted: roots.map((r) => r.rel),
    per_root: perRoot,
    total_files_scanned: total,
    extension_counts: extCounts,
    config_files_present: configPresent,
    import_samples: uniqStrings(sampleImports).slice(0, MAX_IMPORT_LINES),
    notes:
      roots.length === 0
        ? 'no_existing_scan_roots: create src/<client_target> or src/ to populate hints'
        : total === 0
          ? 'roots_exist_but_zero_files_under_limits'
          : '',
  };

  const relOut = path.join('docs', 'designs', `${featureId}.style-scan.json`);
  const absOut = path.join(projectRoot, relOut);
  if (dryRun) {
    return { ok: true, relOut: relOut.split(path.sep).join('/'), payload };
  }
  try {
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, relOut: relOut.split(path.sep).join('/'), payload, reason: e.message };
  }
  return { ok: true, relOut: relOut.split(path.sep).join('/'), payload };
}

module.exports = {
  runStyleScan,
  collectCandidateRoots,
};

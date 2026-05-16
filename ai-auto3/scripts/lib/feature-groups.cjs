'use strict';

const fs = require('fs');
const path = require('path');

/**
 * docs/spec/auto3.md §5.7 — feature group 划分、组间 DAG 层、P0～P3（方案 A：真源为 contract.outputs.artifacts[].design_snapshot JSON）
 */

function getFeatureGroupMaxParallel(cfg) {
  const v = cfg?.pipeline?.autorun?.feature_group_max_parallel;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return Math.floor(v);
  return 3;
}

function resolveProjectPath(projectRoot, p) {
  if (p == null || typeof p !== 'string') return null;
  const s = p.trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  return path.join(projectRoot, s);
}

function readJsonFile(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {Set<string>} featureSet */
function buildArtifactIndex(doc, featureSet) {
  const arts = doc.stages?.contract?.outputs?.artifacts || [];
  const byId = new Map();
  for (const a of arts) {
    const fid = String(a?.feature_id || '').trim();
    if (!fid || !featureSet.has(fid)) continue;
    if (!byId.has(fid)) byId.set(fid, a);
  }
  return byId;
}

function collectFeatureTargetsFromDocs(projectRoot, allowedSlugs) {
  const out = new Map();
  const docsDir = path.join(projectRoot, 'docs');
  if (!fs.existsSync(docsDir)) return out;
  for (const slug of allowedSlugs) {
    const fp = path.join(docsDir, slug, 'feature_list.md');
    if (!fs.existsSync(fp)) continue;
    const raw = fs.readFileSync(fp, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('|')) continue;
      if (/^\|\s*Feature ID\s*\|/i.test(t)) continue;
      if (/^\|\s*[-: ]+\|/.test(t)) continue;
      const cells = t
        .split('|')
        .slice(1, -1)
        .map((v) => v.trim());
      if (!cells.length) continue;
      const fid = cells[0];
      if (!/^[A-Za-z0-9_.-]+$/.test(fid)) continue;
      if (!out.has(fid)) out.set(fid, new Set());
      out.get(fid).add(slug);
    }
  }
  return out;
}

/**
 * @param {string} featureId
 * @param {object} snap
 * @param {Set<string>} allowedSlugs
 * @param {Map<string, Set<string>>} fallbackTargets
 * @param {string[]} outWarnings
 */
function computeTier(featureId, snap, allowedSlugs, fallbackTargets, outWarnings) {
  if (snap && snap.cross_client === true) return 0;

  let raw = [];
  if (Array.isArray(snap?.client_targets)) raw = snap.client_targets.map((x) => String(x).trim()).filter(Boolean);
  else if (snap?.client_targets != null) {
    outWarnings.push(`${featureId}: client_targets 非数组，按元数据缺失处理`);
  }

  const valid = [];
  for (const slug of raw) {
    if (allowedSlugs.has(slug)) valid.push(slug);
    else if (slug) outWarnings.push(`${featureId}: client_targets 非法 slug 已剔除: ${slug}`);
  }
  const uniq = [...new Set(valid)];
  if (uniq.length === 0) {
    const fallback = [...(fallbackTargets.get(featureId) || new Set())].filter((s) => allowedSlugs.has(s));
    if (fallback.length > 0) {
      if (fallback.length >= 2) return 0;
      if (fallback[0] === 'backend') return 1;
      if (fallback[0] === 'admin') return 2;
      return 3;
    }
    outWarnings.push(`${featureId}: 无有效 client_targets 且 cross_client 不为 true — 按 P3`);
    return 3;
  }
  if (uniq.length >= 2) return 0;
  const one = uniq[0];
  if (one === 'backend') return 1;
  if (one === 'admin') return 2;
  return 3;
}

/**
 * @param {string[]} featureIds
 * @param {object} doc stages.json
 * @param {string} projectRoot
 * @returns {{ meta: Map<string, { depends_on: string[], tier: number }>, warnings: string[] }}
 */
function collectFeatureMeta(featureIds, doc, projectRoot) {
  const warnings = [];
  const featureSet = new Set(featureIds);
  const allowedList = doc.client_targets?.allowed_values || [
    'website',
    'admin',
    'backend',
    'miniapp',
    'mobile',
    'desktop',
    'agent',
  ];
  const allowedSlugs = new Set((Array.isArray(allowedList) ? allowedList : []).map((s) => String(s).trim()));
  const fallbackTargets = collectFeatureTargetsFromDocs(projectRoot, allowedSlugs);

  const byArt = buildArtifactIndex(doc, featureSet);
  /** @type {Map<string, { depends_on: string[], tier: number }>} */
  const meta = new Map();

  for (const fid of featureIds) {
    const art = byArt.get(fid);
    if (!art) {
      warnings.push(`${fid}: contract.outputs.artifacts 无匹配 feature_id — depends 孤立、端型 P3`);
      meta.set(fid, { depends_on: [], tier: 3 });
      continue;
    }
    const snapPath = resolveProjectPath(projectRoot, art.design_snapshot);
    if (!snapPath || !fs.existsSync(snapPath)) {
      warnings.push(`${fid}: design_snapshot 不可读 (${art.design_snapshot}) — depends 孤立、端型 P3`);
      meta.set(fid, { depends_on: [], tier: 3 });
      continue;
    }
    const snap = readJsonFile(snapPath);
    if (!snap || typeof snap !== 'object') {
      warnings.push(`${fid}: design_snapshot JSON 解析失败 — depends 孤立、端型 P3`);
      meta.set(fid, { depends_on: [], tier: 3 });
      continue;
    }

    let deps = [];
    if (Array.isArray(snap.depends_on)) {
      deps = snap.depends_on.map((x) => String(x).trim()).filter(Boolean).filter((x) => featureSet.has(x));
      const dropped = snap.depends_on
        .map((x) => String(x).trim())
        .filter(Boolean)
        .filter((x) => !featureSet.has(x));
      for (const d of dropped) warnings.push(`${fid}: depends_on 引用本期集合外 id，已忽略: ${d}`);
    } else if (snap.depends_on != null) {
      warnings.push(`${fid}: depends_on 非数组 — 按无依赖边处理`);
    }

    if (snap.cross_client === true && Array.isArray(snap.client_targets) && snap.client_targets.length === 1) {
      warnings.push(`${fid}: cross_client=true 与单元素 client_targets 并存 — 仍定 P0，建议人工核对`);
    }

    const tier = computeTier(fid, snap, allowedSlugs, fallbackTargets, warnings);
    meta.set(fid, { depends_on: deps, tier });
  }

  return { meta, warnings };
}

class UnionFind {
  constructor(ids) {
    /** @type {Record<string, string>} */
    this.p = {};
    for (const id of ids) this.p[id] = id;
  }
  find(x) {
    if (this.p[x] !== x) this.p[x] = this.find(this.p[x]);
    return this.p[x];
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[rb] = ra;
  }
}

function groupsFromUF(featureIds, uf) {
  const buckets = new Map();
  for (const id of featureIds) {
    const r = uf.find(id);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(id);
  }
  for (const arr of buckets.values()) arr.sort();
  return [...buckets.values()].sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

/**
 * @param {string[][]} groups
 * @param {Map<string, { depends_on: string[] }>} meta
 */
function buildGroupGraph(groups, meta) {
  const n = groups.length;
  /** @type {Map<string, number>} */
  const fidToG = new Map();
  for (let gi = 0; gi < n; gi++) {
    for (const f of groups[gi]) fidToG.set(f, gi);
  }

  /** @type {Set<number>[]} */
  const preds = Array.from({ length: n }, () => new Set());

  for (let gi = 0; gi < n; gi++) {
    for (const f of groups[gi]) {
      for (const v of meta.get(f)?.depends_on || []) {
        const hj = fidToG.get(v);
        if (hj == null || hj === gi) continue;
        preds[gi].add(hj);
      }
    }
  }

  /** @type {number[][]} */
  const adj = Array.from({ length: n }, () => []);
  const indeg = Array(n).fill(0);
  for (let gi = 0; gi < n; gi++) {
    for (const hj of preds[gi]) {
      adj[hj].push(gi);
      indeg[gi]++;
    }
  }
  return { adj, indeg };
}

/**
 * @returns {number[][]} 每层为组下标数组；若无法覆盖全部组（例如组间环），返回 null
 */
function topoLayersOrNull(adj, indeg0) {
  const n = adj.length;
  if (n === 0) return [];
  const indeg = indeg0.slice();
  /** @type {number[][]} */
  const layers = [];
  let frontier = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) frontier.push(i);
  while (frontier.length) {
    layers.push(frontier.slice());
    const next = [];
    for (const u of frontier) {
      for (const v of adj[u]) {
        indeg[v]--;
        if (indeg[v] === 0) next.push(v);
      }
    }
    frontier = next;
  }
  const seen = layers.reduce((a, L) => a + L.length, 0);
  if (seen !== n) return null;
  return layers;
}

function groupSortKey(members) {
  return [...members].sort().join('|');
}

function groupMinTier(members, meta) {
  return Math.min(...members.map((id) => meta.get(id)?.tier ?? 3));
}

/**
 * @param {string[]} featureIds
 * @param {object} doc
 * @param {string} projectRoot
 */
function planFeatureGroupWaves(featureIds, doc, projectRoot) {
  const warnings = [];
  const { meta, warnings: w2 } = collectFeatureMeta(featureIds, doc, projectRoot);
  warnings.push(...w2);

  if (featureIds.length === 0) {
    return { layers: [], warnings, meta };
  }

  const uf = new UnionFind(featureIds);
  const idSet = new Set(featureIds);
  for (const id of featureIds) {
    for (const v of meta.get(id)?.depends_on || []) {
      if (idSet.has(v)) uf.union(id, v);
    }
  }

  const groups = groupsFromUF(featureIds, uf);
  const { adj, indeg } = buildGroupGraph(groups, meta);
  let layersIdx = topoLayersOrNull(adj, indeg);

  if (!layersIdx) {
    warnings.push(
      `feature-groups: 组间 DAG 无法拓扑（可能存在环或内部错误，groups=${groups.length}）— 退化为单组串行（全部 feature 一次 ai-code3）`
    );
    return { layers: [[ [...featureIds].sort() ]], warnings, meta };
  }

  /** @type {string[][][]} */
  const layers = [];
  for (const layerIdx of layersIdx) {
    const gs = layerIdx.map((i) => groups[i]);
    gs.sort((a, b) => {
      const ta = groupMinTier(a, meta);
      const tb = groupMinTier(b, meta);
      if (ta !== tb) return ta - tb;
      return groupSortKey(a).localeCompare(groupSortKey(b));
    });
    layers.push(gs);
  }

  return { layers, warnings, meta };
}

module.exports = {
  getFeatureGroupMaxParallel,
  planFeatureGroupWaves,
  collectFeatureMeta,
  groupSortKey,
};

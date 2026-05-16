'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  stagesJsonPath,
  configDevPath,
  configReleasePath,
  configEnvPath,
  pipelineLockPath,
} = require('./paths.cjs');
const { scanJsonForForbidden, loadJson } = require('./forbidden-scan.cjs');

const SCHEMA_MAX = 1;

function collectPhasePlanFeatureIds(doc) {
  const phases = doc.stages?.prd_review?.review?.phase_plan || [];
  const out = [];
  const seen = new Set();
  for (const p of phases) {
    for (const id of p.feature_ids || []) {
      const s = String(id).trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function collectDeferredFeatureIds(doc) {
  const arr = doc.stages?.prd_review?.review?.deferred_features || [];
  const out = [];
  const seen = new Set();
  for (const row of arr) {
    if (typeof row === 'string') {
      const id = row.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      continue;
    }
    if (row && typeof row === 'object') {
      const id = String(row.feature_id || row.id || '').trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

function collectFeatureUniverseFromLists(projectRoot, declaredTargets) {
  const out = [];
  const seen = new Set();
  const docs = path.join(projectRoot, 'docs');
  for (const slug of declaredTargets || []) {
    const fl = path.join(docs, slug, 'feature_list.md');
    if (!fs.existsSync(fl)) continue;
    const raw = fs.readFileSync(fl, 'utf8');
    let inFeaturesSection = false;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (/^##\s+Features\s*$/i.test(t)) {
        inFeaturesSection = true;
        continue;
      }
      // Stop once we leave "## Features" and enter the next section.
      if (inFeaturesSection && /^##\s+/.test(t)) {
        inFeaturesSection = false;
      }
      if (!inFeaturesSection) continue;
      if (!t.startsWith('|')) continue;
      if (/^\|\s*Feature ID\s*\|/i.test(t)) continue;
      if (/^\|\s*[-: ]+\|/.test(t)) continue;
      const cells = t
        .split('|')
        .slice(1, -1)
        .map((v) => v.trim());
      if (!cells.length) continue;
      const id = cells[0];
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) continue;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

function parseFeaturesFilter(raw, allowedSet) {
  if (raw == null || raw === '') return null;
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = parts.filter((id) => !allowedSet.has(id));
  if (bad.length) {
    return { ok: false, message: `--features 含未在 prd_review.phase_plan 出现的 id: ${bad.join(', ')}` };
  }
  return { ok: true, ids: parts };
}

function assertSchema(doc, label) {
  const v = doc?._schema?.version;
  if (typeof v !== 'number' || v < 1 || v > SCHEMA_MAX) {
    return `${label}: 不支持的 _schema.version=${v}（本 skill 最大 ${SCHEMA_MAX}）`;
  }
  return null;
}

function gitLargeFiles(projectRoot, maxBytes) {
  const r = spawnSync('git', ['-C', projectRoot, 'status', '--porcelain'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: true, warnings: [] };
  const lines = String(r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const bad = [];
  for (const line of lines) {
    const rest = line.length >= 4 ? line.slice(3).trim() : line;
    const filePath = path.join(projectRoot, rest.split(/\s+/)[0] || '');
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const sz = fs.statSync(filePath).size;
        if (sz > maxBytes) bad.push({ path: rest, size: sz });
      }
    } catch {
      /* ignore */
    }
  }
  return { ok: bad.length === 0, bad };
}

function pipelineLockHeld(projectRoot) {
  const lp = pipelineLockPath(projectRoot);
  if (!fs.existsSync(lp)) return { held: false };
  try {
    const j = JSON.parse(fs.readFileSync(lp, 'utf8').trim());
    const pid = j.pid;
    if (typeof pid === 'number') {
      try {
        process.kill(pid, 0);
        return { held: true, path: lp, meta: j };
      } catch {
        return { held: false, stale: true, path: lp };
      }
    }
  } catch {
    return { held: false, stale: true, path: lp };
  }
  return { held: false };
}

/**
 * @param {string} projectRoot
 * @param {{ featuresFilter?: string | null }} opts
 * @returns {{ ok: boolean, message?: string, stages?: object, configDev?: object, featureIds?: string[] }}
 */
function runAutorunChecklist(projectRoot, opts = {}) {
  const stagesPath = stagesJsonPath(projectRoot);
  if (!fs.existsSync(stagesPath)) {
    return { ok: false, message: `缺少 ${path.relative(projectRoot, stagesPath)}` };
  }
  let doc;
  try {
    doc = loadJson(stagesPath);
  } catch (e) {
    return { ok: false, message: `stages.json 解析失败: ${e.message}` };
  }

  const es = assertSchema(doc, 'stages.json');
  if (es) return { ok: false, message: es };

  const prd = doc.stages?.prd;
  if (!prd || prd.status !== 'completed' || !prd.validation?.passed) {
    return { ok: false, message: 'checklist#1: stages.prd 须 status=completed 且 validation.passed=true' };
  }

  const prv = doc.stages?.prd_review;
  if (!prv || prv.status !== 'completed' || prv.validation?.passed !== true) {
    return { ok: false, message: 'checklist#2: stages.prd_review 须 completed 且 validation.passed=true' };
  }
  if (prv.outputs?.decision !== 'passed') {
    return { ok: false, message: 'checklist#2: prd_review.outputs.decision 须为 passed（conditional_passed 不放行）' };
  }

  const allIds = collectPhasePlanFeatureIds(doc);
  if (allIds.length === 0) {
    return { ok: false, message: 'checklist#2: prd_review.review.phase_plan[*].feature_ids 合并后不得为空' };
  }
  const deferredIds = collectDeferredFeatureIds(doc);
  const declaredTargets = doc.client_targets?.declared || doc.stages?.prd?.outputs?.client_targets || [];
  const universe = collectFeatureUniverseFromLists(projectRoot, declaredTargets);
  if (universe.length) {
    const covered = new Set([...allIds, ...deferredIds]);
    const uncovered = universe.filter((id) => !covered.has(id));
    if (uncovered.length) {
      return {
        ok: false,
        message: `checklist#2: feature_list 全集存在未进入 phase_plan/deferred 的特性: ${uncovered.join(', ')}`,
      };
    }
  }

  const allowed = new Set(allIds);
  let featureIds = allIds;
  if (opts.featuresFilter != null && String(opts.featuresFilter).trim() !== '') {
    const pf = parseFeaturesFilter(opts.featuresFilter, allowed);
    if (!pf.ok) return { ok: false, message: pf.message };
    featureIds = pf.ids;
    if (featureIds.length === 0) {
      return { ok: false, message: '--features 解析后为空' };
    }
  }

  const cdev = configDevPath(projectRoot);
  const crelease = configReleasePath(projectRoot);
  if (!fs.existsSync(cdev)) {
    return { ok: false, message: `缺少 ${path.relative(projectRoot, cdev)}` };
  }
  if (!fs.existsSync(crelease)) {
    return { ok: false, message: `缺少 ${path.relative(projectRoot, crelease)}` };
  }

  let devCfg;
  let relCfg;
  try {
    devCfg = loadJson(cdev);
    relCfg = loadJson(crelease);
  } catch (e) {
    return { ok: false, message: `config JSON 解析失败: ${e.message}` };
  }

  const d1 = assertSchema(devCfg, 'config.dev.json');
  if (d1) return { ok: false, message: d1 };
  const d2 = assertSchema(relCfg, 'config.release.json');
  if (d2) return { ok: false, message: d2 };

  const fgp = devCfg.pipeline?.autorun?.feature_group_max_parallel;
  if (
    fgp != null &&
    (typeof fgp !== 'number' || !Number.isFinite(fgp) || fgp < 1 || Math.floor(fgp) !== fgp)
  ) {
    return {
      ok: false,
      message: 'checklist: pipeline.autorun.feature_group_max_parallel 须为 >=1 的整数（见 auto3.md §5.7.4）',
    };
  }

  const patterns = (devCfg.security && devCfg.security.forbidden_json_key_patterns) || [];
  /** 扫描用副本：排除 security 内「模式定义」与易误伤 schema 键名，避免自匹配（checklist#5） */
  function configJsonForForbiddenScan(cfg) {
    const c = JSON.parse(JSON.stringify(cfg));
    if (c.security && typeof c.security === 'object') {
      delete c.security.forbidden_json_key_patterns;
      if (typeof c.security.secret_env_path === 'string') {
        delete c.security.secret_env_path;
      }
    }
    return c;
  }
  const badDev = scanJsonForForbidden(configJsonForForbiddenScan(devCfg), patterns);
  const badRel = scanJsonForForbidden(configJsonForForbiddenScan(relCfg), patterns);
  if (badDev.length || badRel.length) {
    const msg = [...badDev, ...badRel].map((h) => `${h.path}: ${h.detail}`).join('\n');
    return { ok: false, message: `checklist#5 forbidden 扫描命中:\n${msg}` };
  }

  const envPath = configEnvPath(projectRoot);
  if (!fs.existsSync(envPath)) {
    return { ok: false, message: `缺少 ${path.relative(projectRoot, envPath)}` };
  }

  const deployEnabled = !!(devCfg.deploy && devCfg.deploy.enabled);
  if (deployEnabled) {
    const envText = fs.readFileSync(envPath, 'utf8');
    const lines = envText.split('\n').filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l));
    const keys = new Set(
      lines.map((l) => {
        const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        return m ? m[1] : '';
      })
    );
    const provider = String(devCfg.deploy?.provider || 'manual').toLowerCase();
    const required = [];
    if (provider === 'cloudflare') {
      required.push('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID');
    }
    for (const k of required) {
      if (!keys.has(k)) {
        return { ok: false, message: `checklist#4: docs/config.env 缺少变量名行: ${k}（deploy.provider=${provider}）` };
      }
      const valLine = lines.find((l) => l.trim().startsWith(`${k}=`));
      const val = valLine ? valLine.split('=').slice(1).join('=').trim() : '';
      if (!val || val.startsWith('your_') || val === '""' || val === "''") {
        return { ok: false, message: `checklist#4: deploy.enabled=true 时 ${k} 值不得为空` };
      }
    }
  }

  const declared = new Set([
    ...(doc.client_targets?.declared || []),
    ...(doc.client_targets?.generated || []),
    ...(doc.stages?.prd?.outputs?.client_targets || []),
  ]);
  const services = devCfg.deploy?.services || [];
  if (!Array.isArray(services) || services.length === 0) {
    return { ok: false, message: 'checklist#3: config.dev.json.deploy.services[] 须为非空数组' };
  }
  for (const s of services) {
    const ct = s.client_target;
    if (!ct) return { ok: false, message: 'checklist#3: deploy.services[] 每项须含 client_target' };
    if (declared.size && !declared.has(ct)) {
      return {
        ok: false,
        message: `checklist#3: deploy.services[].client_target="${ct}" 未出现在 stages client_targets.declared/generated 或 prd.outputs.client_targets`,
      };
    }
  }
  if (!devCfg.deploy?.provider) {
    return { ok: false, message: 'checklist#3: config.dev.json.deploy.provider 不得为空' };
  }

  const lg = gitLargeFiles(projectRoot, 50 * 1024 * 1024);
  if (!lg.ok) {
    return {
      ok: false,
      message: `checklist#6: git 工作区存在 >50MB 未跟踪/已修改文件: ${lg.bad.map((b) => b.path).join(', ')}`,
    };
  }

  const lock = pipelineLockHeld(projectRoot);
  if (lock.held) {
    return {
      ok: false,
      message: `checklist#7: pipeline 锁被占用 ${lock.path} pid=${lock.meta?.pid} session=${lock.meta?.session_id}`,
    };
  }

  return { ok: true, stages: doc, configDev: devCfg, featureIds, gitWarnings: lg.warnings || [] };
}

module.exports = {
  runAutorunChecklist,
  collectPhasePlanFeatureIds,
  pipelineLockHeld,
  SCHEMA_MAX,
};

'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

function normalizeRoute(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+$/, '') || '/';
}

function extractApiOutlineRoutes(outline) {
  const routes = new Set();
  for (const row of outline || []) {
    if (!row || typeof row !== 'object') continue;
    const p = normalizeRoute(row.path || row.route || row.url);
    const m = String(row.method || 'GET')
      .trim()
      .toUpperCase();
    if (p) routes.add(`${m} ${p}`);
  }
  return routes;
}

function extractOpenApiRoutes(text) {
  const routes = new Set();
  let doc;
  try {
    doc = YAML.parse(text);
  } catch {
    return { routes, error: 'openapi_parse_failed' };
  }
  const paths = doc?.paths || {};
  for (const [p, methods] of Object.entries(paths)) {
    if (String(p).startsWith('x-')) continue;
    const normPath = normalizeRoute(p);
    for (const [method, def] of Object.entries(methods || {})) {
      if (String(method).startsWith('x-')) continue;
      const m = method.toLowerCase();
      if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m)) {
        routes.add(`${method.toUpperCase()} ${normPath}`);
      }
    }
  }
  return { routes, error: null };
}

function gapFromError(featureId, message, blocking = true) {
  return {
    feature_id: featureId,
    category: 'deterministic',
    severity: blocking ? 'blocking' : 'warning',
    blocking,
    message,
  };
}

function collectFilePlanPaths(filePlan) {
  const out = new Set();
  if (!filePlan || typeof filePlan !== 'object') return out;
  for (const key of ['new_files', 'modify_files', 'reuse_existing']) {
    for (const p of filePlan[key] || []) {
      const t = String(p || '').trim();
      if (t) out.add(t);
    }
  }
  return out;
}

/**
 * 单 feature 确定性对齐检查
 * @returns {{ errors: string[], gaps: object[] }}
 */
function runDeterministicAlignForFeature({
  projectRoot,
  featureId,
  art,
  designSpecRow,
  readJson,
  validateDesignSnapshot,
  validateJson,
}) {
  const fid = String(featureId || '').trim();
  const errors = [];
  const gaps = [];

  const pushErr = (msg, blocking = true) => {
    errors.push(`[${fid}] ${msg}`);
    gaps.push(gapFromError(fid, msg, blocking));
  };

  if (!art) {
    pushErr('missing contract.outputs.artifacts row');
    return { errors, gaps };
  }

  const required = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'];
  for (const k of required) {
    const rel = art[k];
    if (!rel || !String(rel).trim()) {
      pushErr(`missing artifact path: ${k}`);
      continue;
    }
    const abs = path.join(projectRoot, ...String(rel).split('/'));
    if (!fs.existsSync(abs)) pushErr(`artifact file missing: ${rel}`);
  }

  const designRel = path.join('docs', 'designs', `${fid}.design.json`);
  const designAbs = path.join(projectRoot, designRel);
  let designDoc = null;
  if (!fs.existsSync(designAbs)) {
    pushErr(`missing ${designRel}`);
  } else {
    try {
      designDoc = readJson(designAbs);
    } catch (e) {
      pushErr(`${designRel}: invalid JSON (${e.message})`);
    }
    if (designDoc?.feature_id && designDoc.feature_id !== fid) {
      pushErr(`${designRel}: feature_id mismatch filename`);
    }
  }

  const snapRel = art.design_snapshot;
  if (!snapRel) return { errors, gaps };

  const snapAbs = path.join(projectRoot, ...String(snapRel).split('/'));
  let snap;
  try {
    snap = readJson(snapAbs);
  } catch (e) {
    pushErr(`${snapRel}: ${e.message}`);
    return { errors, gaps };
  }

  if (validateDesignSnapshot && validateJson) {
    const vr = validateJson(validateDesignSnapshot, snap, snapRel);
    if (!vr.ok) {
      for (const e of vr.errors) pushErr(e);
    }
  }

  if (designSpecRow) {
    if (snap.feature_id && designSpecRow.feature_id && snap.feature_id !== designSpecRow.feature_id) {
      pushErr('snapshot/design_specs feature_id mismatch');
    }
    if (
      snap.client_target &&
      designSpecRow.client_target &&
      snap.client_target !== designSpecRow.client_target
    ) {
      pushErr('snapshot/design_specs client_target mismatch');
    }
  }

  if (designDoc) {
    if (snap.client_target && designDoc.client_target && snap.client_target !== designDoc.client_target) {
      pushErr('snapshot/design.json client_target mismatch');
    }
    const dAccept = Array.isArray(designDoc.acceptance) ? designDoc.acceptance : [];
    const sAccept = Array.isArray(snap.acceptance) ? snap.acceptance : [];
    if (dAccept.length > 0 && sAccept.length === 0) {
      pushErr('design.json has acceptance[] but snapshot acceptance is empty', true);
    }

    const dPlan = collectFilePlanPaths(designDoc.file_plan);
    const sPlan = collectFilePlanPaths(snap.file_plan);
    if (dPlan.size > 0 && sPlan.size === 0) {
      pushErr('design.json file_plan non-empty but snapshot file_plan empty', true);
    }

    const outlineRoutes = extractApiOutlineRoutes(designDoc.api_outline || snap.api_outline);
    const apiRel = art.api;
    if (apiRel && outlineRoutes.size > 0) {
      const apiAbs = path.join(projectRoot, ...String(apiRel).split('/'));
      if (fs.existsSync(apiAbs)) {
        const apiText = fs.readFileSync(apiAbs, 'utf8');
        const { routes: oaRoutes, error: parseErr } = extractOpenApiRoutes(apiText);
        if (parseErr) {
          pushErr(`${apiRel}: ${parseErr}`);
        } else {
          for (const r of outlineRoutes) {
            if (!oaRoutes.has(r)) {
              pushErr(`api_outline route missing in OpenAPI: ${r}`, true);
            }
          }
        }
      }
    }

    const testRel = art.test_spec;
    if (dAccept.length > 0 && testRel) {
      const testAbs = path.join(projectRoot, ...String(testRel).split('/'));
      if (fs.existsSync(testAbs)) {
        const body = fs.readFileSync(testAbs, 'utf8');
        if (body.trim().length < 40) {
          gaps.push(
            gapFromError(fid, 'test_spec very short while acceptance[] is non-empty', false)
          );
        }
      }
    }
  }

  return { errors, gaps };
}

module.exports = {
  runDeterministicAlignForFeature,
  extractApiOutlineRoutes,
  extractOpenApiRoutes,
  gapFromError,
  isBlockingGap: (g) => g?.blocking === true || String(g?.severity || '').toLowerCase() === 'blocking',
};

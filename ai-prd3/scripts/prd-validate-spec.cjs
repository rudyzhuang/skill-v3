'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { parseArgs, requireProject, prdSpecPath, stagesPath } = require('./lib/paths.cjs');
const { parseClientTargets, tryLegacyYaml } = require('./prd-parse-client-targets.cjs');

const H2_PER_TARGET_CN = /^##\s+7\.\s+各端专属需求\s*$/m;
const H2_PER_TARGET_EN = /^##\s+7\.\s+Target-Specific Requirements\s*$/m;
const MIN_SECTION_BODY_CHARS = 20;

/**
 * @param {string} md
 * @param {string} slug
 */
function sectionBodyLen(md, slug) {
  const re = new RegExp(`^###\\s+${slug}\\s*$`, 'm');
  const m = md.match(re);
  if (!m || m.index === undefined) return -1;
  const from = m.index + m[0].length;
  const tail = md.slice(from);
  const next = tail.search(/^###\s+/m);
  const nextH2 = tail.search(/^##\s+/m);
  let end = tail.length;
  if (next >= 0) end = Math.min(end, next);
  if (nextH2 >= 0) end = Math.min(end, nextH2);
  const body = tail.slice(0, end).replace(/\s+/g, ' ').trim();
  return body.length;
}

function detectLang(md) {
  if (H2_PER_TARGET_CN.test(md) || /##\s+端\s*\(Client Targets\)/.test(md)) return 'cn';
  if (H2_PER_TARGET_EN.test(md) || /^##\s+Client Targets\s*$/m.test(md)) return 'en';
  return 'cn';
}

function main() {
  const args = parseArgs(process.argv);
  const root = requireProject(args);
  const specPath = prdSpecPath(root);
  if (!fs.existsSync(specPath)) {
    console.error('缺少', specPath);
    process.exit(1);
  }
  const md = fs.readFileSync(specPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const stagesFile = stagesPath(root);
  if (fs.existsSync(stagesFile)) {
    try {
      const stagesDoc = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
      const prd = stagesDoc.stages?.prd;
      const stored = prd?.inputs?.summary_hash;
      if (
        prd?.status === 'completed' &&
        prd?.validation?.passed === true &&
        typeof stored === 'string' &&
        /^[a-f0-9]{64}$/.test(stored)
      ) {
        const curHash = crypto.createHash('sha256').update(Buffer.from(md, 'utf8')).digest('hex');
        if (curHash !== stored) {
          console.error(
            'validate-spec: prd_spec_drift: prd-spec.md 与 stages.prd.inputs.summary_hash 不一致；请重跑 validate-prd + write-prd，或 bootstrap --force 后重做 prd'
          );
          process.exit(1);
        }
      }
    } catch (e) {
      console.error('validate-spec: stages_drift_check_error', String(e.message || e));
      process.exit(1);
    }
  }

  let parsed = parseClientTargets(md);
  let summaryExtra = '';
  if (!parsed.ok) {
    const legacy = tryLegacyYaml(md);
    if (legacy && legacy.length) {
      parsed = { ok: true, slugs: legacy };
      summaryExtra = 'legacy_yaml_client_targets';
    }
  }
  if (!parsed.ok) {
    console.error('validate-spec:', parsed.error);
    process.exit(1);
  }

  const lang = detectLang(md);
  const h2Ok =
    lang === 'en' ? H2_PER_TARGET_EN.test(md) || H2_PER_TARGET_CN.test(md) : H2_PER_TARGET_CN.test(md) || H2_PER_TARGET_EN.test(md);
  if (!h2Ok) {
    console.error('validate-spec: missing_per_target_section_h2');
    process.exit(1);
  }

  for (const slug of parsed.slugs) {
    const n = sectionBodyLen(md, slug);
    if (n < 0) {
      console.error(`validate-spec: missing_per_target_h3:${slug}`);
      process.exit(1);
    }
    if (n < MIN_SECTION_BODY_CHARS) {
      console.error(`validate-spec: per_target_section_too_short:${slug}:${n}`);
      process.exit(1);
    }
  }

  const out = { ok: true, declared: parsed.slugs, summary: summaryExtra || 'ok' };
  console.log(JSON.stringify(out, null, 2));
}

main();

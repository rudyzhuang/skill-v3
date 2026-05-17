'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { parseArgs, requireProject, skillDirFrom } = require('./lib/paths.cjs');
const { parseClientTargets, tryLegacyYaml } = require('./prd-parse-client-targets.cjs');
const { deepMerge } = require('./lib/merge-stages.cjs');
const { fillMissingFromTemplate, wouldFillChange } = require('./lib/config-fill.cjs');
const { resolveRawInputFilePath, loadRawInputContent } = require('./lib/raw-input.cjs');
const featureStages = require('../../ai-auto3/scripts/lib/feature-stages.cjs');

function getGitRemoteUrl(root) {
  try {
    return execSync('git remote get-url origin', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    try {
      const names = execSync('git remote', { cwd: root, encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (names[0]) {
        return execSync(`git remote get-url ${names[0]}`, { cwd: root, encoding: 'utf8' }).trim();
      }
    } catch {
      /* ignore */
    }
  }
  return '';
}

function computeProjectId(root) {
  const remote = getGitRemoteUrl(root);
  if (remote) {
    const real = fs.realpathSync(root);
    const h = crypto.createHash('sha1').update(`${remote}|${real}`, 'utf8').digest('hex');
    return `p-${h.slice(0, 12)}`;
  }
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
  return `p-${hex}`;
}

function copyIfMissing(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  }
  return false;
}

/**
 * Parse core features table from prd-spec.
 * Expected table order:
 * | 功能 ID | 名称 | 涉及端 | 优先级 | 阶段 | 描述 | 验收摘要 |
 */
function parseCoreFeatures(specText) {
  const lines = specText.split('\n');
  const out = [];
  let inCore = false;
  let inTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+6\.\s*核心功能\s*$/.test(line)) {
      inCore = true;
      continue;
    }
    if (inCore && /^##\s+/.test(line) && !/^##\s+6\.\s*核心功能\s*$/.test(line)) {
      break;
    }
    if (!inCore) continue;
    if (!inTable && /^\|\s*功能 ID\s*\|\s*名称\s*\|\s*涉及端\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable || !line.startsWith('|')) continue;
    if (/^\|\s*[-: ]+\|/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((v) => v.trim());
    if (cells.length < 7) continue;
    const [featureId, name, targets, priority, phase, description, acceptance] = cells;
    if (!featureId || /^功能 ID$/i.test(featureId)) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(featureId)) continue;
    const relatedTargets = targets
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    out.push({
      featureId,
      name,
      relatedTargets,
      priority: priority || 'must',
      phase: phase || 'mvp',
      description,
      acceptance,
    });
  }
  return out;
}

function derivePerTargetFiles(projectRoot, targets, specText, options = {}) {
  const overwrite = options.overwrite === true;
  const now = new Date().toISOString();
  const allFeatures = parseCoreFeatures(specText);
  const featureListTpl = path.join(skillDirFrom(__filename), 'templates', 'feature_list.md.template');
  const featureListTplText = fs.readFileSync(featureListTpl, 'utf8');

  for (const slug of targets) {
    const targetDir = path.join(projectRoot, 'docs', slug);
    fs.mkdirSync(targetDir, { recursive: true });
    const perTarget = allFeatures.filter((f) => f.relatedTargets.includes(slug));
    const fallbackId = `${slug.toUpperCase()}-BOOTSTRAP-001`;
    const rows = (perTarget.length ? perTarget : [{
      featureId: fallbackId,
      name: `${slug} bootstrap placeholder`,
      relatedTargets: [slug],
      priority: 'must',
      phase: 'mvp',
      description: 'bootstrap generated placeholder feature',
      acceptance: 'replace with real feature from docs/prd-spec.md',
    }])
      .map((f) =>
        `| ${f.featureId} | health | ${f.name || f.featureId} | draft | ${f.priority} | ${f.phase} | ${f.relatedTargets.join(',')} | ${f.acceptance || ''} |`
      )
      .join('\n');
    const details = (perTarget.length ? perTarget : [{
      featureId: fallbackId,
      name: `${slug} bootstrap placeholder`,
      relatedTargets: [slug],
      priority: 'must',
      phase: 'mvp',
      description: 'bootstrap generated placeholder feature',
      acceptance: 'replace with real feature from docs/prd-spec.md',
    }])
      .map((f) => [
        `### \`${f.featureId}\`: \`${f.name || f.featureId}\``,
        '',
        '- Area: health',
        '- Status: `draft`',
        `- Priority: \`${f.priority}\``,
        `- Phase: \`${f.phase}\``,
        `- Client target: \`${slug}\``,
        `- Related targets: ${f.relatedTargets.join(',')}`,
        '- Source requirement: docs/prd-spec.md#6-核心功能',
        `- Description: ${f.description || ''}`,
        '- User value: 快速确认系统可用',
        '- Dependencies: none',
        '- Risks: placeholder may be inaccurate if prd table changed',
        '',
        '#### Acceptance Criteria',
        '',
        '- Given 服务已启动',
        `- When 调用 ${slug === 'backend' ? '/api/health' : 'health 页面'}`,
        '- Then 返回或展示 healthy 状态',
        '',
        '#### Design Input Notes',
        '',
        '- Data / entity hints: health status object',
        '- API / integration hints: backend health endpoint',
        '- UI / flow hints: single status card',
        '- Non-functional constraints: low latency',
        '',
        '#### Review Notes',
        '',
        '- prd-review decision: pending',
        '- Blocking issues: none',
        '- Follow-up: refine during design stage',
      ].join('\n'))
      .join('\n\n');

    const flPath = path.join(targetDir, 'feature_list.md');
    if (overwrite || !fs.existsSync(flPath)) {
      let text = featureListTplText
        .replace('| client_target |  |', `| client_target | ${slug} |`)
        .replace('| generated_at |  |', `| generated_at | ${now} |`);
      text = text.replace('|  |  |  | draft | must | mvp |  |  |', rows);
      text = text.replace(
        /### `<FEATURE-ID>`: `<Feature Name>`[\s\S]*$/,
        details
      );
      fs.writeFileSync(flPath, `${text}\n`, 'utf8');
    }

    const prdPath = path.join(targetDir, 'prd.md');
    if (overwrite || !fs.existsSync(prdPath)) {
      const featureIds = (perTarget.length ? perTarget : [{ featureId: fallbackId }])
        .map((f) => `- \`${f.featureId}\``)
        .join('\n');
      const prdText = [
        `# ${slug} PRD`,
        '',
        `该文件由 ai-prd3 bootstrap 自动生成。来源：\`docs/prd-spec.md\`。`,
        '',
        '## Scope',
        '',
        `- Client target: \`${slug}\``,
        '- Goal: deliver minimal health feature for local verification',
        '',
        '## Features',
        '',
        featureIds,
        '',
        '## Dependencies',
        '',
        '- Source spec: docs/prd-spec.md',
        '- Config: docs/config.dev.json',
      ].join('\n');
      fs.writeFileSync(prdPath, `${prdText}\n`, 'utf8');
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const projectRoot = requireProject(args);
  const skillDir = skillDirFrom(__filename);
  const tplRoot = path.join(skillDir, 'templates');

  const prdSpec = path.join(projectRoot, 'docs', 'prd-spec.md');
  const lang = args.lang === 'en' ? 'en' : 'cn';
  const prdTpl = path.join(tplRoot, 'prd-spec', lang === 'en' ? 'prd-spec.en.md.template' : 'prd-spec.cn.md.template');

  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  copyIfMissing(prdTpl, prdSpec);

  const cfgDev = path.join(projectRoot, 'docs', 'config.dev.json');
  const cfgRel = path.join(projectRoot, 'docs', 'config.release.json');
  const cfgEnv = path.join(projectRoot, 'docs', 'config.env');
  copyIfMissing(path.join(tplRoot, 'config.dev.json.template'), cfgDev);
  copyIfMissing(path.join(tplRoot, 'config.release.json.template'), cfgRel);
  copyIfMissing(path.join(tplRoot, 'config.env.template'), cfgEnv);

  const devTplPath = path.join(tplRoot, 'config.dev.json.template');
  const relTplPath = path.join(tplRoot, 'config.release.json.template');
  for (const [label, cfgPath, tplPath] of [
    ['config.dev.json', cfgDev, devTplPath],
    ['config.release.json', cfgRel, relTplPath],
  ]) {
    const cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
    if (!wouldFillChange(cur, tpl)) continue;
    if (!args.allowFillMissingKeys) {
      console.error(
        `bootstrap: ${label} 相对模板存在缺失键，拒绝静默改写（prd3.md §7.2）。请传 --allow-fill-missing-keys 做 additive 补齐。`
      );
      process.exit(1);
    }
    const filled = fillMissingFromTemplate(cur, tpl);
    fs.writeFileSync(cfgPath, `${JSON.stringify(filled, null, 2)}\n`, 'utf8');
    console.warn(`bootstrap: 已对 ${label} 做相对模板的 additive 补齐`);
  }

  const stagesFile = path.join(projectRoot, '.pipeline', 'stages.json');
  const stagesTpl = path.join(tplRoot, 'stages.json.template');
  let stages;
  if (!fs.existsSync(stagesFile)) {
    fs.mkdirSync(path.join(projectRoot, '.pipeline'), { recursive: true });
    const raw = fs.readFileSync(stagesTpl, 'utf8');
    stages = JSON.parse(raw);
  } else {
    stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
    const template = JSON.parse(fs.readFileSync(stagesTpl, 'utf8'));
    stages = deepMerge(template, stages);
  }

  const prdDone =
    stages.stages?.prd?.status === 'completed' && stages.stages?.prd?.validation?.passed === true;
  if (prdDone && !args.force) {
    console.error('bootstrap: prd 已完成，再次 bootstrap 须加 --force（与 prd3.md §7.5 / input-spec §7.2 一致）');
    process.exit(1);
  }
  if (prdDone && args.force) {
    stages.stages.prd.status = 'running';
    stages.stages.prd.completed_at = null;
    stages.stages.prd.inputs = stages.stages.prd.inputs || {};
    stages.stages.prd.inputs.summary_hash = '';
    stages.stages.prd.validation = stages.stages.prd.validation || {};
    stages.stages.prd.validation.passed = false;
    stages.stages.prd.validation.summary = '';
    // prd 重做时清理 prd-review 完成态，避免门闸双真源（与 prd3.md §8 前置门闸一致）
    stages.stages.prd_review = stages.stages.prd_review || {};
    stages.stages.prd_review.status = 'not_started';
    stages.stages.prd_review.completed_at = null;
    stages.stages.prd_review.inputs = { ...(stages.stages.prd_review.inputs || {}), summary_hash: '' };
    stages.stages.prd_review.outputs = {
      ...(stages.stages.prd_review.outputs || {}),
      can_enter_design: false,
      decision: 'pending',
    };
    stages.stages.prd_review.validation = {
      ...(stages.stages.prd_review.validation || {}),
      passed: false,
      summary: 'reset_by_bootstrap_force',
    };
  }

  const pid = computeProjectId(projectRoot);
  const now = new Date().toISOString();
  stages.project = stages.project || {};
  if (!stages.project.project_id) stages.project.project_id = pid;
  stages.project.root_path = projectRoot;
  stages.pipeline = stages.pipeline || {};
  stages.pipeline.updated_at = now;
  stages.pipeline.updated_by = 'ai-prd3';
  const loaded = loadRawInputContent(projectRoot, stages, {
    rawInputText: args.rawInputText,
    rawInputStdin: args.rawInputStdin,
    rawInputOverride: args.rawInput,
  });
  if (loaded.ok) {
    stages.pipeline.raw_input = stages.pipeline.raw_input || {};
    stages.pipeline.raw_input.source = loaded.source;
    stages.pipeline.raw_input.path = loaded.path;
    stages.stages.prd = stages.stages.prd || {};
    stages.stages.prd.inputs = stages.stages.prd.inputs || {};
    stages.stages.prd.inputs.raw_input_refs = [loaded.path];
    stages.stages.prd.inputs.raw_input_path = loaded.path;
    stages.stages.prd.inputs.raw_input_source = loaded.source;
  } else {
    const rawResolved = resolveRawInputFilePath(projectRoot, stages, { rawInputOverride: args.rawInput });
    if (rawResolved.abs) {
      stages.pipeline.raw_input = stages.pipeline.raw_input || {};
      stages.pipeline.raw_input.source = 'file';
      stages.pipeline.raw_input.path = rawResolved.rel;
      stages.stages.prd = stages.stages.prd || {};
      stages.stages.prd.inputs = stages.stages.prd.inputs || {};
      stages.stages.prd.inputs.raw_input_refs = [rawResolved.rel];
      stages.stages.prd.inputs.raw_input_path = rawResolved.rel;
      stages.stages.prd.inputs.raw_input_source = 'file';
    }
  }

  const specText = fs.readFileSync(prdSpec, 'utf8');
  let parse = parseClientTargets(specText);
  let legacyNote = '';
  if (!parse.ok && parse.error === 'missing_client_targets_heading') {
    const legacy = tryLegacyYaml(specText);
    if (legacy && legacy.length) {
      parse = { ok: true, slugs: legacy };
      legacyNote = 'legacy_yaml_client_targets';
    }
  }
  if (!parse.ok) {
    console.error('bootstrap: 无法解析 client_targets:', parse.error);
    process.exit(1);
  }

  stages.client_targets = stages.client_targets || {};
  stages.client_targets.declared = parse.slugs;
  if (legacyNote) {
    stages.client_targets._bootstrap_note = legacyNote;
  }

  for (const slug of parse.slugs) {
    fs.mkdirSync(path.join(projectRoot, 'docs', slug), { recursive: true });
  }
  derivePerTargetFiles(projectRoot, parse.slugs, specText, { overwrite: args.force === true });

  stages.stages = stages.stages || {};
  stages.stages.prd = stages.stages.prd || {};
  stages.stages.prd.status = 'running';
  stages.stages.prd.started_at = stages.stages.prd.started_at || now;
  stages.stages.prd.outputs = stages.stages.prd.outputs || {};
  stages.stages.prd.outputs.client_targets = parse.slugs.slice();
  stages = featureStages.backfillFeatureStages(stages);
  const prdIds = featureStages.collectPhaseFeatureIds(stages);
  if (prdIds.length) {
    stages = featureStages.beginStageForFeatures(stages, {
      stageKey: 'prd',
      featureIds: prdIds,
      skill: 'ai-prd3',
      message: 'bootstrap：prd 阶段处理中',
    }).doc;
  } else {
    stages = featureStages.markStageRunning(stages, 'prd', 'ai-prd3');
  }

  fs.writeFileSync(stagesFile, `${JSON.stringify(stages, null, 2)}\n`, 'utf8');
  featureStages.appendStageLog(projectRoot, {
    skill: 'ai-prd3',
    stageKey: 'prd',
    featureIds: prdIds,
    message: `bootstrap 完成，prd=running，端=${parse.slugs.join(',')}`,
    detail: prdIds.length ? prdIds.join(',') : 'no phase_plan yet',
  });

  for (const f of [cfgDev, cfgRel]) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.project = j.project || {};
    j.project.project_id = stages.project.project_id;
    j.project.root_path = projectRoot;
    j.metadata = j.metadata || {};
    j.metadata.updated_at = now;
    fs.writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
  }

  const gitignore = path.join(projectRoot, '.gitignore');
  if (fs.existsSync(gitignore)) {
    const g = fs.readFileSync(gitignore, 'utf8');
    if (!g.includes('.agent-sessions/')) {
      console.warn('建议在 .gitignore 中加入: .agent-sessions/');
    }
  } else {
    console.warn('建议在 .gitignore 中加入: .agent-sessions/');
  }

  console.log(JSON.stringify({ ok: true, declared: parse.slugs, project_id: stages.project.project_id }, null, 2));
}

main();

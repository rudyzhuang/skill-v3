'use strict';

/**
 * prd-implementation-report.cjs — 基于 prd_review.review.phase_plan 与各端 feature_list
 * 生成「说人话」的实施节奏摘要（prd3.md §8.8）。
 * CLI: node prd-implementation-report.cjs --project=<root>
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, requireProject, stagesPath } = require('./lib/paths.cjs');

const REPORT_REL = path.join('.pipeline', 'reports', 'prd-implementation-summary.md');

function sliceFeaturesSection(md) {
  const m = md.match(/^##\s+Features\s*$/m);
  if (!m || m.index === undefined) return '';
  const start = m.index + m[0].length;
  const tail = md.slice(start);
  const nextH2 = tail.search(/^##\s+/m);
  return nextH2 >= 0 ? tail.slice(0, nextH2) : tail;
}

/** @returns {Map<string, { name: string, area: string, target: string }>} */
function indexFeaturesFromList(md, clientTarget) {
  const map = new Map();
  const section = sliceFeaturesSection(md);
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|\s*:?-+:?\s*\|/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    const id = cells[1];
    const area = cells[2] || '';
    const name = cells[3] || '';
    if (!id || /^feature id$/i.test(id)) continue;
    if (/^[-:]+$/.test(id)) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) continue;
    if (!map.has(id)) map.set(id, { name: name || id, area, target: clientTarget });
  }
  return map;
}

function loadFeatureIndex(root, declared) {
  const merged = new Map();
  for (const slug of declared) {
    const fp = path.join(root, 'docs', slug, 'feature_list.md');
    if (!fs.existsSync(fp)) continue;
    const md = fs.readFileSync(fp, 'utf8');
    for (const [id, meta] of indexFeaturesFromList(md, slug)) {
      if (!merged.has(id)) merged.set(id, meta);
    }
  }
  return merged;
}

/**
 * @param {string} root
 * @param {object} stagesDoc full .pipeline/stages.json root
 * @returns {string} markdown (Chinese, human-oriented)
 */
function buildImplementationReportMarkdown(root, stagesDoc) {
  const pr = stagesDoc.stages?.prd_review;
  const plan = pr?.review?.phase_plan || [];
  const summary = (pr?.review?.summary || '').trim() || '（无摘要）';
  const declared = stagesDoc.client_targets?.declared || [];
  const idx = loadFeatureIndex(root, declared);

  const lines = [];
  lines.push('────────────────────────────────────────');
  lines.push(' ai-prd3 · 实施节奏摘要（人话版）');
  lines.push(` 生成时间: ${new Date().toISOString()}`);
  lines.push('────────────────────────────────────────');
  lines.push('');

  lines.push('## 分几期做');
  const n = plan.length;
  if (n === 0) {
    lines.push('当前 **phase_plan** 为空，没法分期说明；请确认 prd-review JSON 已正确合并。');
    lines.push('');
  } else {
    lines.push(
      `评审结论里把交付拆成了 **${n}** 个实施阶段（这是「产品/交付节奏」上的分期）。` +
        '后面还会依次经过 **design → contract → … → build → deploy** 等技术流水线门闸，那是「怎么落地」的另一套阶段，和这里的「第几期上线什么」可以分开记。'
    );
    lines.push('');
    plan.forEach((ph, i) => {
      const label = ph.phase || `阶段 ${i + 1}`;
      const goal = (ph.goal || '').trim() || '（未写目标）';
      lines.push(`${i + 1}. **第 ${i + 1} 期 · ${label}** — ${goal}`);
    });
    lines.push('');
  }

  const first = plan[0];
  lines.push('## 第一期做完，大概能用什么');
  if (!first) {
    lines.push('（无 phase_plan 第一条）');
  } else {
    lines.push(`**这一期的代号**：${first.phase || '（未命名）'}`);
    lines.push('');
    lines.push(`**想达成的目标（评审里写的）**：${(first.goal || '').trim() || '（未写）'}`);
    lines.push('');
    const ec = (first.exit_criteria || []).filter((x) => String(x).trim());
    if (ec.length) {
      lines.push('**收工时大致要满足**：');
      for (const c of ec) lines.push(`- ${c}`);
      lines.push('');
    }
    const ids = first.feature_ids || [];
    lines.push('**包含的功能点**（名称来自各端 `feature_list.md` 的 Features 表）：');
    if (!ids.length) lines.push('- （本期待办 id 列表为空）');
    else {
      for (const fid of ids) {
        const meta = idx.get(fid);
        const human = meta ? `${meta.name}（端：${meta.target}）` : `（表中未匹配到名称，id=${fid}）`;
        lines.push(`- **${fid}**：${human}`);
      }
    }
    lines.push('');
  }

  lines.push('## 评审结论摘要（原文）');
  lines.push(summary);
  lines.push('');

  if (plan.length > 1) {
    lines.push('## 后续各期一览（只列目标，细节见 stages.json）');
    for (let i = 1; i < plan.length; i++) {
      const ph = plan[i];
      const g = (ph.goal || '').trim() || '（未写目标）';
      lines.push(`- **第 ${i + 1} 期 · ${ph.phase || `阶段 ${i + 1}`}**：${g}`);
    }
    lines.push('');
  }

  lines.push('## 接下来去哪儿');
  lines.push(
    '- **prd-review 已通过**时：可以进入 **ai-design3** 做设计与契约准备（见 `docs/spec/design3.md`）。'
  );
  lines.push(
    '- 若要从 **design** 起一路自动跑到 dev 的 deploy/smoke/report：用 **ai-auto3**（**不**从 prd 起步）。'
  );
  lines.push('');
  lines.push(`> 机器可读真源仍在 **\`.pipeline/stages.json\` → \`stages.prd_review.review.phase_plan\`**；本文件仅作给人看的摘要。`);

  return `${lines.join('\n')}\n`;
}

function reportAbsolutePath(root) {
  return path.join(root, REPORT_REL);
}

function isReportablePrdReview(pr) {
  return (
    pr &&
    pr.status === 'completed' &&
    pr.validation?.passed === true &&
    pr.outputs?.decision === 'passed'
  );
}

function writeImplementationReport(root, stagesDoc) {
  const pr = stagesDoc.stages?.prd_review;
  if (!isReportablePrdReview(pr)) {
    throw new Error('prd_review 非可报告状态（须 status=completed、validation.passed=true、outputs.decision=passed）');
  }
  const text = buildImplementationReportMarkdown(root, stagesDoc);
  const out = reportAbsolutePath(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, 'utf8');
  return { path: out, text };
}

function main() {
  const args = parseArgs(process.argv);
  let root;
  try {
    root = requireProject(args);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  const stagesFile = stagesPath(root);
  if (!fs.existsSync(stagesFile)) {
    console.error('缺少', stagesFile);
    process.exit(1);
  }
  let stagesDoc;
  try {
    stagesDoc = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  } catch (e) {
    console.error('stages.json 无法解析:', String(e.message || e));
    process.exit(1);
  }
  const pr = stagesDoc.stages?.prd_review;
  if (!isReportablePrdReview(pr)) {
    console.error(
      '仅当 stages.prd_review 为 completed、validation.passed=true 且 outputs.decision=passed 时可生成报告（先跑 validate-prd-review 终检通过）。'
    );
    process.exit(1);
  }
  const { path: out, text } = writeImplementationReport(root, stagesDoc);
  console.error(`已写入: ${out}`);
  process.stdout.write(text);
  process.exit(0);
}

module.exports = {
  buildImplementationReportMarkdown,
  writeImplementationReport,
  isReportablePrdReview,
};

if (require.main === module) {
  main();
}

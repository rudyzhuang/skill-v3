#!/usr/bin/env node
/**
 * ui-e2e.cjs — stage: ui_e2e
 *
 * 规范: docs/spec/std3.md §1 ui_e2e.cjs
 *
 * 调用 Browser MCP（web）或 Dart MCP（mobile）执行 UI 场景。
 * 需要 Agent + MCP 支持；无 Agent 时（非 strict 调试）可 skip。
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { readStages, updateStage, sha256Text } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[ui-e2e] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages) { console.error('[ui-e2e] ❌ stages.json 不存在'); process.exit(1); }

const smoke = stages.stages.smoke;
const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }

const e2eCfg = cfg.ui_e2e || {};
const enabled = e2eCfg.enabled !== false;

if (!enabled) {
  console.log('[ui-e2e] ℹ ui_e2e.enabled=false，跳过');
  updateStage(projectRoot, 'ui_e2e', {
    status: 'skipped',
    completed_at: new Date().toISOString(),
    outputs: { skip_reason: 'ui_e2e.enabled=false' },
    validation: { passed: true, checked_at: new Date().toISOString(), summary: 'skipped' },
  });
  process.exit(0);
}

const requireSmokePassed = e2eCfg.require_smoke_passed !== false;
if (requireSmokePassed && (!smoke.validation || !smoke.validation.passed)) {
  console.error('[ui-e2e] ❌ 上游门闸失败：smoke 未通过（或设置 ui_e2e.require_smoke_passed=false 跳过此检查）');
  process.exit(1);
}

updateStage(projectRoot, 'ui_e2e', { status: 'running', started_at: new Date().toISOString() });

const agentBin   = process.env.AI_E2E3_AGENT_BIN || process.env.AI_STD3_AGENT_BIN || '';
const soakStrict = process.env.AI_SOAK3_STRICT === '1';

if (!agentBin) {
  if (soakStrict) {
    console.error('[ui-e2e] ❌ AI_SOAK3_STRICT=1 但未找到 Agent (AI_E2E3_AGENT_BIN)，禁止假通过');
    process.exit(1);
  }
  console.warn('[ui-e2e] ⚠ 未找到 Agent，无法执行 UI 场景。请设置 AI_E2E3_AGENT_BIN。');
  updateStage(projectRoot, 'ui_e2e', {
    status: 'failed',
    outputs: { skip_reason: '无 Agent，无法执行 UI 场景' },
    validation: { passed: false, summary: 'no agent' },
  });
  process.exit(4);
}

// ── 收集场景文件 ────────────────────────────────────────────────────────────
const scenariosDir = path.join(projectRoot, 'docs', 'ui-scenarios');
const cui = stages.stages.create_ui_scenarios;
const scenarioFiles = (cui.outputs && cui.outputs.scenario_files) || [];

if (scenarioFiles.length === 0) {
  console.log('[ui-e2e] ℹ 无 UI 场景，跳过');
  updateStage(projectRoot, 'ui_e2e', {
    status: 'skipped',
    completed_at: new Date().toISOString(),
    outputs: { scenarios_total: 0, skip_reason: '无场景' },
    validation: { passed: true, checked_at: new Date().toISOString(), summary: 'skipped (no scenarios)' },
  });
  process.exit(0);
}

// ── 解析 base_url ──────────────────────────────────────────────────────────
const deployedServices = (stages.stages.deploy.outputs && stages.stages.deploy.outputs.services) || [];
function resolveBaseUrl(placeholder) {
  return placeholder.replace(/\{deploy\.services\.(\w+)\.url\}/g, (_, target) => {
    const svc = deployedServices.find(s => s.client_target === target);
    return (svc && svc.url) || placeholder;
  });
}

// ── 执行场景（通过 Agent） ─────────────────────────────────────────────────
const sessionId = args.sessionId || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logDir    = path.join(projectRoot, '.agent-sessions', 'ui-test');
fs.mkdirSync(logDir, { recursive: true });

const { spawnSync } = require('child_process');
const results = [];

for (const sf of scenarioFiles) {
  const yamlPath = path.join(projectRoot, sf.path);
  if (!fs.existsSync(yamlPath)) continue;

  const yamlContent  = fs.readFileSync(yamlPath, 'utf8');
  const resolvedYaml = resolveBaseUrl(yamlContent);

  const promptDir  = path.resolve(__dirname, '..', '..', 'prompts');
  const promptText = `执行以下 UI 测试场景并报告结果（pass/fail）：\n\n${resolvedYaml}`;

  const maxFix = Number(e2eCfg.commands && e2eCfg.commands.ui_test_max_fix_attempts) || 3;
  let passed = false;
  let attempts = 0;

  while (!passed && attempts < maxFix) {
    attempts++;
    console.log(`[ui-e2e] ▶ ${sf.feature_id} (attempt ${attempts}/${maxFix})`);

    const r = spawnSync(agentBin, ['--prompt', promptText, '--workspace', projectRoot], {
      stdio: 'inherit',
      timeout: 1800000,
      env: { ...process.env, FEATURE_ID: sf.feature_id, SESSION_ID: sessionId },
    });
    if (r.status === 0) { passed = true; break; }
  }

  results.push({ scenario_id: sf.feature_id, passed, fix_attempts: attempts });
  console.log(`[ui-e2e] ${passed ? '✅' : '❌'} ${sf.feature_id}`);
}

const allPassed  = results.every(r => r.passed);
const reportPath = `.pipeline/reports/ui-e2e-${sessionId}.md`;
const reportContent = `# UI E2E Report (${sessionId})\n\n` +
  results.map(r => `- [${r.passed ? 'x' : ' '}] ${r.scenario_id} (attempts: ${r.fix_attempts})`).join('\n');

fs.mkdirSync(path.join(projectRoot, '.pipeline', 'reports'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, reportPath), reportContent, 'utf8');

updateStage(projectRoot, 'ui_e2e', {
  status: allPassed ? 'completed' : 'failed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(JSON.stringify(results)) },
  outputs: {
    scenarios_total: results.length,
    scenarios_passed: results.filter(r => r.passed).length,
    scenarios_failed: results.filter(r => !r.passed).length,
    results,
    report_path: reportPath,
  },
  validation: {
    passed: allPassed,
    checked_at: new Date().toISOString(),
    summary: `${results.filter(r => r.passed).length}/${results.length} passed`,
  },
});

if (!allPassed) {
  console.error(`[ui-e2e] ❌ UI 测试有失败场景，退出码 4`);
  process.exit(4);
}

console.log(`[ui-e2e] ✅ ui_e2e 完成（${results.length} scenarios all passed）`);
process.exit(0);

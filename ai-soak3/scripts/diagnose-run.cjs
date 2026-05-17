#!/usr/bin/env node
/**
 * diagnose-run.cjs  —  ai-soak3 辅助脚本
 * 全面分析当前 Skill V3 运行状态，快速定位问题。
 * 读取: stages.json / 最新 report / 会话日志 / session-health
 *
 * 规范真源：~/.cursor/skills/ai-soak3/docs/spec/soak3.md §7.3
 *
 * 用法:
 *   node ~/.cursor/skills/ai-soak3/scripts/diagnose-run.cjs --project=<业务项目根目录>
 *
 * 输出: 控制台诊断摘要 + <project>/.pipeline/reports/diagnosis.md
 *
 * 退出码:
 *   0 = 未发现明显问题
 *   1 = 发现问题（见输出）
 */

'use strict';
const fs = require('fs');
const path = require('path');
const agentLog = require('../../scripts/lib/agent-sessions-log.cjs');
const localTime = require('../../scripts/lib/local-time.cjs');

// ────────────────────── 参数 ──────────────────────────────────
const args = {};
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
}

if (!args.project) {
  console.error('[diagnose-run] 必须提供 --project=<业务项目根目录>');
  process.exit(1);
}

const projectRoot = path.resolve(args.project);
const skillDir = path.resolve(__dirname, '..');
const pipelineDir = path.join(projectRoot, '.pipeline');
const sessionsDir = path.join(projectRoot, '.agent-sessions');
const reportsDir  = path.join(pipelineDir, 'reports');

// ────────────────────── 工具 ──────────────────────────────────
function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function safeReadJson(p) {
  const c = safeRead(p);
  if (!c) return null;
  try { return JSON.parse(c); } catch { return null; }
}

function latestFile(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir)
    .filter(predicate || (() => true))
    .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0] || null;
}

// ────────────────────── 收集数据 ──────────────────────────────

const lines = [];
const push  = (...a) => lines.push(a.join(' '));

push('# Skill V3 运行诊断报告');
push(`生成时间: ${localTime.formatLocalTime(new Date())}`);
push(`项目根目录: ${projectRoot}`);
push('');

// 1. stages.json
push('## 1. stages.json 状态');
const stagesPath = path.join(pipelineDir, 'stages.json');
const stages = safeReadJson(stagesPath);
if (!stages) {
  push('  ❌ 未找到 .pipeline/stages.json');
} else {
  const stagesNode = stages.stages || stages;
  const STAGE_KEYS = [
    'prd', 'prd_review', 'design', 'contract', 'design_review',
    'codegen', 'typecheck', 'test', 'code_review', 'merge_push',
    'build', 'deploy', 'smoke', 'report',
  ];
  for (const key of STAGE_KEYS) {
    const s = stagesNode[key];
    if (!s) continue;
    const status   = s.status || 'unknown';
    const passed   = s.validation?.passed;
    const passTag  = passed === true ? ' ✓' : passed === false ? ' ✗' : '';
    const errMsg   = s.outputs?.error_message || s.outputs?.error || s.error || '';
    push(`  ${key.padEnd(18)} ${status}${passTag}${errMsg ? '  ← ' + String(errMsg).slice(0, 80) : ''}`);
  }
}
push('');

// 2. 最新 report 文件
push('## 2. 最新报告文件');
const latestReport = latestFile(reportsDir, f => f.endsWith('.md') && f !== 'diagnosis.md');
if (!latestReport) {
  push('  未找到报告文件');
} else {
  push(`  路径: ${latestReport.path}`);
  const content = safeRead(latestReport.path) || '';
  const reportLines = content.split('\n');
  const keyLines = reportLines.filter(l =>
    /overall|阻塞|failed|passed|error|✓|✗|❌|⚠️/i.test(l)
  ).slice(0, 20);
  if (keyLines.length) {
    push('  --- 关键行 ---');
    keyLines.forEach(l => push('  ' + l));
  } else {
    reportLines.slice(0, 30).forEach(l => push('  ' + l));
  }
}
push('');

// 3. autorun 主日志尾部
push('## 3. 最新 autorun 主日志（末尾）');
const latestLogPath = agentLog.findLatestSessionLog(projectRoot, (f) => f.endsWith('.log') && !f.includes('codegen'));
const latestLog = latestLogPath ? { path: latestLogPath } : null;
if (!latestLog) {
  push('  未找到主日志');
} else {
  push(`  路径: ${latestLog.path}`);
  const content = safeRead(latestLog.path) || '';
  const logLines = content.split('\n').filter(Boolean);
  const tail = logLines.slice(-20);
  tail.forEach(l => push('  ' + l));
}
push('');

// 4. 卡住的 codegen 会话检测
push('## 4. Codegen 会话卡住检测（阈值 15 min）');

const STUCK_MS = 15 * 60 * 1000;
const stuckSessions = [];
const runningSessions = [];

const codegenLogDirs = [
  path.join(agentLog.logsRoot(projectRoot), 'sessions'),
  sessionsDir,
];
const codegenLogFiles = [];
for (const dir of codegenLogDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const fname of fs.readdirSync(dir)) {
    if (!fname.endsWith('.log') || !fname.includes('codegen')) continue;
    codegenLogFiles.push({ fname, fpath: path.join(dir, fname) });
  }
}
if (codegenLogFiles.length) {
  for (const { fname, fpath } of codegenLogFiles) {
    const content = (safeRead(fpath) || '').trim();
    const logLines = content.split('\n').filter(Boolean);
    if (!logLines.length) continue;

    const lastLine = logLines[logLines.length - 1];
    if (/codegen end passed=/.test(lastLine)) continue;

    if (!localTime.matchLogLineTimestampPrefix(lastLine)) continue;

    const lastMs = localTime.parseLogLineTimestamp(lastLine);
    if (!Number.isFinite(lastMs)) continue;

    const ageMs = Date.now() - lastMs;

    if (/alive:|tick/.test(lastLine)) {
      const ageMin = Math.round(ageMs / 60000);
      const entry = { file: fname, ageMin, lastLine };
      if (ageMs > STUCK_MS) stuckSessions.push(entry);
      else runningSessions.push(entry);
    }
  }
} else if (fs.existsSync(sessionsDir)) {
  /* legacy-only tree with no codegen session logs */
}

if (stuckSessions.length) {
  push('  ⚠️  以下会话疑似卡住:');
  for (const s of stuckSessions) {
    push(`    [${s.ageMin} 分钟无响应] ${s.file}`);
    push(`      最后条目: ${s.lastLine.slice(0, 100)}`);
  }
} else {
  push('  ✓ 未检测到卡住的 codegen 会话');
}

if (runningSessions.length) {
  push('  运行中会话:');
  for (const s of runningSessions) {
    push(`    [${s.ageMin} 分钟前心跳] ${s.file}`);
  }
}
push('');

// 5. session-health.json（若存在）
push('## 5. session-health.json（上次 check-session-health 结果）');
const healthPath = path.join(reportsDir, 'session-health.json');
const health = safeReadJson(healthPath);
if (!health) {
  push(`  未找到（先运行 node ${path.join(skillDir, 'scripts', 'check-session-health.cjs')} --project=<PROJECT_ROOT>）`);
} else {
  push(`  时间: ${health.timestamp}`);
  push(`  总计: ${health.total}  完成: ${health.completedCount}  卡住: ${health.stuckCount}`);
  if (health.hasStuck) push('  ⚠️  上次检查发现卡住会话！');
}
push('');

const issues = [];

// 5.1 ui_e2e / Browser MCP
push('## 5.1 ui_e2e（Browser MCP / Dart MCP）');
const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
const devCfg = safeReadJson(cfgPath);
const declaredCt = new Set([
  ...(stages?.client_targets?.declared || []),
  ...(stages?.client_targets?.generated || []),
]);
const wantsUi =
  ['website', 'admin'].some((t) => declaredCt.has(t)) || declaredCt.has('mobile');
const uiOn = !!(devCfg?.ui_e2e?.enabled === true);
push(`  声明端含 web/mobile: ${wantsUi ? '是' : '否'}`);
push(`  ui_e2e.enabled: ${uiOn ? 'true' : 'false 或未配置'}`);
let scenarioCount = 0;
if (uiOn) {
  try {
    const { collectUiScenarios } = require(path.join(
      skillDir,
      '..',
      'ai-e2e3',
      'scripts',
      'lib',
      'parse-ui-scenarios.cjs'
    ));
    const { scenarios, sources } = collectUiScenarios(projectRoot, devCfg);
    scenarioCount = scenarios.length;
    push(`  ui_scenarios 数量: ${scenarioCount}（来源: ${sources.length ? sources.join(', ') : '无 yaml 契约'}）`);
  } catch (e) {
    push(`  ui_scenarios 扫描失败: ${e.message}`);
  }
}
const uiStage = stages?.stages?.ui_e2e;
if (uiStage) {
  push(`  stages.ui_e2e: ${uiStage.status} validation.passed=${uiStage.validation?.passed}`);
} else {
  push('  stages.ui_e2e: (无记录 — autorun 可能已跳过 ai-e2e3)');
}
if (wantsUi && !uiOn) {
  issues.push('未启用 ui_e2e：HTTP smoke 通过但不会做 Browser MCP 页面验收');
  push('  ⚠️  未启用 ui_e2e — 仅 HTTP smoke，无 Browser MCP 验收');
}
if (uiOn && scenarioCount === 0) {
  issues.push('ui_e2e 已启用但契约无 ui_scenarios（需 *.test-spec.yaml）');
  push('  ⚠️  无 ui_scenarios — ai-e2e3 将跳过场景执行');
}
push('');

// 6. 综合诊断结论
push('## 6. 综合诊断结论');

if (!stages) {
  issues.push('stages.json 缺失：bootstrap 未运行或项目结构有误');
} else {
  const stagesNode = stages.stages || stages;
  const failedStages = Object.entries(stagesNode)
    .filter(([, v]) => v && (v.status === 'failed' || v.validation?.passed === false))
    .map(([k]) => k);
  if (failedStages.length) {
    issues.push(`失败阶段: ${failedStages.join(', ')}`);
  }

  if (stagesNode.codegen?.status === 'running' && stuckSessions.length) {
    issues.push(`codegen 阶段仍在运行，但检测到 ${stuckSessions.length} 个卡住会话`);
  }
}

if (stuckSessions.length) {
  issues.push(`${stuckSessions.length} 个 codegen 会话无响应超过 15 分钟`);
}

if (issues.length === 0) {
  push('  ✓ 未发现明显问题（若仍异常请手动查看上方日志）');
} else {
  push('  发现以下问题:');
  issues.forEach((iss, i) => push(`    ${i + 1}. ${iss}`));
  push('');
  push('  建议操作:');
  push('    1. 若有卡住会话 → 停止 autorun → 修复 skill → 重跑 Round N+1');
  push('    2. 若阶段 failed → 查阅对应 stage.outputs.error_message → 归因 skill');
  push('    3. 改完 skill → smoke 2 轮 → commit+push → 重新 §4.A');
}
push('');
push('──────────────────────────────────────────');
push('详细数据: .pipeline/stages.json, .pipeline/reports/, .agent-sessions/');

// ────────────────────── 输出 ──────────────────────────────────
const output = lines.join('\n');
console.log(output);

try {
  fs.mkdirSync(reportsDir, { recursive: true });
  const diagPath = path.join(reportsDir, 'diagnosis.md');
  fs.writeFileSync(diagPath, output);
  console.log(`\n诊断报告已写入: ${diagPath}`);
} catch (_) { /* 不影响主流程 */ }

process.exitCode = issues.length > 0 ? 1 : 0;

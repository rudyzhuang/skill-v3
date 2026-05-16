#!/usr/bin/env node
/**
 * check-session-health.cjs  —  ai-soak3 辅助脚本
 * 检查 .agent-sessions/ 中正在运行的 codegen 会话是否卡住。
 *
 * 规范真源：~/.cursor/skills/ai-soak3/docs/spec/soak3.md §7.2
 *
 * 用法:
 *   node ~/.cursor/skills/ai-soak3/scripts/check-session-health.cjs \
 *        --project=<业务项目根目录> [--log=<log-file>] [--stuck-min=<N>]
 *
 * 选项:
 *   --project=<path>   业务项目根目录（必填）
 *   --log=<file>       指定 autorun 主日志路径（默认: 自动找最新）
 *   --stuck-min=<N>    卡住阈值（分钟，默认: 15）
 *
 * 退出码:
 *   0 = 全部正常
 *   2 = 检测到卡住的会话
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ──────────────────────── 参数解析 ───────────────────────────
const args = {};
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (arg.startsWith('--')) args[arg.slice(2)] = true;
}

if (!args.project) {
  console.error('[check-session-health] 必须提供 --project=<业务项目根目录>');
  process.exit(1);
}

const projectRoot = path.resolve(args.project);
const stuckThresholdMs = (parseInt(args['stuck-min'] || '15', 10)) * 60 * 1000;
const sessionsDir = path.join(projectRoot, '.agent-sessions');

// ──────────────────────── 工具函数 ───────────────────────────

function safeReadFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

/** 找最新的 autorun 主日志（不含 codegen 的 .log 文件） */
function findLatestAutorunLog() {
  if (!fs.existsSync(sessionsDir)) return null;
  const files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.log') && !f.includes('codegen'))
    .map(f => {
      const p = path.join(sessionsDir, f);
      return { name: f, path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].path : null;
}

/**
 * 解析 autorun 主日志，返回:
 *   spawned: { [sessionId]: { feature, spawnLine } }
 *   completed: Set<sessionId>
 *   failed: Set<sessionId>
 */
function parseAutorunLog(logPath) {
  const content = safeReadFile(logPath);
  if (!content) return { spawned: {}, completed: new Set(), failed: new Set() };

  const spawned = {};
  const completed = new Set();
  const failed = new Set();

  for (const line of content.split('\n')) {
    let m;

    // ── 旧格式: "...Z spawn ai-code3 codegen ... session=<id>"
    m = line.match(/spawn\s+ai-code3\s+codegen\s+.*?session=(\S+)/);
    if (m) {
      const sid = m[1];
      const fMatch = line.match(/(?:group=|--feature=)([\w-]+)/);
      spawned[sid] = { feature: fMatch ? fMatch[1] : 'unknown', spawnLine: line };
    }

    // ── 新格式: "[ai-auto3] code3 codegen group N begin feature=F session=S"
    m = line.match(/\[ai-auto3\]\s+code3\s+codegen\s+group\s+\S+\s+begin\s+feature=([\w-]+)\s+session=(\S+)/);
    if (m) {
      spawned[m[2]] = { feature: m[1], spawnLine: line };
    }

    // ── 旧格式完成: "...Z ai-code3 codegen group N/N done feature=F exit=0"
    m = line.match(/ai-code3\s+codegen\s+group\s+\S+\s+done\s+feature=([\w-]+)\s+exit=(\d+)/);
    if (m) {
      for (const [sid, info] of Object.entries(spawned)) {
        if (info.feature === m[1]) {
          m[2] === '0' ? completed.add(sid) : failed.add(sid);
        }
      }
    }

    // ── 新格式完成: "[ai-auto3] code3 codegen group N/N end feature=F exit=N"
    m = line.match(/\[ai-auto3\]\s+code3\s+codegen\s+group\s+\S+\s+end\s+feature=([\w-]+)\s+exit=(\d+)/);
    if (m) {
      for (const [sid, info] of Object.entries(spawned)) {
        if (info.feature === m[1]) {
          m[2] === '0' ? completed.add(sid) : failed.add(sid);
        }
      }
    }

    // ── 新格式 exec end: "[ai-auto3] exec end: ... --feature=F ... exit=N"
    m = line.match(/\[ai-auto3\]\s+exec\s+end:.*?--feature=([\w-]+).*?exit=(\d+)/);
    if (m) {
      for (const [sid, info] of Object.entries(spawned)) {
        if (info.feature === m[1]) {
          m[2] === '0' ? completed.add(sid) : failed.add(sid);
        }
      }
    }
  }

  return { spawned, completed, failed };
}

/**
 * 检查单个 codegen 会话日志，判断是否卡住
 * 返回 { status, lastTime, ageMs, lastEntry }
 * status: 'completed' | 'failed' | 'stuck' | 'running' | 'no_log' | 'unknown'
 */
function checkSessionLog(sessionId) {
  const logPath = path.join(sessionsDir, `${sessionId}.log`);
  const content = safeReadFile(logPath);
  if (!content) return { status: 'no_log', lastTime: null, ageMs: null, lastEntry: null };

  const lines = content.trim().split('\n').filter(Boolean);
  if (!lines.length) return { status: 'empty', lastTime: null, ageMs: null, lastEntry: null };

  const lastLine = lines[lines.length - 1];

  // 已完成的标志
  if (/codegen end passed=/.test(lastLine) || /codegen end:/.test(lastLine)) {
    return { status: 'completed', lastTime: null, ageMs: null, lastEntry: lastLine };
  }
  // 失败标志
  if (/\berror\b/.test(lastLine) || /exit=[^0]/.test(lastLine) || /\bfailed\b/.test(lastLine)) {
    return { status: 'failed', lastTime: null, ageMs: null, lastEntry: lastLine };
  }

  // 解析最后时间戳
  const timeM = lastLine.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/);
  if (!timeM) return { status: 'unknown', lastTime: null, ageMs: null, lastEntry: lastLine };

  const lastTime = new Date(timeM[1]).getTime();
  const ageMs = Date.now() - lastTime;

  if (/alive:/.test(lastLine) || /\btick\b/.test(lastLine)) {
    const status = ageMs > stuckThresholdMs ? 'stuck' : 'running';
    return { status, lastTime, ageMs, lastEntry: lastLine };
  }

  return { status: 'unknown', lastTime, ageMs, lastEntry: lastLine };
}

// ──────────────────────── 主流程 ─────────────────────────────

const logFile = args.log ? path.resolve(args.log) : findLatestAutorunLog();
if (!logFile) {
  console.error('[check-session-health] 未找到 autorun 日志，请用 --log= 指定，或确认项目的 .agent-sessions/ 存在');
  process.exit(1);
}

console.log(`[check-session-health] 分析日志: ${logFile}`);
console.log(`[check-session-health] 卡住阈值: ${stuckThresholdMs / 60000} 分钟\n`);

const { spawned, completed, failed } = parseAutorunLog(logFile);
const total = Object.keys(spawned).length;

const report = {
  timestamp: new Date().toISOString(),
  logFile,
  stuckThresholdMin: stuckThresholdMs / 60000,
  total,
  completedCount: completed.size,
  failedCount: failed.size,
  stuckCount: 0,
  runningCount: 0,
  sessions: [],
};

const stuckSessions = [];

for (const [sid, info] of Object.entries(spawned)) {
  if (completed.has(sid)) {
    report.sessions.push({ sessionId: sid, feature: info.feature, status: 'completed' });
    continue;
  }
  if (failed.has(sid)) {
    report.sessions.push({ sessionId: sid, feature: info.feature, status: 'failed' });
    continue;
  }

  const health = checkSessionLog(sid);
  const entry = { sessionId: sid, feature: info.feature, ...health };

  if (health.status === 'stuck') {
    report.stuckCount++;
    entry.stuckMinutes = Math.round(health.ageMs / 60000);
    stuckSessions.push(entry);
  } else if (health.status === 'running') {
    report.runningCount++;
    entry.lastHeartbeatMinAgo = Math.round(health.ageMs / 60000);
  }

  report.sessions.push(entry);
}

report.hasStuck = report.stuckCount > 0;

// ── 打印摘要
console.log('=== Session 健康报告 ===');
console.log(`总会话数  : ${total}`);
console.log(`已完成    : ${report.completedCount}`);
console.log(`失败      : ${report.failedCount}`);
console.log(`运行中    : ${report.runningCount}`);
console.log(`卡住      : ${report.stuckCount}`);
console.log('');

for (const s of report.sessions) {
  const flag =
    s.status === 'stuck'     ? '⚠️  卡住' :
    s.status === 'running'   ? '⏳ 运行中' :
    s.status === 'completed' ? '✅ 完成' :
    s.status === 'failed'    ? '❌ 失败' :
    s.status === 'no_log'    ? '❓ 无日志' : `❓ ${s.status}`;
  let extra = '';
  if (s.status === 'stuck') extra = `  ← 最后心跳 ${s.stuckMinutes} 分钟前`;
  if (s.status === 'running') extra = `  ← 最后心跳 ${s.lastHeartbeatMinAgo} 分钟前`;
  console.log(`  ${flag}  ${s.feature.padEnd(20)} session=${s.sessionId}${extra}`);
}
console.log('');

if (report.hasStuck) {
  const skillDir = path.resolve(__dirname, '..');
  console.log('⚠️  ==================================================');
  console.log('⚠️  检测到卡住的 codegen 会话！');
  console.log('⚠️  建议操作:');
  console.log('⚠️    1. 立即停止 autorun 进程');
  console.log(`⚠️    2. 运行 node ${path.join(skillDir, 'scripts', 'diagnose-run.cjs')} --project=<PROJECT_ROOT>`);
  console.log('⚠️    3. 归因（cursor-agent 超时？网络？skill 脚本 bug？）');
  console.log('⚠️    4. 修复对应 skill，重新从 §4.A 开始 Round N+1');
  console.log('⚠️  ==================================================');
} else {
  console.log('✓ 无卡住会话');
}

// ── 写 JSON 报告（写到业务项目的 .pipeline/reports/）
try {
  const reportsDir = path.join(projectRoot, '.pipeline', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, 'session-health.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n详细报告: ${reportPath}`);
} catch (_) { /* 不影响退出码 */ }

process.exitCode = report.hasStuck ? 2 : 0;

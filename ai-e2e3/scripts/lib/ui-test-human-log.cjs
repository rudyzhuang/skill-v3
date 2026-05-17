'use strict';

const fs = require('fs');
const path = require('path');
const { logTimestamp, formatLocalTime } = require('../../../scripts/lib/local-time.cjs');

function safeSegment(id, maxLen = 80) {
  const s = String(id || '').trim();
  const out = s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, maxLen);
  return out || 'unknown';
}

/** 日志文件名用：YYYY-MM-DD_HHmmss_SSS（本地时区） */
function datetimeForFilename(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`;
}

function uiTestFeatureDir(projectRoot, featureId) {
  return path.join(projectRoot, '.agent-sessions', 'ui-test', safeSegment(featureId));
}

function actionLabel(action) {
  const a = String(action || '').toLowerCase();
  const map = {
    navigate: '打开页面',
    click: '点击',
    fill: '填写',
    press_key: '按键',
    wait: '等待',
    snapshot: '快照',
    scroll: '滚动',
    drag: '拖动',
    swipe: '滑动',
  };
  return map[a] || a || '操作';
}

function formatStepsHuman(steps) {
  const lines = [];
  for (let i = 0; i < (steps || []).length; i += 1) {
    const s = steps[i];
    const act = actionLabel(s.action);
    const parts = [`${i + 1}. ${act}`];
    if (s.url) parts.push(`→ ${s.url}`);
    if (s.ref) parts.push(`目标「${s.ref}」`);
    if (s.value != null && s.value !== '') parts.push(`值「${String(s.value).slice(0, 80)}」`);
    lines.push(parts.join(' '));
  }
  return lines.length ? lines.join('\n') : '（无步骤）';
}

function formatExpectHuman(expects) {
  const lines = [];
  for (const ex of expects || []) {
    lines.push(`- ${ex.type || 'assert'}: ${ex.value != null ? ex.value : ''}`);
  }
  return lines.length ? lines.join('\n') : '（无断言）';
}

function describeTestTool({ stub, platform, executor, skipAgent }) {
  if (executor) return executor;
  if (platform === 'web') {
    if (stub || skipAgent) return 'HTTP 校验（stub，非 Browser MCP）';
    return 'Cursor Browser MCP（cursor-ide-browser）';
  }
  if (platform === 'android' || platform === 'ios') {
    if (stub || skipAgent) return 'Flutter 设备门闸 + integration_test / smoke_run（stub）';
    return 'Dart MCP（user-dart）';
  }
  return '未知';
}

function describeTestTarget(scenario, { baseUrl, deviceId, bundleId }) {
  const platform = String(scenario.platform || 'web').toLowerCase();
  if (platform === 'web') {
    const nav = (scenario.steps || []).find((s) => String(s.action).toLowerCase() === 'navigate');
    const url = nav?.url || baseUrl || '（未解析 URL）';
    const ct = scenario.client_target || 'website';
    return `网页（${ct}）— ${url.replace('{base_url}', baseUrl || '{base_url}')}`;
  }
  if (platform === 'android') {
    const bid = bundleId ? `，包名 ${bundleId}` : '';
    return `Android 应用 — 设备/模拟器 ${deviceId || '（未指定）'}${bid}`;
  }
  if (platform === 'ios') {
    const bid = bundleId ? `，Bundle ID ${bundleId}` : '';
    return `iOS 应用 — 模拟器/设备 ${deviceId || '（未指定）'}${bid}`;
  }
  return platform;
}

function createWriter(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const rel = (p) => p;

  function append(rawLine) {
    const line = rawLine.endsWith('\n') ? rawLine : `${rawLine}\n`;
    fs.appendFileSync(logPath, `[${logTimestamp()}] ${line}`, 'utf8');
  }

  function appendSection(title) {
    append('');
    append(`── ${title} ──`);
  }

  return { logPath, append, appendSection, rel };
}

/**
 * 初始化人话日志（脚本层写入测试概要；Agent 执行中追加截图与步骤说明）。
 * @returns {{ logPath: string, screenshotDir: string, writer: object, featureId: string }}
 */
function beginHumanLog(projectRoot, scenario, meta = {}) {
  const featureId = scenario.feature_id || 'unknown';
  const screenshotDir = uiTestFeatureDir(projectRoot, featureId);
  fs.mkdirSync(screenshotDir, { recursive: true });
  const dt = datetimeForFilename();
  const logPath = path.join(screenshotDir, `${dt}.log`);
  const writer = createWriter(logPath);

  writer.appendSection('测试概要');
  writer.append(`场景 ID：${scenario.id}`);
  writer.append(`feature_id：${featureId}`);
  writer.append(`测试用例（步骤）：\n${formatStepsHuman(scenario.steps)}`);
  writer.append(`验收断言：\n${formatExpectHuman(scenario.expect)}`);
  writer.append(`测试工具：${describeTestTool(meta)}`);
  writer.append(`测试对象：${describeTestTarget(scenario, meta)}`);
  if (meta.client_target) writer.append(`端：${meta.client_target} / ${meta.platform || ''}`);

  writer.appendSection('执行记录');
  writer.append(
    '说明：真机/MCP 测试时须在下列时机截图（.jpg），保存到本 feature 目录，并在本日志记录截图绝对路径：'
  );
  writer.append('  · 打开 app 或页面后');
  writer.append('  · 点击或跳转后');
  writer.append('  · 拖动、滑动等其他交互后');

  return { logPath, screenshotDir, writer, featureId, datetime: dt };
}

function finalizeHumanLog(writer, result, extra = {}) {
  if (!writer) return;
  writer.appendSection('测试结果');
  writer.append(`结果：${result.passed ? '通过 ✓' : '失败 ✗'}`);
  if (result.duration_ms != null) writer.append(`耗时：${result.duration_ms} ms`);
  if (result.error) writer.append(`错误：${result.error}`);
  if (result.step_failed) writer.append(`失败步骤：${result.step_failed}`);
  if (result.executor) writer.append(`执行器：${result.executor}`);

  const shots = extra.screenshots || [];
  if (shots.length) {
    writer.appendSection('截图清单');
    for (const s of shots) {
      const p = s.path || s;
      const moment = s.moment || s.label || '';
      writer.append(`- ${moment ? `[${moment}] ` : ''}${p}`);
    }
  } else if (extra.stubNoScreenshots) {
    writer.append('（stub/脚本模式：未执行 MCP，无 UI 截图）');
  }

  writer.append(`日志文件：${writer.logPath}`);
  writer.append(`结束时间：${formatLocalTime(new Date())}`);
}

/** 合并 Agent 输出 JSON 中的 screenshots[] */
function screenshotsFromAgentJson(agentJsonPath) {
  if (!agentJsonPath || !fs.existsSync(agentJsonPath)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(agentJsonPath, 'utf8'));
    if (!Array.isArray(j.screenshots)) return [];
    return j.screenshots.map((s) =>
      typeof s === 'string' ? { path: s, moment: '' } : { path: s.path || '', moment: s.moment || s.label || '' }
    );
  } catch {
    return [];
  }
}

/** 扫描 feature 目录下本轮测试产生的 jpg（按 mtime 倒序，可选 sinceMs） */
function listScreenshotsInDir(dir, sinceMs = 0) {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.jpe?g$/i.test(f))
    .map((f) => {
      const abs = path.join(dir, f);
      const st = fs.statSync(abs);
      return { path: abs, mtime: st.mtimeMs, name: f };
    })
    .filter((x) => !sinceMs || x.mtime >= sinceMs)
    .sort((a, b) => a.mtime - b.mtime);
  return files.map((x) => ({ path: x.path, moment: x.name }));
}

module.exports = {
  safeSegment,
  datetimeForFilename,
  uiTestFeatureDir,
  beginHumanLog,
  finalizeHumanLog,
  describeTestTool,
  describeTestTarget,
  formatStepsHuman,
  screenshotsFromAgentJson,
  listScreenshotsInDir,
};

'use strict';

/**
 * run-dash.cjs — ai-std4 流水线状态 TUI 看板
 *
 * 调用形态：
 *   node ai-std4/scripts/run-dash.cjs \
 *     --project=<业务项目根绝对路径> \
 *     [--tail=50]           # 日志面板显示末 N 行（默认 50）
 *     [--auto-launched]     # 由 run-pipeline.cjs 自动拉起时传入
 *
 * 项目路径解析优先级：
 *   1. --project=<路径>
 *   2. 环境变量 AI_STD4_PROJECT
 *   3. process.cwd()
 *
 * 退出码：
 *   0  正常退出
 *   1  stages.json 不存在（项目未初始化）
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── 参数解析 ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    })
);

const projectRoot = args.project
  ? path.resolve(String(args.project))
  : process.env.AI_STD4_PROJECT
    ? path.resolve(process.env.AI_STD4_PROJECT)
    : process.cwd();

const tailLines = Math.max(10, parseInt(String(args.tail || '50'), 10) || 50);

// ── 路径常量 ──────────────────────────────────────────────────────
const pipelineDir        = path.join(projectRoot, '.pipeline');
const stagesJsonPath     = path.join(pipelineDir, 'stages.json');
const stopSignalPath     = path.join(pipelineDir, 'stop.signal');
const stopPipelineScript = path.join(__dirname, 'stop-pipeline.cjs');

// ── 校验：stages.json 必须存在 ────────────────────────────────────
if (!fs.existsSync(stagesJsonPath)) {
  process.stderr.write(
    `[run-dash] 未找到已初始化的 std4 项目：${stagesJsonPath}\n` +
    `  请先运行 setup：node ai-std4/scripts/run-pipeline.cjs --project=${projectRoot}\n`
  );
  process.exit(1);
}

// ── 常量：stage 顺序 ──────────────────────────────────────────────
const STAGE_ORDER = [
  'setup', 'prd', 'prd-review',
  'design', 'design-review', 'create-ui-scenarios', 'codegen',
  'code-review', 'merge_push', 'build', 'deploy', 'ui_e2e', 'report',
];

// ── 辅助函数 ──────────────────────────────────────────────────────

/** 读取 stages.json，失败时返回 null */
function readStagesJson() {
  try {
    return JSON.parse(fs.readFileSync(stagesJsonPath, 'utf8'));
  } catch (_) { return null; }
}

/** 格式化毫秒为 MM:SS 或 HH:MM:SS */
function formatElapsed(ms) {
  const totalS = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 获取 stage 状态图标 */
function getStageIcon(status) {
  switch (status) {
    case 'completed':          return '✓';
    case 'running':            return '⟳';
    case 'failed':             return '✗';
    case 'skipped':            return '↷';
    case 'stopped':            return '◈';
    case 'started':            return '⟳';
    case 'pending_user_input': return '⚠';
    default:                   return '○';
  }
}

/**
 * 从 stages.json 识别当前正在运行的 stage
 * 优先找 status=running，否则用 pipeline.current_stage
 */
function getCurrentStage(stagesData) {
  if (!stagesData) return null;
  const stages = stagesData.stages || {};
  const running = Object.entries(stages).find(([, s]) => s && s.status === 'running');
  if (running) return running[0];
  return stagesData.pipeline && stagesData.pipeline.current_stage
    ? String(stagesData.pipeline.current_stage)
    : null;
}

/**
 * 从 stages.json 推导当前 stage 的日志文件路径
 * datetime = 流水线启动时间，格式 YYYY-MM-DD_HH-mm-ss
 */
function getLogFilePath(stagesData, stageName) {
  if (!stageName) return null;

  let datetime = null;

  // 优先从 run_id 提取（格式：YYYY-MM-DD_HH-mm-ss-<8hex>）
  const runId = stagesData && stagesData.pipeline && stagesData.pipeline.run_id;
  if (runId && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.test(runId)) {
    datetime = runId.replace(/-[0-9a-f]{8}$/, '');
  }

  // 从 pipeline.started_at 推导（格式：YYYY-MM-DD HH:mm:ss 或带时区）
  if (!datetime) {
    const startedAt = stagesData && stagesData.pipeline && stagesData.pipeline.started_at;
    if (startedAt) {
      const m = String(startedAt).match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
      if (m) datetime = `${m[1]}_${m[2]}-${m[3]}-${m[4]}`;
    }
  }

  if (!datetime) return null;
  return path.join(projectRoot, 'logs', 'stages', stageName, `${datetime}.log`);
}

// ── TTY / CI fallback 判断 ────────────────────────────────────────
// 非 TTY 或 CI 环境降级为纯文本输出
const useTUI = (
  process.stdout.isTTY === true &&
  !process.env.CI &&
  !process.env.NO_COLOR
);

// ══════════════════════════════════════════════════════════════════
// ── 降级文本模式（非 TTY / CI / NO_COLOR）────────────────────────
// ══════════════════════════════════════════════════════════════════
function runFallbackMode() {
  function printStatus() {
    const data = readStagesJson();
    if (!data) {
      process.stdout.write('[run-dash] stages.json 读取失败\n');
      return;
    }

    const now         = new Date();
    const projectName = (data.pipeline && data.pipeline.project && data.pipeline.project.name)
      || path.basename(projectRoot);
    process.stdout.write(
      `\n=== ai-std4 流水线状态 [${now.toLocaleString('zh-CN')}] 项目: ${projectName} ===\n`
    );

    const stages = data.stages || {};
    for (const stageName of STAGE_ORDER) {
      const stageKey = stageName.replace(/-/g, '_');
      const s        = stages[stageName] || stages[stageKey] || {};
      const status   = s.status || 'pending';
      const icon     = getStageIcon(status);

      let elapsed = '';
      if (status === 'running' && s.started_at) {
        const startMs = new Date(s.started_at).getTime();
        if (!isNaN(startMs)) elapsed = ` [${formatElapsed(now - startMs)}]`;
      } else if (s.completed_at && s.started_at) {
        const startMs    = new Date(s.started_at).getTime();
        const completeMs = new Date(s.completed_at).getTime();
        if (!isNaN(startMs) && !isNaN(completeMs)) {
          elapsed = ` [${formatElapsed(completeMs - startMs)}]`;
        }
      }

      process.stdout.write(`  ${icon} ${stageName.padEnd(22)} ${status}${elapsed}\n`);
    }

    if (fs.existsSync(stopSignalPath)) {
      process.stdout.write('  ⚠ stop.signal 存在，流水线正在停止...\n');
    }

    const currentSt = getCurrentStage(data);
    if (currentSt) process.stdout.write(`  当前阶段: ${currentSt}\n`);
  }

  printStatus();
  const interval = setInterval(printStatus, 3000);

  const cleanup = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ══════════════════════════════════════════════════════════════════
// ── TUI 模式（blessed）────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
function runTUIMode() {
  // 动态加载 blessed（安装失败则降级）
  let blessed;
  try {
    blessed = require('blessed');
  } catch (e) {
    process.stderr.write(
      `[run-dash] blessed 模块加载失败，降级为文本模式\n  ${e.message}\n`
    );
    runFallbackMode();
    return;
  }

  // ── 运行时状态 ─────────────────────────────────────────────────
  let stagesData      = readStagesJson();
  let logLines        = [];
  let logFileOffset   = 0;
  let currentLogFile  = null;
  let stopping        = false;
  let dialogOpen      = false;
  const dashStartedAt = new Date();

  // 定时器 & watcher 句柄（提前声明供 cleanup() 引用）
  let logInterval    = null;
  let timerInterval  = null;
  let stagesDebounce = null;
  let stagesWatcher  = null;
  let pipelineDirWatch = null;

  // ── blessed screen ─────────────────────────────────────────────
  let screen;
  try {
    screen = blessed.screen({
      smartCSR:     true,
      title:        'ai-std4 流水线看板',
      fullUnicode:  true,
      forceUnicode: true,
      useBCE:       true,
    });
  } catch (e) {
    process.stderr.write(
      `[run-dash] blessed.screen() 创建失败，降级为文本模式\n  ${e.message}\n`
    );
    runFallbackMode();
    return;
  }

  // ── Header（顶部信息栏）────────────────────────────────────────
  const headerBox = blessed.box({
    parent: screen,
    top:    0,
    left:   0,
    width:  '100%',
    height: 3,
    border: { type: 'line' },
    style:  {
      fg:     'white',
      bg:     'blue',
      border: { fg: 'cyan' },
    },
    tags: true,
  });

  // ── 阶段状态面板（左侧）───────────────────────────────────────
  const stagesBox = blessed.box({
    parent:       screen,
    top:          3,
    left:         0,
    width:        32,
    height:       '100%-6',
    border:       { type: 'line' },
    label:        ' 阶段状态 ',
    scrollable:   true,
    alwaysScroll: true,
    style:        {
      fg:     'white',
      border: { fg: 'cyan' },
      label:  { fg: 'cyan' },
    },
    tags: true,
  });

  // ── 日志面板（右侧）───────────────────────────────────────────
  const logBox = blessed.box({
    parent:       screen,
    top:          3,
    left:         32,
    width:        '100%-32',
    height:       '100%-6',
    border:       { type: 'line' },
    label:        ` 当前阶段日志（末 ${tailLines} 行） `,
    scrollable:   true,
    alwaysScroll: true,
    scrollbar:    { ch: ' ', track: { bg: 'black' }, style: { inverse: true } },
    mouse:        true,
    style:        {
      fg:     'green',
      border: { fg: 'cyan' },
      label:  { fg: 'cyan' },
    },
    tags:    false,
    wrap:    true,
  });

  // ── Footer（底部按键提示）─────────────────────────────────────
  const footerBox = blessed.box({
    parent: screen,
    bottom: 0,
    left:   0,
    width:  '100%',
    height: 3,
    border: { type: 'line' },
    style:  {
      fg:     'white',
      border: { fg: 'cyan' },
    },
    tags: true,
  });

  // ── 内部辅助：读取新日志行 ─────────────────────────────────────
  function refreshLogFile() {
    const cs         = getCurrentStage(stagesData);
    const newLogFile = getLogFilePath(stagesData, cs);

    if (newLogFile !== currentLogFile) {
      currentLogFile = newLogFile;
      logFileOffset  = 0;
      logLines       = [];
    }

    if (!currentLogFile || !fs.existsSync(currentLogFile)) return;

    try {
      const stat = fs.statSync(currentLogFile);
      if (stat.size <= logFileOffset) return;

      const readLen = stat.size - logFileOffset;
      const buf     = Buffer.alloc(readLen);
      const fd      = fs.openSync(currentLogFile, 'r');
      fs.readSync(fd, buf, 0, readLen, logFileOffset);
      fs.closeSync(fd);
      logFileOffset = stat.size;

      const newLines = buf.toString('utf8').split('\n').filter(l => l.trim());
      logLines.push(...newLines);

      // 防止内存无限增长，保留 tailLines * 3 行
      if (logLines.length > tailLines * 3) {
        logLines = logLines.slice(-tailLines * 2);
      }
    } catch (_) { /* ignore */ }
  }

  // ── 渲染：标题栏 ──────────────────────────────────────────────
  function renderHeader() {
    const projectName = (
      stagesData && stagesData.pipeline &&
      stagesData.pipeline.project &&
      stagesData.pipeline.project.name
    ) || path.basename(projectRoot);

    const startStr = dashStartedAt.toLocaleString('zh-CN');
    headerBox.setContent(
      `  {bold}ai-std4 流水线看板{/bold}` +
      `  项目: {cyan-fg}${projectName}{/cyan-fg}` +
      `  启动: ${startStr}`
    );
  }

  // ── 渲染：阶段状态列表 ────────────────────────────────────────
  function renderStages() {
    const stages    = (stagesData && stagesData.stages) || {};
    const currentSt = getCurrentStage(stagesData);
    const now       = Date.now();
    const lines     = [];

    for (const stageName of STAGE_ORDER) {
      const stageKey = stageName.replace(/-/g, '_');
      const s        = stages[stageName] || stages[stageKey] || {};
      const status   = s.status || 'pending';
      const icon     = getStageIcon(status);
      const isActive = (stageName === currentSt);

      let elapsed = '';
      if ((status === 'running' || status === 'started') && s.started_at) {
        const startMs = new Date(s.started_at).getTime();
        if (!isNaN(startMs)) elapsed = formatElapsed(now - startMs);
      } else if (s.completed_at && s.started_at) {
        const startMs    = new Date(s.started_at).getTime();
        const completeMs = new Date(s.completed_at).getTime();
        if (!isNaN(startMs) && !isNaN(completeMs)) {
          elapsed = formatElapsed(completeMs - startMs);
        }
      }

      let iconColor;
      switch (status) {
        case 'completed': iconColor = '{green-fg}';   break;
        case 'running':
        case 'started':   iconColor = '{yellow-fg}';  break;
        case 'failed':    iconColor = '{red-fg}';     break;
        case 'skipped':   iconColor = '{cyan-fg}';    break;
        case 'stopped':   iconColor = '{magenta-fg}'; break;
        default:          iconColor = '{gray-fg}';    break;
      }

      const namePart    = stageName.padEnd(18);
      const elapsedPart = elapsed ? ` ${elapsed}` : '';
      const activeMark  = isActive ? ' {yellow-fg}←{/yellow-fg}' : '';
      // {/} 关闭所有颜色标签，兼容性更好
      lines.push(`${iconColor}${icon}{/} ${namePart}${elapsedPart}${activeMark}`);
    }

    stagesBox.setContent(lines.join('\n'));
  }

  // ── 渲染：日志面板 ────────────────────────────────────────────
  function renderLog() {
    const tail = logLines.slice(-tailLines);
    logBox.setContent(tail.join('\n'));
    logBox.setScrollPerc(100);
  }

  // ── 渲染：底部状态栏 ──────────────────────────────────────────
  function renderFooter() {
    const stopExists = fs.existsSync(stopSignalPath);
    if (stopExists || stopping) {
      footerBox.style.bg = 'red';
      footerBox.setContent(
        '  {white-fg}{bold}⚠ 停止信号已发送，等待当前步骤完成...{/bold}{/white-fg}' +
        '                      {bold}[Q]{/bold} 退出看板'
      );
    } else {
      footerBox.style.bg = undefined;
      footerBox.setContent(
        '  {bold}[S]{/bold} 停止流水线   {bold}[R]{/bold} 刷新   ' +
        '{bold}[↑/↓]{/bold} 滚动日志   {bold}[PgUp/PgDn]{/bold} 翻页   ' +
        '{bold}[Q]{/bold} 退出看板'
      );
    }
  }

  // ── 主渲染入口 ────────────────────────────────────────────────
  function render() {
    renderHeader();
    renderStages();
    renderLog();
    renderFooter();
    screen.render();
  }

  // ── 清理函数（关闭所有句柄，防止进程挂起）────────────────────
  let cleanupCalled = false;
  function cleanup() {
    if (cleanupCalled) return;
    cleanupCalled = true;

    clearInterval(logInterval);
    clearInterval(timerInterval);
    clearTimeout(stagesDebounce);

    if (stagesWatcher)    { try { stagesWatcher.close();    } catch (_) {} }
    if (pipelineDirWatch) { try { pipelineDirWatch.close(); } catch (_) {} }

    try { screen.destroy(); } catch (_) {}
    process.exit(0);
  }

  // SIGTERM → 安静退出（run-pipeline teardown 会发此信号）
  process.once('SIGTERM', cleanup);

  // ── 停止流水线（写 stop.signal）──────────────────────────────
  function triggerStop() {
    if (fs.existsSync(stopPipelineScript)) {
      try {
        const result = spawnSync(
          process.execPath,
          [stopPipelineScript, `--project=${projectRoot}`, '--reason=user_request'],
          { env: process.env, stdio: 'pipe' }
        );
        if (result.status === 0) return;
      } catch (_) { /* fall through */ }
    }

    // Fallback：直接写 stop.signal
    try {
      const signal = {
        requested_at: new Date().toLocaleString('zh-CN'),
        reason:       'user_request',
        requested_by: 'run-dash',
      };
      fs.writeFileSync(stopSignalPath, JSON.stringify(signal, null, 2) + '\n', 'utf8');
    } catch (_) { /* ignore */ }
  }

  // ── 停止确认对话框 ────────────────────────────────────────────
  function showStopConfirmDialog() {
    if (dialogOpen || stopping) return;
    dialogOpen = true;

    const currentSt = getCurrentStage(stagesData) || '(未知)';

    const dialog = blessed.box({
      parent: screen,
      top:    'center',
      left:   'center',
      width:  52,
      height: 10,
      border: { type: 'line' },
      label:  ' 确认停止流水线 ',
      style:  {
        fg:     'white',
        bg:     'black',
        border: { fg: 'yellow' },
        label:  { fg: 'yellow' },
      },
      tags:  true,
      keys:  true,
      mouse: true,
      content: [
        '',
        '  {bold}确认停止流水线？{/bold}',
        `  当前阶段：{yellow-fg}${currentSt}{/yellow-fg}（运行中）`,
        `  停止后可用 --from-stage=${currentSt} 续跑`,
        '',
        '     {bold}[Y]{/bold} 确认停止    {bold}[N]{/bold} 取消',
        '',
      ].join('\n'),
    });

    function closeDialog() {
      dialogOpen = false;
      dialog.destroy();
      render();
    }

    dialog.key(['y', 'Y'], () => {
      closeDialog();
      stopping = true;
      renderFooter();
      screen.render();
      triggerStop();
    });

    dialog.key(['n', 'N', 'escape'], () => {
      closeDialog();
    });

    dialog.focus();
    screen.render();
  }

  // ── 键盘事件绑定 ──────────────────────────────────────────────
  screen.key(['q', 'Q', 'C-c'], () => {
    // 退出看板但不停止流水线
    cleanup();
  });

  screen.key(['s', 'S'], () => {
    if (dialogOpen) return;
    showStopConfirmDialog();
  });

  screen.key(['r', 'R'], () => {
    if (dialogOpen) return;
    const newData = readStagesJson();
    if (newData) {
      stagesData    = newData;
      logFileOffset = 0;
      logLines      = [];
    }
    refreshLogFile();
    render();
  });

  screen.key(['up'], () => {
    if (dialogOpen) return;
    logBox.scroll(-1);
    screen.render();
  });

  screen.key(['down'], () => {
    if (dialogOpen) return;
    logBox.scroll(1);
    screen.render();
  });

  screen.key(['pageup'], () => {
    if (dialogOpen) return;
    logBox.scroll(-Math.max(1, logBox.height - 1));
    screen.render();
  });

  screen.key(['pagedown'], () => {
    if (dialogOpen) return;
    logBox.scroll(Math.max(1, logBox.height - 1));
    screen.render();
  });

  // ── fs.watch：监听 stages.json 变更（100ms 防抖）──────────────
  try {
    stagesWatcher = fs.watch(stagesJsonPath, () => {
      clearTimeout(stagesDebounce);
      stagesDebounce = setTimeout(() => {
        const newData = readStagesJson();
        if (newData) {
          stagesData = newData;
          refreshLogFile();
          render();
        }
      }, 100);
    });
  } catch (_) { /* 文件暂不可 watch，忽略 */ }

  // ── fs.watch：监听 .pipeline 目录（检测 stop.signal 创建/删除）
  try {
    pipelineDirWatch = fs.watch(pipelineDir, (eventType, filename) => {
      if (filename === 'stop.signal') {
        renderFooter();
        screen.render();
      }
    });
  } catch (_) { /* 忽略 */ }

  // ── setInterval：每 500ms 追读日志 ───────────────────────────
  logInterval = setInterval(() => {
    refreshLogFile();
    renderLog();
    screen.render();
  }, 500);

  // ── setInterval：每秒刷新 running stage 耗时 ─────────────────
  timerInterval = setInterval(() => {
    renderStages();
    screen.render();
  }, 1000);

  // ── 初始渲染 ─────────────────────────────────────────────────
  refreshLogFile();
  render();
}

// ── 入口分发 ──────────────────────────────────────────────────────
if (useTUI) {
  runTUIMode();
} else {
  runFallbackMode();
}

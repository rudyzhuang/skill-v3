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

const FEATURE_STAGES = [
  'design', 'design-review', 'create-ui-scenarios', 'codegen', 'code-review', 'ui_e2e',
];

const PARALLEL_TRACKS = [
  ['design', 'design-review'],
  ['codegen', 'create-ui-scenarios'],
];

const ROLLUP_COLUMNS = [
  { stage: 'design', abbrev: 'D' },
  { stage: 'codegen', abbrev: 'C' },
  { stage: 'ui_e2e', abbrev: 'E' },
];

const FEATURE_STATUS_ORDER = {
  running: 0,
  started: 0,
  pending_dep: 1,
  pending: 2,
  failed: 3,
  stopped: 4,
  crashed: 5,
  completed: 6,
  skipped: 7,
};

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

const STAGES_PANEL_WIDTH  = 28;
const FEATURES_PANEL_WIDTH = 36;
const LOG_PANEL_LEFT      = STAGES_PANEL_WIDTH + FEATURES_PANEL_WIDTH;

// ── 辅助函数 ──────────────────────────────────────────────────────

/** 读取 stages.json，失败时返回 null */
function readStagesJson() {
  try {
    return JSON.parse(fs.readFileSync(stagesJsonPath, 'utf8'));
  } catch (_) { return null; }
}

function getStageRecord(stages, stageName) {
  if (!stages) return {};
  return stages[stageName] || stages[stageName.replace(/-/g, '_')] || {};
}

/** stages.json 中 stage 键名可能是 code_review 或 code-review */
function normalizeStageKey(name) {
  if (!name) return '';
  return String(name).replace(/_/g, '-');
}

function sameStage(a, b) {
  return normalizeStageKey(a) === normalizeStageKey(b);
}

/** 映射到 FEATURE_STAGES 中的规范名（连字符） */
function canonicalFeatureStage(name) {
  const norm = normalizeStageKey(name);
  const hit = FEATURE_STAGES.find(s => normalizeStageKey(s) === norm);
  return hit || norm;
}

/** ui_e2e 按 scenario 聚合为 feature 级状态（stages.ui_e2e 无 features 表） */
function aggregateUiE2eFeatureStatuses(stagesData) {
  const prdFeatures = getPrdFeatures(stagesData);
  const scenarios   = getStageRecord(stagesData && stagesData.stages, 'ui_e2e').scenarios || {};
  const out         = {};
  for (const f of prdFeatures) {
    out[f.feature_id] = { status: 'pending' };
  }
  const byFeature = {};
  for (const sc of Object.values(scenarios)) {
    const fid = sc && sc.feature_id;
    if (!fid) continue;
    if (!byFeature[fid]) byFeature[fid] = [];
    byFeature[fid].push(sc.status || 'pending');
  }
  for (const [fid, statuses] of Object.entries(byFeature)) {
    if (statuses.some(s => s === 'running' || s === 'started')) {
      out[fid] = { status: 'running' };
    } else if (statuses.some(s => s === 'failed' || s === 'timed_out')) {
      out[fid] = { status: 'failed' };
    } else if (statuses.length > 0 && statuses.every(s => s === 'completed' || s === 'skipped')) {
      out[fid] = { status: 'completed' };
    }
  }
  return out;
}

function getStageFeaturesForDash(stagesData, trackStage) {
  if (normalizeStageKey(trackStage) === 'ui-e2e') {
    return aggregateUiE2eFeatureStatuses(stagesData);
  }
  return getStageRecord(stagesData && stagesData.stages, trackStage).features || {};
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

function getFeatureIcon(status) {
  switch (status) {
    case 'completed':   return '✓';
    case 'running':
    case 'started':     return '⟳';
    case 'failed':      return '✗';
    case 'skipped':     return '↷';
    case 'stopped':     return '◈';
    case 'pending_dep': return '⏳';
    case 'crashed':     return '⚡';
    default:            return '○';
  }
}

function abbrevFeatureStatus(status) {
  if (!status || status === 'pending') return '○';
  return getFeatureIcon(status);
}

function shortGroupId(groupId) {
  if (!groupId) return '';
  const m = String(groupId).match(/(\d+)$/);
  return m ? `G${m[1]}` : String(groupId).slice(0, 4);
}

function getPipelineDatetime(stagesData) {
  const runId = stagesData && stagesData.pipeline && stagesData.pipeline.run_id;
  if (runId && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.test(runId)) {
    return runId.replace(/-[0-9a-f]{8}$/, '');
  }
  const startedAt = stagesData && stagesData.pipeline && stagesData.pipeline.started_at;
  if (startedAt) {
    const m = String(startedAt).match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (m) return `${m[1]}_${m[2]}-${m[3]}-${m[4]}`;
  }
  return null;
}

/**
 * 从 stages.json 识别当前正在运行的 stage
 * 优先找 status=running，否则用 pipeline.current_stage
 */
function getCurrentStage(stagesData) {
  if (!stagesData) return null;
  const stages = stagesData.stages || {};
  const running = Object.entries(stages).find(([, s]) => s && (s.status === 'running' || s.status === 'started'));
  if (running) return running[0];
  return stagesData.pipeline && stagesData.pipeline.current_stage
    ? String(stagesData.pipeline.current_stage)
    : null;
}

function getPrdFeatures(stagesData) {
  const prd = getStageRecord(stagesData && stagesData.stages, 'prd');
  return (prd.outputs && prd.outputs.features) || [];
}

function getRunningFeatureStages(stagesData) {
  const stages = (stagesData && stagesData.stages) || {};
  return FEATURE_STAGES.filter((name) => {
    const st = getStageRecord(stages, name).status;
    return st === 'running' || st === 'started';
  });
}

function getParallelTrackGroup(stageName) {
  const norm = normalizeStageKey(stageName);
  for (const group of PARALLEL_TRACKS) {
    if (group.some(s => normalizeStageKey(s) === norm)) return group;
  }
  return [canonicalFeatureStage(stageName)];
}

/**
 * stages.json 刷新后是否应自动切换 feature 跟踪阶段。
 * 同一并行组内保留用户 [F] 手动选择的 track；跨组时跟随流水线当前阶段。
 */
function shouldAdvanceTrackStage(trackStage, autoTrack) {
  if (sameStage(trackStage, autoTrack)) return false;
  const group = getParallelTrackGroup(trackStage);
  return !group.some(s => sameStage(s, autoTrack));
}

function pickDefaultTrackStage(stagesData) {
  const running = getRunningFeatureStages(stagesData);
  const prefer = ['codegen', 'create-ui-scenarios', 'design', 'design-review', 'code-review', 'ui_e2e'];
  for (const name of prefer) {
    if (running.includes(name)) return name;
  }
  const current = getCurrentStage(stagesData);
  if (current) {
    const canon = canonicalFeatureStage(current);
    if (FEATURE_STAGES.includes(canon)) return canon;
  }
  const stages = (stagesData && stagesData.stages) || {};
  for (let i = FEATURE_STAGES.length - 1; i >= 0; i--) {
    const name = FEATURE_STAGES[i];
    const s = getStageRecord(stages, name);
    if (s.features && Object.keys(s.features).length > 0) return name;
  }
  return 'codegen';
}

function useFeatureDetailView(stagesData) {
  if (getRunningFeatureStages(stagesData).length > 0) return true;
  const current = getCurrentStage(stagesData);
  if (current && FEATURE_STAGES.includes(current)) return true;
  const stages = (stagesData && stagesData.stages) || {};
  return FEATURE_STAGES.some((name) => {
    const s = getStageRecord(stages, name);
    return s.features && Object.keys(s.features).length > 0;
  });
}

function sortPrdFeatures(prdFeatures, stageFeatures) {
  return [...prdFeatures].sort((a, b) => {
    const sa = (stageFeatures[a.feature_id] || {}).status || 'pending';
    const sb = (stageFeatures[b.feature_id] || {}).status || 'pending';
    const pa = FEATURE_STATUS_ORDER[sa] ?? 99;
    const pb = FEATURE_STATUS_ORDER[sb] ?? 99;
    if (pa !== pb) return pa - pb;
    const pra = PRIORITY_ORDER[a.priority] ?? 9;
    const prb = PRIORITY_ORDER[b.priority] ?? 9;
    if (pra !== prb) return pra - prb;
    return a.feature_id.localeCompare(b.feature_id);
  });
}

function countFeatureStatuses(prdFeatures, stageFeatures) {
  const counts = {
    completed: 0, running: 0, pending: 0, failed: 0,
    skipped: 0, pending_dep: 0, crashed: 0, stopped: 0,
  };
  for (const f of prdFeatures) {
    let st = (stageFeatures[f.feature_id] || {}).status || 'pending';
    if (st === 'started') st = 'running';
    if (counts[st] !== undefined) counts[st]++;
    else counts.pending++;
  }
  return counts;
}

function computeHeaderFeatureStats(stagesData, trackStage) {
  const prdFeatures = getPrdFeatures(stagesData);
  const total = prdFeatures.length;
  if (total === 0) return { completed: 0, total: 0, inflight: 0 };
  const stageFeatures = getStageFeaturesForDash(stagesData, trackStage);
  let completed = 0;
  let inflight = 0;
  for (const f of prdFeatures) {
    const st = (stageFeatures[f.feature_id] || {}).status;
    if (st === 'completed') completed++;
    if (st === 'running' || st === 'started' || st === 'pending_dep' || st === 'crashed') inflight++;
  }
  return { completed, total, inflight };
}

function featureElapsedMs(feat, now) {
  if (!feat || !feat.started_at) return null;
  const startMs = new Date(feat.started_at).getTime();
  if (isNaN(startMs)) return null;
  if (feat.completed_at) {
    const endMs = new Date(feat.completed_at).getTime();
    if (!isNaN(endMs)) return endMs - startMs;
  }
  if (feat.status === 'running' || feat.status === 'started') return now - startMs;
  return null;
}

function buildFeatureSuffix(stagesData, trackStage, featureId, feat) {
  const parts = [];
  const gid = feat.group_id || feat.groupId;
  if (gid) parts.push(shortGroupId(gid));
  if (feat.status === 'skipped' && feat.skip_reason) {
    parts.push(String(feat.skip_reason).slice(0, 8));
  } else if (feat.status === 'skipped') {
    parts.push('skip');
  }
  if (trackStage === 'design-review' || trackStage === 'design_review') {
    if (feat.can_enter_codegen) {
      const codegenFeat = (getStageRecord(stagesData.stages, 'codegen').features || {})[featureId];
      const cgSt = codegenFeat && codegenFeat.status;
      if (!cgSt || cgSt === 'pending') parts.push('→codegen');
    }
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * 日志路径：stage 或 feature
 */
function getLogFilePath(stagesData, { stageName, featureId } = {}) {
  const datetime = getPipelineDatetime(stagesData);
  if (!datetime) return null;
  if (featureId) {
    return path.join(projectRoot, 'logs', 'features', featureId, `${datetime}.log`);
  }
  if (!stageName) return null;
  return path.join(projectRoot, 'logs', 'stages', stageName, `${datetime}.log`);
}

function findNewestLogInDir(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    if (files.length === 0) return null;
    files.sort();
    return path.join(dir, files[files.length - 1]);
  } catch (_) {
    return null;
  }
}

function resolveLogFilePath(stagesData, { trackStage, selectedFeatureId } = {}) {
  if (selectedFeatureId) {
    const exact = getLogFilePath(stagesData, { featureId: selectedFeatureId });
    if (exact && fs.existsSync(exact)) return exact;
    const dir = path.join(projectRoot, 'logs', 'features', selectedFeatureId);
    return findNewestLogInDir(dir) || exact;
  }
  const stageName = trackStage || getCurrentStage(stagesData);
  const exact = getLogFilePath(stagesData, { stageName });
  if (exact && fs.existsSync(exact)) return exact;
  if (stageName) {
    const dir = path.join(projectRoot, 'logs', 'stages', stageName);
    return findNewestLogInDir(dir) || exact;
  }
  return null;
}

// ── TTY / CI fallback 判断 ────────────────────────────────────────
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
    const trackStage  = pickDefaultTrackStage(data);
    const stats       = computeHeaderFeatureStats(data, trackStage);

    process.stdout.write(
      `\n=== ai-std4 流水线状态 [${now.toLocaleString('zh-CN')}] 项目: ${projectName} ===\n`
    );
    if (stats.total > 0) {
      process.stdout.write(
        `  Feature [${trackStage}]: ${stats.completed}/${stats.total} 完成 · 在途 ${stats.inflight}\n`
      );
    }

    const stages = data.stages || {};
    for (const stageName of STAGE_ORDER) {
      const s        = getStageRecord(stages, stageName);
      const status   = s.status || 'pending';
      const icon     = getStageIcon(status);

      let elapsed = '';
      if ((status === 'running' || status === 'started') && s.started_at) {
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

    if (useFeatureDetailView(data)) {
      const prdFeatures = getPrdFeatures(data);
      const stageFeatures = getStageFeaturesForDash(data, trackStage);
      const sorted = sortPrdFeatures(prdFeatures, stageFeatures).slice(0, 12);
      if (sorted.length > 0) {
        process.stdout.write(`\n  --- features [${trackStage}] ---\n`);
        for (const f of sorted) {
          const feat = stageFeatures[f.feature_id] || {};
          const st = feat.status || '—';
          const icon = st === '—' ? '—' : getFeatureIcon(st);
          process.stdout.write(`  ${icon} ${f.feature_id} ${st}\n`);
        }
        if (prdFeatures.length > 12) {
          process.stdout.write(`  ... +${prdFeatures.length - 12} more\n`);
        }
      }
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

  let stagesData         = readStagesJson();
  let logLines           = [];
  let logFileOffset      = 0;
  let currentLogFile     = null;
  let stopping           = false;
  let dialogOpen         = false;
  let stopDialogBox      = null;
  let stopDialogConfirm  = null;
  let stopDialogCancel   = null;
  let trackStage         = pickDefaultTrackStage(stagesData);
  let selectedFeatureId  = null;
  let featureHighlight   = 0;
  let focusPanel         = 'features';
  let displayFeatureIds  = [];
  const dashStartedAt    = new Date();

  let logInterval    = null;
  let timerInterval  = null;
  let stagesDebounce = null;
  let stagesWatcher  = null;
  let pipelineDirWatch = null;

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

  const headerBox = blessed.box({
    parent: screen,
    top:    0,
    left:   0,
    width:  '100%',
    height: 3,
    border: { type: 'line' },
    style:  { fg: 'white', bg: 'blue', border: { fg: 'cyan' } },
    tags:   true,
  });

  const stagesBox = blessed.box({
    parent:       screen,
    top:          3,
    left:         0,
    width:        STAGES_PANEL_WIDTH,
    height:       '100%-6',
    border:       { type: 'line' },
    label:        ' 阶段状态 ',
    scrollable:   true,
    alwaysScroll: true,
    style:        { fg: 'white', border: { fg: 'cyan' }, label: { fg: 'cyan' } },
    tags:         true,
  });

  const featuresBox = blessed.box({
    parent:       screen,
    top:          3,
    left:         STAGES_PANEL_WIDTH,
    width:        FEATURES_PANEL_WIDTH,
    height:       '100%-6',
    border:       { type: 'line' },
    label:        ' Feature 状态 ',
    scrollable:   true,
    alwaysScroll: true,
    scrollbar:    { ch: ' ', track: { bg: 'black' }, style: { inverse: true } },
    style:        { fg: 'white', border: { fg: 'cyan' }, label: { fg: 'cyan' } },
    tags:         true,
  });

  const logBox = blessed.box({
    parent:       screen,
    top:          3,
    left:         LOG_PANEL_LEFT,
    width:        `100%-${LOG_PANEL_LEFT}`,
    height:       '100%-6',
    border:       { type: 'line' },
    label:        ` 日志（末 ${tailLines} 行） `,
    scrollable:   true,
    alwaysScroll: true,
    scrollbar:    { ch: ' ', track: { bg: 'black' }, style: { inverse: true } },
    mouse:        true,
    style:        { fg: 'green', border: { fg: 'cyan' }, label: { fg: 'cyan' } },
    tags:         false,
    wrap:         true,
  });

  const footerBox = blessed.box({
    parent: screen,
    bottom: 0,
    left:   0,
    width:  '100%',
    height: 3,
    border: { type: 'line' },
    style:  { fg: 'white', border: { fg: 'cyan' } },
    tags:   true,
  });

  function resetLogBuffer() {
    logFileOffset = 0;
    logLines      = [];
    currentLogFile = null;
  }

  function refreshLogFile() {
    const newLogFile = resolveLogFilePath(stagesData, { trackStage, selectedFeatureId });

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

      if (logLines.length > tailLines * 3) {
        logLines = logLines.slice(-tailLines * 2);
      }
    } catch (_) { /* ignore */ }
  }

  function updateFeaturesLabel() {
    const detail = useFeatureDetailView(stagesData);
    const suffix = detail ? `[${trackStage}]` : '[汇总]';
    featuresBox.setLabel(` Feature 状态 ${suffix} `);
  }

  function updateLogLabel() {
    let src;
    if (selectedFeatureId) {
      src = `feature/${selectedFeatureId}`;
    } else {
      const st = trackStage || getCurrentStage(stagesData) || '?';
      src = `stage/${st}`;
    }
    logBox.setLabel(` 日志（末 ${tailLines} 行） 源: ${src} `);
  }

  function renderHeader() {
    const projectName = (
      stagesData && stagesData.pipeline &&
      stagesData.pipeline.project &&
      stagesData.pipeline.project.name
    ) || path.basename(projectRoot);

    const startStr = dashStartedAt.toLocaleString('zh-CN');
    const stats    = computeHeaderFeatureStats(stagesData, trackStage);
    let featPart   = '';
    if (stats.total > 0) {
      featPart = `   Feature: {cyan-fg}${stats.completed}/${stats.total}{/cyan-fg} · 在途 ${stats.inflight}`;
    }

    headerBox.setContent(
      `  {bold}ai-std4 流水线看板{/bold}` +
      `  项目: {cyan-fg}${projectName}{/cyan-fg}` +
      `  启动: ${startStr}${featPart}`
    );
  }

  function renderStages() {
    const stages    = (stagesData && stagesData.stages) || {};
    const currentSt = getCurrentStage(stagesData);
    const now       = Date.now();
    const lines     = [];

    for (const stageName of STAGE_ORDER) {
      const s        = getStageRecord(stages, stageName);
      const status   = s.status || 'pending';
      const icon     = getStageIcon(status);
      const isActive = sameStage(stageName, currentSt);

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
        case 'completed': iconColor = '{green-fg}'; break;
        case 'running':
        case 'started':   iconColor = '{yellow-fg}'; break;
        case 'failed':    iconColor = '{red-fg}'; break;
        case 'skipped':   iconColor = '{cyan-fg}'; break;
        case 'stopped':   iconColor = '{magenta-fg}'; break;
        default:          iconColor = '{gray-fg}'; break;
      }

      const namePart    = stageName.length > 16 ? `${stageName.slice(0, 14)}…` : stageName.padEnd(16);
      const elapsedPart = elapsed ? ` ${elapsed}` : '';
      const activeMark  = isActive ? ' {yellow-fg}←{/yellow-fg}' : '';
      lines.push(`${iconColor}${icon}{/} ${namePart}${elapsedPart}${activeMark}`);
    }

    stagesBox.setContent(lines.join('\n'));
  }

  function renderFeatures() {
    updateFeaturesLabel();
    const prdFeatures = getPrdFeatures(stagesData);
    const now         = Date.now();
    const lines       = [];

    if (prdFeatures.length === 0) {
      lines.push('{gray-fg}(无 prd.outputs.features){/gray-fg}');
      displayFeatureIds = [];
      featuresBox.setContent(lines.join('\n'));
      return;
    }

    if (!useFeatureDetailView(stagesData)) {
      lines.push('{gray-fg}跨阶段汇总 D=design C=codegen E=ui_e2e{/gray-fg}');
      displayFeatureIds = [];
      const stages = stagesData.stages || {};
      for (const f of prdFeatures) {
        const cols = ROLLUP_COLUMNS.map(({ stage, abbrev }) => {
          const feat = (getStageRecord(stages, stage).features || {})[f.feature_id];
          const st = feat ? feat.status : null;
          return `${abbrev}${abbrevFeatureStatus(st)}`;
        }).join(' ');
        const fid = f.feature_id.length > 22 ? `${f.feature_id.slice(0, 20)}…` : f.feature_id;
        lines.push(`${fid.padEnd(22)} ${cols}`);
      }
      featuresBox.setContent(lines.join('\n'));
      return;
    }

    const stageFeatures = getStageFeaturesForDash(stagesData, trackStage);
    const sorted        = sortPrdFeatures(prdFeatures, stageFeatures);
    displayFeatureIds   = sorted.map(f => f.feature_id);

    if (featureHighlight >= displayFeatureIds.length) {
      featureHighlight = Math.max(0, displayFeatureIds.length - 1);
    }

    const counts = countFeatureStatuses(prdFeatures, stageFeatures);
    lines.push(
      `{gray-fg}✓${counts.completed} ⟳${counts.running} ○${counts.pending} ` +
      `✗${counts.failed} ↷${counts.skipped} ⏳${counts.pending_dep}{/gray-fg}`
    );
    lines.push('');

    sorted.forEach((f, idx) => {
      const fid  = f.feature_id;
      const feat = stageFeatures[fid] || {};
      const st   = feat.status || '—';
      const icon = st === '—' ? '—' : getFeatureIcon(st);

      let iconColor = '{gray-fg}';
      if (st === 'completed') iconColor = '{green-fg}';
      else if (st === 'running' || st === 'started') iconColor = '{yellow-fg}';
      else if (st === 'failed') iconColor = '{red-fg}';
      else if (st === 'skipped') iconColor = '{cyan-fg}';
      else if (st === 'pending_dep') iconColor = '{blue-fg}';
      else if (st === 'crashed') iconColor = '{red-fg}';

      const elapsedMs = featureElapsedMs(feat, now);
      const elapsed   = elapsedMs != null ? ` ${formatElapsed(elapsedMs)}` : '';
      const suffix    = buildFeatureSuffix(stagesData, trackStage, fid, feat);

      const idDisplay = fid.length > 20 ? `${fid.slice(0, 18)}…` : fid;
      const isSelected = selectedFeatureId === fid;
      const isHighlight = idx === featureHighlight && focusPanel === 'features';

      let prefix = '  ';
      if (isSelected) prefix = '{cyan-fg}▸{/cyan-fg} ';
      else if (isHighlight) prefix = '{bold}>{/bold} ';

      let row = `${prefix}${iconColor}${icon}{/} ${idDisplay}${elapsed}${suffix}`;
      if (isHighlight && focusPanel === 'features') row = `{inverse}${row}{/inverse}`;
      lines.push(row);
    });

    if (sorted.length > 0) {
      lines.push('');
      lines.push('{gray-fg}(↑/↓ 滚动 · Enter 选中日志){/gray-fg}');
    }

    featuresBox.setContent(lines.join('\n'));
    if (focusPanel === 'features' && !dialogOpen) featuresBox.focus();
  }

  function renderLog() {
    updateLogLabel();
    const tail = logLines.slice(-tailLines);
    logBox.setContent(tail.join('\n'));
    logBox.setScrollPerc(100);
  }

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
        '  {bold}[S]{/bold} 停止  {bold}[R]{/bold} 刷新  {bold}[F]{/bold} 切换 track  ' +
        '{bold}[Tab]{/bold} 焦点  {bold}[↑/↓]{/bold} 滚动  {bold}[Enter]{/bold} 选中 feature  ' +
        '{bold}[Q]{/bold} 退出'
      );
    }
  }

  function render() {
    renderHeader();
    renderStages();
    renderFeatures();
    renderLog();
    renderFooter();
    screen.render();
  }

  let cleanupCalled = false;
  function cleanup() {
    if (cleanupCalled) return;
    cleanupCalled = true;

    clearInterval(logInterval);
    clearInterval(timerInterval);
    clearTimeout(stagesDebounce);

    if (stagesWatcher) { try { stagesWatcher.close(); } catch (_) {} }
    if (pipelineDirWatch) { try { pipelineDirWatch.close(); } catch (_) {} }

    try { screen.destroy(); } catch (_) {}
    process.exit(0);
  }

  process.once('SIGTERM', cleanup);

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

    try {
      const signal = {
        requested_at: new Date().toLocaleString('zh-CN'),
        reason:       'user_request',
        requested_by: 'run-dash',
      };
      fs.writeFileSync(stopSignalPath, JSON.stringify(signal, null, 2) + '\n', 'utf8');
    } catch (_) { /* ignore */ }
  }

  function dismissStopDialog() {
    dialogOpen = false;
    stopDialogConfirm = null;
    stopDialogCancel  = null;
    if (stopDialogBox) {
      stopDialogBox.destroy();
      stopDialogBox = null;
    }
  }

  function showStopConfirmDialog() {
    if (dialogOpen || stopping) return;
    dialogOpen = true;

    const currentSt = getCurrentStage(stagesData) || '(未知)';

    stopDialogBox = blessed.box({
      parent:  screen,
      top:     'center',
      left:    'center',
      width:   52,
      height:  10,
      border:  { type: 'line' },
      label:   ' 确认停止流水线 ',
      style:   { fg: 'white', bg: 'black', border: { fg: 'yellow' }, label: { fg: 'yellow' } },
      tags:    true,
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

    stopDialogCancel = () => {
      dismissStopDialog();
      render();
    };

    stopDialogConfirm = () => {
      dismissStopDialog();
      stopping = true;
      renderFooter();
      triggerStop();
      render();
    };

    screen.render();
  }

  function cycleTrack() {
    const group = getParallelTrackGroup(trackStage);
    if (group.length <= 1) return;
    const idx = group.indexOf(trackStage);
    trackStage = group[(idx + 1) % group.length];
    resetLogBuffer();
    if (!selectedFeatureId) refreshLogFile();
  }

  function cycleFocus() {
    if (dialogOpen) return;
    const order = ['stages', 'features', 'log'];
    const idx = order.indexOf(focusPanel);
    focusPanel = order[(idx + 1) % order.length];
    if (focusPanel === 'features') featuresBox.focus();
    else if (focusPanel === 'log') logBox.focus();
    else stagesBox.focus();
    renderFeatures();
    screen.render();
  }

  function scrollFocused(delta) {
    if (focusPanel === 'log') {
      logBox.scroll(delta);
    } else if (focusPanel === 'features') {
      if (displayFeatureIds.length === 0) return;
      featureHighlight = Math.max(0, Math.min(displayFeatureIds.length - 1, featureHighlight + delta));
      featuresBox.scroll(delta);
      renderFeatures();
    } else {
      stagesBox.scroll(delta);
    }
    screen.render();
  }

  function toggleFeatureLogSelection() {
    if (displayFeatureIds.length === 0) return;
    const fid = displayFeatureIds[featureHighlight];
    if (selectedFeatureId === fid) {
      selectedFeatureId = null;
    } else {
      selectedFeatureId = fid;
    }
    resetLogBuffer();
    refreshLogFile();
    render();
  }

  screen.key(['q', 'Q', 'C-c'], () => {
    cleanup();
  });

  screen.key(['s', 'S'], () => {
    if (dialogOpen) return;
    showStopConfirmDialog();
  });

  screen.key(['y', 'Y'], () => {
    if (!dialogOpen || !stopDialogConfirm) return;
    stopDialogConfirm();
  });

  screen.key(['n', 'N', 'escape'], () => {
    if (!dialogOpen || !stopDialogCancel) return;
    stopDialogCancel();
  });

  screen.key(['r', 'R'], () => {
    if (dialogOpen) return;
    const newData = readStagesJson();
    if (newData) {
      stagesData = newData;
      trackStage = pickDefaultTrackStage(stagesData);
      resetLogBuffer();
    }
    refreshLogFile();
    render();
  });

  screen.key(['f', 'F'], () => {
    if (dialogOpen) return;
    cycleTrack();
    render();
  });

  screen.key(['tab'], () => {
    if (dialogOpen) return;
    cycleFocus();
  });

  screen.key(['enter'], () => {
    if (dialogOpen) return;
    if (focusPanel === 'features' || displayFeatureIds.length > 0) {
      focusPanel = 'features';
      toggleFeatureLogSelection();
    }
  });

  screen.key(['up'], () => {
    if (dialogOpen) return;
    scrollFocused(-1);
  });

  screen.key(['down'], () => {
    if (dialogOpen) return;
    scrollFocused(1);
  });

  screen.key(['pageup'], () => {
    if (dialogOpen) return;
    const step = Math.max(1, (focusPanel === 'log' ? logBox.height : featuresBox.height) - 1);
    scrollFocused(-step);
  });

  screen.key(['pagedown'], () => {
    if (dialogOpen) return;
    const step = Math.max(1, (focusPanel === 'log' ? logBox.height : featuresBox.height) - 1);
    scrollFocused(step);
  });

  try {
    stagesWatcher = fs.watch(stagesJsonPath, () => {
      clearTimeout(stagesDebounce);
      stagesDebounce = setTimeout(() => {
        const newData = readStagesJson();
        if (newData) {
          stagesData = newData;
          const autoTrack = pickDefaultTrackStage(stagesData);
          if (shouldAdvanceTrackStage(trackStage, autoTrack)) {
            trackStage = autoTrack;
            if (!selectedFeatureId) resetLogBuffer();
          }
          refreshLogFile();
          render();
        }
      }, 100);
    });
  } catch (_) { /* ignore */ }

  try {
    pipelineDirWatch = fs.watch(pipelineDir, (eventType, filename) => {
      if (filename === 'stop.signal') {
        renderFooter();
        screen.render();
      }
    });
  } catch (_) { /* ignore */ }

  logInterval = setInterval(() => {
    refreshLogFile();
    renderLog();
    screen.render();
  }, 500);

  timerInterval = setInterval(() => {
    renderHeader();
    renderStages();
    renderFeatures();
    screen.render();
  }, 1000);

  featuresBox.focus();
  refreshLogFile();
  render();
}

if (useTUI) {
  runTUIMode();
} else {
  runFallbackMode();
}

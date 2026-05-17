'use strict';

const OVERALL_LABEL = {
  running: '运行中（ai-auto3）',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  blocked: '阻塞',
  idle: '空闲',
};

const FEATURE_LABEL = {
  pending: '待处理',
  in_progress: '处理中',
  completed: '已完成',
  failed: '失败',
  deferred: '延期',
};

const STAGE_DISPLAY = {
  merge_push: 'merge-push',
};

function displayStage(k) {
  if (STAGE_DISPLAY[k]) return STAGE_DISPLAY[k];
  return String(k || '').replace(/_/g, '-');
}

function $(id) {
  return document.getElementById(id);
}

let registryProjects = [];
let currentProjectRoot = '';
let lastDashboard = null;
let featureFilter = 'all';
let timer = null;

async function fetchJson(url, options) {
  const r = await fetch(url, { cache: 'no-store', ...options });
  const data = await r.json();
  if (!r.ok && r.status !== 207) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  const hr = Math.floor(min / 60);
  return `${hr} 时 ${min % 60} 分`;
}

function formatLocalTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

let serveMeta = { pid: null, host: '127.0.0.1', port: null };

function updateStopButtons(dash) {
  const restartBtn = $('restartServeBtn');
  const serveBtn = $('stopServeBtn');
  const pipeBtn = $('stopPipelineBtn');
  if (restartBtn) {
    restartBtn.disabled = false;
    const port = serveMeta.port || window.location.port || '9473';
    const pid = serveMeta.pid != null ? serveMeta.pid : '—';
    restartBtn.title = `停止并重启当前 ai-dash3 serve（${serveMeta.host || '127.0.0.1'}:${port}，PID ${pid}），加载最新代码`;
  }
  if (serveBtn) {
    serveBtn.disabled = false;
    const port = serveMeta.port || window.location.port || '9473';
    const pid = serveMeta.pid != null ? serveMeta.pid : '—';
    serveBtn.title = `停止当前 ai-dash3 serve（${serveMeta.host || '127.0.0.1'}:${port}，PID ${pid}）`;
  }
  if (pipeBtn) {
    pipeBtn.disabled = !currentProjectRoot;
    const stoppable = !!(dash && dash.pipeline_stoppable);
    pipeBtn.title = stoppable
      ? '停止该项目的 autorun、ai-code3、cursor-agent 等（经 ai-auto3 stop-pipeline）'
      : '未检测到运行中进程；仍可尝试清理 pipeline 锁与 registry';
  }
}

function setBanner(overall, dash) {
  const el = $('statusBanner');
  const lock = dash.summary?.pid_lock;
  let extra = '';
  if (lock?.present && lock.alive) {
    extra = ` · pipeline 锁 PID=${lock.pid}`;
  } else if (lock?.present && lock.alive === false) {
    extra = ' · 锁文件残留（进程已退出）';
  }
  if (dash.registry_stale_run) {
    extra += ' · registry 有未结束 run（进程可能已退出，可点「停止任务后台」清理）';
  } else if (dash.autorun_active) {
    extra += ' · autorun 运行中';
  }
  if (dash.active_codegen_feature_id) {
    extra += ` · 当前 codegen：${dash.active_codegen_feature_id}`;
  }
  if (dash.generated_at) {
    extra += ` · 刷新于 ${formatLocalTime(dash.generated_at)}`;
  }
  el.className = `status-banner overall-${overall || 'idle'}`;
  el.textContent = `${OVERALL_LABEL[overall] || overall}${extra}`;
}

function fillKv(dl, pairs) {
  dl.innerHTML = '';
  for (const [k, v] of pairs) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v == null || v === '' ? '—' : String(v);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
}

function renderRuntime(dash) {
  const rt = dash.runtime || {};
  fillKv($('runtimeDl'), [
    ['autorun 活跃', dash.autorun_active ? '是' : '否'],
    ['PID 锁存活', dash.pid_lock_alive ? '是' : '否'],
    ['runtime 僵尸 run', dash.registry_stale_run ? '是（建议停止任务后台）' : '否'],
    ['runtime 未结束 run', dash.registry_run_active ? '是' : '否'],
    ['后台进程数', (dash.processes || []).length],
    ['当前 codegen feature', dash.active_codegen_feature_id || '—'],
    ['当前 phase', rt.current_phase],
    ['当前 stage', rt.current_stage],
    ['pending 数量', (rt.pending_features || []).length],
    ['active_run_id', rt.active_run_id],
    ['runtime 更新', rt.updated_at],
    ...(dash.processes || [])
      .slice(0, 5)
      .map((p, i) => [
        `进程 ${i + 1}`,
        `${p.kind} pid=${p.pid} ${p.status}${p.exit_code != null ? ` exit=${p.exit_code}` : ''}`,
      ]),
  ]);
}

function renderSummary(dash) {
  const s = dash.summary || {};
  const p = s.pipeline || {};
  fillKv($('summaryDl'), [
    ['项目名', dash.project_name || dash.project_id],
    ['project_id', dash.project_id],
    ['current_stage', p.current_stage],
    ['last_completed', p.last_completed_stage],
    ['pipeline 更新', p.updated_at],
    ['项目根', dash.project_root],
  ]);
}

function renderFeatures(dash, filterStatus) {
  if (filterStatus !== undefined) featureFilter = filterStatus || 'all';
  const board = $('featureBoard');
  const tabs = $('featureTabs');
  const feats = dash.features || [];
  const statuses = ['all', 'in_progress', 'pending', 'completed', 'failed', 'deferred'];

  tabs.innerHTML = '';
  for (const st of statuses) {
    const count =
      st === 'all' ? feats.length : feats.filter((f) => f.pipeline_status === st).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `${st === 'all' ? '全部' : FEATURE_LABEL[st] || st} (${count})`;
    btn.classList.toggle('active', st === featureFilter);
    btn.addEventListener('click', () => renderFeatures(dash, st));
    tabs.appendChild(btn);
  }

  board.innerHTML = '';
  const list =
    featureFilter === 'all' ? feats : feats.filter((f) => f.pipeline_status === featureFilter);

  if (!list.length) {
    board.innerHTML = '<p class="empty">暂无 feature（检查 prd_review.phase_plan）</p>';
    return;
  }

  for (const f of list) {
    const card = document.createElement('article');
    card.className = 'feature-card';
    card.dataset.status = f.pipeline_status;
    const stageLine = escapeHtml(f.pipeline_stage_label || displayStage(f.pipeline_stage) || '—');
    const startedLine = escapeHtml(formatLocalTime(f.stage_started_at));
    const elapsedLine = escapeHtml(formatDuration(f.stage_elapsed_ms));
    card.innerHTML = `
      <div class="fid">${escapeHtml(f.feature_id)}</div>
      ${f.name ? `<div class="meta">${escapeHtml(f.name)}</div>` : ''}
      <div class="meta">phase: ${escapeHtml(f.phase)}${f.client_target ? ` · ${escapeHtml(f.client_target)}` : ''}${f.priority_tier != null ? ` · P${f.priority_tier}` : ''}</div>
      <div class="meta feature-stage">阶段: <strong>${stageLine}</strong></div>
      <div class="meta feature-timing">开始: ${startedLine} · 已运行: ${elapsedLine}</div>
      <span class="badge badge-${f.pipeline_status}">${FEATURE_LABEL[f.pipeline_status] || f.pipeline_status}</span>
    `;
    board.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStages(dash) {
  const tbody = $('stageTable').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = dash.summary?.rows || [];
  for (const r of rows) {
    const tr = document.createElement('tr');
    const st = r.status || '—';
    if (st === 'failed') tr.classList.add('stage-failed');
    else if (st === 'completed') tr.classList.add('stage-completed');
    else if (st === 'running' || st === 'in_progress') tr.classList.add('stage-in_progress');
    const v =
      r.validation_passed === true ? 'ok' : r.validation_passed === false ? 'no' : '—';
    tr.innerHTML = `<td>${displayStage(r.stage)}</td><td class="status">${escapeHtml(st)}</td><td>${v}</td>`;
    tbody.appendChild(tr);
  }
}

function renderBlockers(dash) {
  const ul = $('blockersList');
  const blockers = dash.summary?.blockers || [];
  ul.innerHTML = '';
  if (!blockers.length) {
    ul.innerHTML = '<li class="empty">无阻塞</li>';
    return;
  }
  for (const b of blockers) {
    const li = document.createElement('li');
    li.textContent = `[${b.code}] ${b.message}`;
    ul.appendChild(li);
  }
  $('suggestedNext').textContent = dash.summary?.suggested_next || '—';
  const reports = dash.summary?.reports || [];
  const rpt = $('reportsList');
  rpt.innerHTML = '';
  if (!reports.length) rpt.innerHTML = '<li class="empty">无报告文件</li>';
  else {
    for (const f of reports) {
      const li = document.createElement('li');
      li.textContent = `.pipeline/reports/${f}`;
      rpt.appendChild(li);
    }
  }
}

function renderRuns(dash) {
  const tbody = $('runsTable').querySelector('tbody');
  tbody.innerHTML = '';
  const runs = dash.recent_runs || [];
  if (!runs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">无 registry 记录（先跑 ai-auto3 sync-registry）</td></tr>';
    return;
  }
  for (const run of runs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${escapeHtml(run.run_id || '')}</td>
      <td>${escapeHtml(run.started_at || '—')}</td>
      <td>${escapeHtml(run.ended_at || '—')}</td>
      <td>${run.exit_code != null ? run.exit_code : '—'}</td>
      <td>${escapeHtml(run.stopped_at_stage || '—')}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadRegistry() {
  const reg = await fetchJson('/api/registry');
  registryProjects = reg.projects || [];
  const sel = $('projectSelect');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 选择项目 —</option>';
  for (const p of registryProjects) {
    const opt = document.createElement('option');
    opt.value = p.root_path;
    const tag = p.autorun_active ? ' ●' : '';
    const label = p.project_name || p.project_id || p.root_path;
    opt.textContent = `${label}${tag}`;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
  if (!reg.ok) {
    console.warn('registry:', reg.error);
  }
  return reg;
}

async function loadDashboard() {
  const root = $('projectPath').value.trim();
  if (!root) {
    $('statusBanner').className = 'status-banner overall-idle';
    $('statusBanner').textContent = '请输入或选择项目绝对路径';
    return;
  }
  currentProjectRoot = root;
  try {
    const dash = await fetchJson(`/api/dashboard?project=${encodeURIComponent(root)}`);
    lastDashboard = dash;
    updateStopButtons(dash);
    setBanner(dash.overall, dash);
    renderRuntime(dash);
    renderSummary(dash);
    renderFeatures(dash);
    renderStages(dash);
    renderBlockers(dash);
    renderRuns(dash);
  } catch (e) {
    lastDashboard = null;
    updateStopButtons(null);
    $('statusBanner').className = 'status-banner overall-failed';
    $('statusBanner').innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`;
  }
}

async function restartServe() {
  const port = serveMeta.port || window.location.port || '9473';
  const host = serveMeta.host || window.location.hostname || '127.0.0.1';
  const pid = serveMeta.pid != null ? serveMeta.pid : '（见终端）';
  if (
    !window.confirm(
      `确定重启当前看板后台？\n\n将关闭并重新启动本页面对应的 ai-dash3 serve：\n${host}:${port}（PID ${pid}）\n\n后台将以相同参数重启以加载最新代码，页面将在新后台启动后自动刷新。`
    )
  ) {
    return;
  }
  const btn = $('restartServeBtn');
  btn.disabled = true;
  btn.textContent = '重启中…';
  if (timer) clearInterval(timer);
  timer = null;
  try {
    await fetchJson('/api/restart-serve', { method: 'POST' });
  } catch {
    /* 连接断开是正常现象 */
  }
  const baseUrl = `${window.location.protocol}//${host}:${port}`;
  const maxAttempts = 20;
  let attempts = 0;
  const poll = async () => {
    attempts++;
    try {
      const r = await fetch(`${baseUrl}/api/config`, { cache: 'no-store' });
      if (r.ok) {
        window.location.reload();
        return;
      }
    } catch {
      /* 后台还未就绪 */
    }
    if (attempts < maxAttempts) {
      setTimeout(poll, 600);
    } else {
      window.alert('重启超时，请手动刷新页面或检查终端输出。');
      btn.textContent = '重启本后台';
      btn.disabled = false;
    }
  };
  setTimeout(poll, 800);
}

async function stopServe() {
  const port = serveMeta.port || window.location.port || '9473';
  const host = serveMeta.host || window.location.hostname || '127.0.0.1';
  const pid = serveMeta.pid != null ? serveMeta.pid : '（见终端）';
  if (
    !window.confirm(
      `确定停止当前看板后台？\n\n将关闭本页面对应的 ai-dash3 serve：\n${host}:${port}（PID ${pid}）\n\n关闭后页面将无法继续刷新；若端口仍被占用可执行：lsof -ti :${port} | xargs kill`
    )
  ) {
    return;
  }
  const btn = $('stopServeBtn');
  btn.disabled = true;
  btn.textContent = '停止中…';
  try {
    await fetchJson('/api/stop-serve', { method: 'POST' });
    window.alert('看板后台已停止。本页将无法继续自动刷新。');
  } catch (e) {
    if (String(e.message || e).includes('fetch') || String(e.message || e).includes('Failed')) {
      window.alert('看板后台已停止（连接已断开）。');
    } else {
      window.alert(`停止本后台失败：${e.message}`);
    }
  } finally {
    btn.textContent = '停止本后台';
    btn.disabled = false;
  }
}

async function stopPipeline() {
  const root = $('projectPath').value.trim();
  if (!root) {
    window.alert('请先填写项目绝对路径');
    return;
  }
  if (
    !window.confirm(
      `确定停止该项目由 ai-auto3 拉起的所有后台任务？\n\n${root}\n\n将发送 SIGTERM/SIGKILL 给 autorun、ai-code3、cursor-agent 等，并清除 registry 运行态（不关闭本看板 serve）。`
    )
  ) {
    return;
  }
  const btn = $('stopPipelineBtn');
  btn.disabled = true;
  btn.textContent = '停止中…';
  try {
    const result = await fetchJson(`/api/stop?project=${encodeURIComponent(root)}`, { method: 'POST' });
    const n = result.processes_matched ?? (result.processes && result.processes.length) ?? 0;
    const left = (result.still_running && result.still_running.length) || 0;
    let msg = result.ok
      ? `已停止：匹配 ${n} 个进程，锁文件${result.lock_removed ? '已' : '未'}清除。`
      : `已发送停止信号（${n} 个进程）；仍有 ${left} 个进程存活，请查看终端或手动结束。`;
    if (result.runs_finished && result.runs_finished.length) {
      msg += ` 已结束 registry run：${result.runs_finished.length} 条。`;
    }
    window.alert(msg);
    await loadRegistry();
    await loadDashboard();
  } catch (e) {
    window.alert(`停止失败：${e.message}`);
    await loadDashboard();
  } finally {
    btn.textContent = '停止任务后台';
    updateStopButtons(lastDashboard);
  }
}

function scheduleAutoRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
  if ($('autoRefresh').checked) {
    timer = setInterval(() => {
      loadRegistry().then(() => loadDashboard()).catch(() => {});
    }, 3000);
  }
}

async function init() {
  try {
    const cfg = await fetchJson('/api/config');
    if (cfg.default_project_root) {
      $('projectPath').value = cfg.default_project_root;
    }
    if (cfg.serve) {
      serveMeta = {
        pid: cfg.serve.pid ?? null,
        host: cfg.serve.host || '127.0.0.1',
        port: cfg.serve.port ?? null,
      };
    }
  } catch (_) {
    /* ignore */
  }

  await loadRegistry();

  $('projectSelect').addEventListener('change', (e) => {
    if (e.target.value) {
      $('projectPath').value = e.target.value;
      loadDashboard();
    }
  });

  $('projectPath').addEventListener('change', loadDashboard);
  $('refreshBtn').addEventListener('click', async () => {
    const btn = $('refreshBtn');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await loadRegistry();
      await loadDashboard();
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  });
  $('restartServeBtn').addEventListener('click', () => {
    restartServe().catch((e) => window.alert(String(e.message || e)));
  });
  $('stopServeBtn').addEventListener('click', () => {
    stopServe().catch((e) => window.alert(String(e.message || e)));
  });
  $('stopPipelineBtn').addEventListener('click', () => {
    stopPipeline().catch((e) => window.alert(String(e.message || e)));
  });
  $('autoRefresh').addEventListener('change', scheduleAutoRefresh);

  scheduleAutoRefresh();
  await loadDashboard();
}

init();

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
let timer = null;

async function fetchJson(url, options) {
  const r = await fetch(url, { cache: 'no-store', ...options });
  const data = await r.json();
  if (!r.ok && r.status !== 207) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}

function updateStopButton(dash) {
  const btn = $('stopBtn');
  if (!btn) return;
  const stoppable = !!(dash && dash.pipeline_stoppable);
  btn.disabled = !currentProjectRoot || !stoppable;
  btn.title = stoppable
    ? '停止该项目的 autorun、ai-code3、cursor-agent 等后台进程'
    : '当前未检测到该项目的 pipeline 后台进程';
}

function setBanner(overall, dash) {
  const el = $('statusBanner');
  const lock = dash.summary?.pid_lock;
  let extra = '';
  if (lock?.present && lock.alive) {
    extra = ` · pipeline 锁 PID=${lock.pid}`;
  } else if (lock?.present && lock.alive === false) {
    extra = ' · 锁文件残留';
  }
  if (dash.autorun_active) extra += ' · registry 有未结束 run';
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
    ['registry 未结束 run', dash.registry_run_active ? '是' : '否'],
    ['当前 phase', rt.current_phase],
    ['当前 stage', rt.current_stage],
    ['pending features', (rt.pending_features || []).join(', ') || '—'],
    ['active_run_id', rt.active_run_id],
    ['runtime 更新', rt.updated_at],
  ]);
}

function renderSummary(dash) {
  const s = dash.summary || {};
  const p = s.pipeline || {};
  fillKv($('summaryDl'), [
    ['project_id', dash.project_id],
    ['current_stage', p.current_stage],
    ['last_completed', p.last_completed_stage],
    ['pipeline 更新', p.updated_at],
    ['项目根', dash.project_root],
  ]);
}

function renderFeatures(dash, filterStatus) {
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
    btn.classList.toggle('active', st === (filterStatus || 'all'));
    btn.addEventListener('click', () => renderFeatures(dash, st));
    tabs.appendChild(btn);
  }

  board.innerHTML = '';
  const list =
    !filterStatus || filterStatus === 'all'
      ? feats
      : feats.filter((f) => f.pipeline_status === filterStatus);

  if (!list.length) {
    board.innerHTML = '<p class="empty">暂无 feature（检查 prd_review.phase_plan）</p>';
    return;
  }

  for (const f of list) {
    const card = document.createElement('article');
    card.className = 'feature-card';
    card.dataset.status = f.pipeline_status;
    card.innerHTML = `
      <div class="fid">${escapeHtml(f.feature_id)}</div>
      ${f.name ? `<div class="meta">${escapeHtml(f.name)}</div>` : ''}
      <div class="meta">phase: ${escapeHtml(f.phase)}${f.client_target ? ` · ${escapeHtml(f.client_target)}` : ''}</div>
      <span class="badge badge-${f.pipeline_status}">${FEATURE_LABEL[f.pipeline_status] || f.pipeline_status}</span>
      ${f.list_status ? `<div class="meta">feature_list: ${escapeHtml(f.list_status)}</div>` : ''}
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
    else if (st === 'in_progress') tr.classList.add('stage-in_progress');
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
  sel.innerHTML = '<option value="">— 从 registry 选择 —</option>';
  for (const p of registryProjects) {
    const opt = document.createElement('option');
    opt.value = p.root_path;
    const tag = p.autorun_active ? ' ●' : '';
    opt.textContent = `${p.project_id || p.root_path}${tag}`;
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
    updateStopButton(dash);
    setBanner(dash.overall, dash);
    renderRuntime(dash);
    renderSummary(dash);
    renderFeatures(dash, 'all');
    renderStages(dash);
    renderBlockers(dash);
    renderRuns(dash);
  } catch (e) {
    lastDashboard = null;
    updateStopButton(null);
    $('statusBanner').className = 'status-banner overall-failed';
    $('statusBanner').innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`;
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
      `确定停止该项目所有流水线后台进程？\n\n${root}\n\n将发送 SIGTERM/SIGKILL 给 autorun、ai-code3、cursor-agent 等，并清除 registry 运行态。`
    )
  ) {
    return;
  }
  const btn = $('stopBtn');
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
    btn.textContent = '停止运行';
    updateStopButton(lastDashboard);
  }
}

function scheduleAutoRefresh() {
  if (timer) clearInterval(timer);
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
    await loadRegistry();
    await loadDashboard();
  });
  $('stopBtn').addEventListener('click', () => {
    stopPipeline().catch((e) => window.alert(String(e.message || e)));
  });
  $('autoRefresh').addEventListener('change', scheduleAutoRefresh);

  scheduleAutoRefresh();
  await loadDashboard();
}

init();

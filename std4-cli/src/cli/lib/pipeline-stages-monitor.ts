import fs from 'node:fs';
import path from 'node:path';

export type StagesSnapshot =
  | { ok: true; raw: unknown; mtimeMs: number }
  | { ok: false; kind: 'missing' | 'unreadable' | 'invalid_json'; message: string; cause?: unknown };

export type StagesMonitorHandlers = {
  onSnapshot: (snap: StagesSnapshot) => void;
};

export type StagesMonitorOptions = {
  /** 合并高频写入（默认 400ms）。 */
  debounceMs?: number;
  /** fs.watch 不可靠时的轮询间隔（默认 5000ms）；设为 0 禁用。 */
  pollIntervalMs?: number;
};

function stagesJsonPath(projectRoot: string): string {
  return path.join(projectRoot, '.pipeline', 'stages.json');
}

function safeStatmtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function readStagesFile(projectRoot: string): StagesSnapshot {
  const p = stagesJsonPath(projectRoot);
  let rawText: string;
  try {
    rawText = fs.readFileSync(p, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { ok: false, kind: 'missing', message: `.pipeline/stages.json not found at ${p}` };
    }
    return { ok: false, kind: 'unreadable', message: `failed to read ${p}`, cause: e };
  }

  try {
    const raw = JSON.parse(rawText) as unknown;
    const st = safeStatmtime(p);
    return { ok: true, raw, mtimeMs: st ?? 0 };
  } catch (e) {
    return { ok: false, kind: 'invalid_json', message: `invalid JSON in ${p}`, cause: e };
  }
}

/**
 * 监听业务项目根下 `.pipeline/stages.json`：fs.watch + 轮询回退 + 去抖。
 */
export function startPipelineStagesMonitor(
  projectRoot: string,
  handlers: StagesMonitorHandlers,
  opts: StagesMonitorOptions = {},
): { stop: () => void } {
  const debounceMs = opts.debounceMs ?? 400;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;

  const pipelineDir = path.join(projectRoot, '.pipeline');
  const file = stagesJsonPath(projectRoot);

  let debounceTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;

  let lastEmittedSig = '';

  const emit = () => {
    const snap = readStagesFile(projectRoot);
    const sig = snap.ok ? `${snap.mtimeMs}:${JSON.stringify(snap.raw)}` : `err:${snap.kind}:${snap.message}`;
    if (sig === lastEmittedSig) return;
    lastEmittedSig = sig;
    queueMicrotask(() => handlers.onSnapshot(snap));
  };

  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      emit();
    }, debounceMs);
  };

  // 初始投递（异步，避免阻塞调用方）
  queueMicrotask(() => schedule());

  try {
    if (fs.existsSync(pipelineDir)) {
      watcher = fs.watch(pipelineDir, { persistent: false }, (_evt, fname) => {
        if (fname && fname !== 'stages.json') return;
        schedule();
      });
    }
  } catch {
    watcher = undefined;
  }

  // 若 watch 失败或未触发，轮询 mtime 兜底
  let lastMtime: number | null = safeStatmtime(file);
  if (pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      const mt = safeStatmtime(file);
      if (mt == null) {
        if (lastMtime != null) schedule();
        lastMtime = null;
        return;
      }
      if (lastMtime == null || mt !== lastMtime) {
        lastMtime = mt;
        schedule();
      }
    }, pollIntervalMs);
  }

  return {
    stop: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

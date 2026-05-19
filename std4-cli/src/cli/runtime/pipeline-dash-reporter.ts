import * as fs from "node:fs";
import * as path from "node:path";

/** 与 CLI-DASH-PIPELINE-001 对齐的去抖窗口（毫秒），文档化默认值 */
export const PIPELINE_STAGES_DEBOUNCE_MS = 320;

type Listener = () => void;

const registry = new Map<string, { watcher: fs.FSWatcher; listeners: Set<Listener> }>();

function keyFor(projectRoot: string): string {
  return path.resolve(projectRoot, ".pipeline", "stages.json");
}

/**
 * 单一 fs.watch：多个订阅者共享，避免重复 watch。
 */
export function subscribeStagesJsonChanges(
  projectRoot: string,
  listener: Listener,
): () => void {
  const abs = keyFor(projectRoot);
  const dir = path.dirname(abs);
  let bucket = registry.get(abs);
  if (!bucket) {
    const listeners = new Set<Listener>();
    let timer: NodeJS.Timeout | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        for (const fn of listeners) {
          try {
            fn();
          } catch {
            /* swallow: reporter must not crash pipeline */
          }
        }
      }, PIPELINE_STAGES_DEBOUNCE_MS);
    };

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false }, (evt, fname) => {
        if (fname && path.join(dir, fname) !== abs) return;
        schedule();
      });
    } catch {
      watcher = fs.watch(abs, { persistent: false }, () => schedule());
    }

    bucket = { watcher, listeners };
    registry.set(abs, bucket);
  }

  bucket.listeners.add(listener);
  return () => {
    const b = registry.get(abs);
    if (!b) return;
    b.listeners.delete(listener);
    if (b.listeners.size === 0) {
      b.watcher.close();
      registry.delete(abs);
    }
  };
}

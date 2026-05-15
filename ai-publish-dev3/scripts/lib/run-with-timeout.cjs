'use strict';

/**
 * @template T
 * @param {{ ms: number, heartbeatMs?: number, onHeartbeat?: () => void, label?: string }} opts
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: true, result: T, durationMs: number } | { ok: false, durationMs: number, timedOut: boolean, error: Error }>}
 */
async function runWithTimeout(opts, fn) {
  const { ms, heartbeatMs = 0, onHeartbeat } = opts;
  const started = Date.now();
  let iv = null;
  if (heartbeatMs > 0 && typeof onHeartbeat === 'function') {
    iv = setInterval(() => {
      try {
        onHeartbeat();
      } catch {
        /* ignore */
      }
    }, heartbeatMs);
  }
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(opts.label || 'timeout');
      e.code = 'ETIMEDOUT';
      reject(e);
    }, ms);
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timer);
    return { ok: true, result, durationMs: Date.now() - started };
  } catch (error) {
    clearTimeout(timer);
    const timedOut = !!(error && error.code === 'ETIMEDOUT');
    return { ok: false, durationMs: Date.now() - started, timedOut, error };
  } finally {
    if (iv) clearInterval(iv);
  }
}

module.exports = { runWithTimeout };

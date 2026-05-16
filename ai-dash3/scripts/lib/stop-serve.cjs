'use strict';

/**
 * 停止当前 ai-dash3 serve 进程（响应 POST /api/stop-serve 后优雅关闭）
 * @param {import('http').Server} server
 * @param {{ host?: string, port?: number }} meta
 */
function buildStopServeResponse(server, meta) {
  const addr = server && typeof server.address === 'function' ? server.address() : null;
  const port =
    addr && typeof addr === 'object' && addr.port != null ? addr.port : meta?.port ?? null;
  const host = meta?.host ?? '127.0.0.1';

  return {
    schema: 'ai-dash3.stop-serve.v1',
    ok: true,
    pid: process.pid,
    host,
    port,
    message: 'ai-dash3 serve shutting down',
  };
}

/**
 * @param {import('http').Server} server
 */
function scheduleStopServe(server) {
  const shutdown = () => {
    try {
      if (server) {
        server.close(() => process.exit(0));
      } else {
        process.exit(0);
      }
    } catch {
      process.exit(0);
    }
  };
  setImmediate(shutdown);
  setTimeout(() => process.exit(0), 2500).unref();
}

module.exports = {
  buildStopServeResponse,
  scheduleStopServe,
};

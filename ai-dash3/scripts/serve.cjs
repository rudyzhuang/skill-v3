#!/usr/bin/env node
'use strict';

/**
 * ai-dash3 本地 Web 看板（只读）
 * 用法: node serve.cjs [--port=9473] [--host=127.0.0.1] [--project=<abs>]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const { requireAbsoluteProject } = require('./lib/summary.cjs');
const { buildDashboard, buildProjectsPayload } = require('./lib/dashboard.cjs');
const { fetchRuntimeExport } = require('./lib/runtime-bridge.cjs');
const { setDashServe } = require('../../ai-auto3/scripts/lib/runtime-io.cjs');
const { readStages } = require('./lib/summary.cjs');
const { invokeStopPipeline } = require('./lib/stop-bridge.cjs');
const { buildStopServeResponse, scheduleStopServe } = require('./lib/stop-serve.cjs');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function openBrowser(url) {
  if (process.env.AI_DASH3_NO_OPEN === '1') return;
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* ignore — user can open URL manually */
  }
}

function parseArgs(argv) {
  const out = { port: 9473, host: '127.0.0.1', project: null, open: false };
  for (const a of argv.slice(2)) {
    if (a === '--open') out.open = true;
    else if (a.startsWith('--port=')) out.port = parseInt(a.slice('--port='.length), 10);
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
  }
  if (!Number.isFinite(out.port) || out.port < 1 || out.port > 65535) {
    throw new Error('invalid --port');
  }
  return out;
}

function sendJson(res, status, obj) {
  const body = `${JSON.stringify(obj)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safeProjectRoot(raw) {
  if (!raw) return null;
  try {
    return requireAbsoluteProject(raw);
  } catch {
    return null;
  }
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  if (rel.includes('..')) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  const filePath = path.resolve(path.join(WEB_ROOT, rel));
  const webRootResolved = path.resolve(WEB_ROOT);
  if (!filePath.startsWith(webRootResolved + path.sep) && filePath !== webRootResolved) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(filePath);
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

let cachedRuntime = { at: 0, data: null };

function getRuntimeCached() {
  const now = Date.now();
  if (cachedRuntime.data && now - cachedRuntime.at < 2000) {
    return cachedRuntime.data;
  }
  const reg = fetchRuntimeExport();
  cachedRuntime = { at: now, data: reg.ok ? reg.data : null };
  return cachedRuntime.data;
}

function writeDashServeMeta(projectRoot, host, port) {
  if (!projectRoot) return;
  try {
    const read = readStages(projectRoot);
    if (!read.ok || !read.data?.project?.project_id) return;
    setDashServe(read.data.project.project_id, {
      pid: process.pid,
      host,
      port,
      url: `http://${host}:${port}/`,
      started_at: new Date().toISOString(),
    });
  } catch {
    /* ignore */
  }
}

function createServer(opts) {
  const defaultProject = opts.project ? safeProjectRoot(opts.project) : null;
  const serveMeta = { host: opts.host, port: opts.port, pid: process.pid };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/api/projects' || url.pathname === '/api/registry')) {
      return sendJson(res, 200, buildProjectsPayload());
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const addr = server.address();
      const listenPort =
        addr && typeof addr === 'object' && addr.port != null ? addr.port : serveMeta.port;
      return sendJson(res, 200, {
        schema: 'ai-dash3.config.v1',
        default_project_root: defaultProject,
        serve: {
          pid: process.pid,
          host: serveMeta.host,
          port: listenPort,
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/stop-serve') {
      const payload = buildStopServeResponse(server, serveMeta);
      sendJson(res, 200, payload);
      scheduleStopServe(server);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/restart-serve') {
      const restartArgs = [`--port=${opts.port}`, `--host=${opts.host}`];
      if (opts.project) restartArgs.push(`--project=${opts.project}`);
      sendJson(res, 200, {
        schema: 'ai-dash3.restart-serve.v1',
        ok: true,
        pid: process.pid,
        host: opts.host,
        port: opts.port,
        message: 'ai-dash3 serve restarting',
      });
      setImmediate(() => {
        try {
          spawn(process.execPath, [__filename, ...restartArgs], {
            detached: true,
            stdio: 'ignore',
          }).unref();
        } catch {
          /* ignore spawn errors */
        }
        scheduleStopServe(server);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const root = safeProjectRoot(url.searchParams.get('project')) || defaultProject;
      if (!root) {
        return sendJson(res, 400, {
          schema: 'ai-dash3.error.v1',
          error: 'invalid_project',
          message: 'missing or invalid ?project=<absolute path>',
        });
      }
      const result = invokeStopPipeline(root);
      cachedRuntime.at = 0;
      return sendJson(res, result.ok ? 200 : 207, {
        schema: 'ai-dash3.stop.v1',
        project_root: root,
        ok: result.ok,
        exit_code: result.exit_code,
        ...(result.data || {}),
        error: result.error || null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const root = safeProjectRoot(url.searchParams.get('project')) || defaultProject;
      if (!root) {
        return sendJson(res, 400, {
          schema: 'ai-dash3.error.v1',
          error: 'invalid_project',
          message: 'missing or invalid ?project=<absolute path>',
        });
      }
      const read = readStages(root);
      if (!read.ok) {
        return sendJson(res, 400, {
          schema: 'ai-dash3.error.v1',
          error: 'invalid_stages_json',
          message: read.error,
          path: read.path,
        });
      }
      const reg = getRuntimeCached();
      try {
        const dash = buildDashboard(root, reg ? { ok: true, ...reg } : null);
        return sendJson(res, 200, dash);
      } catch (e) {
        return sendJson(res, 500, {
          schema: 'ai-dash3.error.v1',
          error: 'internal',
          message: String(e.message || e),
        });
      }
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      return serveStatic(req, res, url.pathname);
    }

    res.writeHead(404);
    res.end('not found');
  });

  return server;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv || process.argv);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  const server = createServer(opts);
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(
        `ai-dash3: 端口 ${opts.port} 已被占用（${opts.host}:${opts.port}）。\n` +
          `  若已是本看板：直接在浏览器打开 http://${opts.host}:${opts.port}/\n` +
          `  若要重启：lsof -ti :${opts.port} | xargs kill\n` +
          `  或换端口：node .../run.cjs serve --port=9474 --open`
      );
      process.exit(1);
    }
    console.error(String(err.message || err));
    process.exit(1);
  });
  server.listen(opts.port, opts.host, () => {
    const url = `http://${opts.host}:${opts.port}/`;
    process.stdout.write(`ai-dash3 web: ${url}\n`);
    const defaultRoot = opts.project ? safeProjectRoot(opts.project) : null;
    if (defaultRoot) {
      process.stdout.write(`default project: ${defaultRoot}\n`);
      writeDashServeMeta(defaultRoot, opts.host, opts.port);
    }
    if (opts.open) {
      openBrowser(url);
      process.stdout.write('opened in default browser (--open)\n');
    }
    process.stdout.write('Ctrl+C to stop\n');
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, main, parseArgs };

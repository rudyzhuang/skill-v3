#!/usr/bin/env node
'use strict';

/**
 * ai-dash3 smoke — 连续跑两轮（dash3.md §9）
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN = path.join(__dirname, 'run.cjs');
const FIXTURE = path.resolve(__dirname, '..', '..', 'ai-code3', 'fixtures', 'smoke-project');

function runRound(label) {
  if (!fs.existsSync(FIXTURE)) {
    console.error('smoke: missing fixture', FIXTURE);
    process.exit(1);
  }
  const tmpMd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dash3-smoke-')), 'dash.md');
  const cmds = [
    ['status', `--project=${FIXTURE}`],
    ['json', `--project=${FIXTURE}`],
    ['write-md', `--project=${FIXTURE}`, `--out=${tmpMd}`],
  ];
  for (const extra of cmds) {
    const r = spawnSync(process.execPath, [RUN, ...extra], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`smoke [${label}] failed:`, extra.join(' '), r.stderr || r.stdout);
      process.exit(1);
    }
    if (extra[0] === 'json') {
      const line = (r.stdout || '').trim();
      const o = JSON.parse(line);
      if (o.schema !== 'ai-dash3.summary.v1') {
        console.error('smoke: bad schema', o.schema);
        process.exit(1);
      }
      if (!Array.isArray(o.rows) || o.rows.length !== 15) {
        console.error('smoke: rows length', o.rows && o.rows.length);
        process.exit(1);
      }
    }
  }
  if (!fs.existsSync(tmpMd)) {
    console.error('smoke: missing', tmpMd);
    process.exit(1);
  }
}

for (let i = 1; i <= 2; i++) {
  runRound(`round-${i}`);
}

function httpGetJson(port, path) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function httpPostJson(port, path) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST' },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function smokeServe() {
  const { createServer } = require('./serve.cjs');
  const server = createServer({ port: 0, host: '127.0.0.1', project: FIXTURE });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      try {
        const cfg = await httpGetJson(port, '/api/config');
        if (cfg.json.schema !== 'ai-dash3.config.v1' || !cfg.json.serve?.pid) {
          reject(new Error('config missing serve.pid'));
          return;
        }
        const dash = await httpGetJson(
          port,
          `/api/dashboard?project=${encodeURIComponent(FIXTURE)}`
        );
        if (dash.json.schema !== 'ai-dash3.dashboard.v1') {
          reject(new Error(`bad dashboard schema: ${dash.json.schema}`));
          return;
        }
        if (typeof dash.json.pipeline_stoppable !== 'boolean') {
          reject(new Error('dashboard missing pipeline_stoppable'));
          return;
        }
        const stop = await httpPostJson(port, `/api/stop?project=${encodeURIComponent(FIXTURE)}`);
        if (stop.json.schema !== 'ai-dash3.stop.v1') {
          reject(new Error(`bad stop schema: ${stop.json.schema}`));
          return;
        }
        server.close();
        resolve();
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

function smokeStopServe() {
  const { createServer } = require('./serve.cjs');
  const server = createServer({ port: 0, host: '127.0.0.1', project: null });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      try {
        const stop = await httpPostJson(port, '/api/stop-serve');
        if (stop.json.schema !== 'ai-dash3.stop-serve.v1' || !stop.json.ok) {
          reject(new Error('bad stop-serve response'));
          return;
        }
        await new Promise((r) => setTimeout(r, 400));
        const http = require('http');
        await new Promise((res, rej) => {
          http
            .get(`http://127.0.0.1:${port}/api/config`, () => rej(new Error('server should be down')))
            .on('error', () => res());
        });
        resolve();
      } catch (e) {
        try {
          server.close();
        } catch {
          /* */
        }
        reject(e);
      }
    });
  });
}

function smokeServeInvalidJson() {
  const { createServer } = require('./serve.cjs');
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dash3-bad-'));
  const badStages = path.join(badDir, '.pipeline');
  fs.mkdirSync(badStages, { recursive: true });
  fs.writeFileSync(path.join(badStages, 'stages.json'), '{not json', 'utf8');
  const server = createServer({ port: 0, host: '127.0.0.1', project: null });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const http = require('http');
      http
        .get(
          `http://127.0.0.1:${port}/api/dashboard?project=${encodeURIComponent(badDir)}`,
          (res) => {
            let body = '';
            res.on('data', (c) => {
              body += c;
            });
            res.on('end', () => {
              server.close();
              try {
                if (res.statusCode !== 400) {
                  reject(new Error(`expected 400 for bad json, got ${res.statusCode}`));
                  return;
                }
                const o = JSON.parse(body);
                if (o.error !== 'invalid_stages_json') {
                  reject(new Error(`bad error code: ${o.error}`));
                  return;
                }
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          }
        )
        .on('error', (e) => {
          server.close();
          reject(e);
        });
    });
  });
}

function smokeFeatures() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'self-test-features.cjs')], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || 'self-test-features failed');
  }
}

Promise.resolve()
  .then(() => smokeFeatures())
  .then(() => smokeServe())
  .then(() => smokeStopServe())
  .then(() => smokeServeInvalidJson())
  .then(() =>
    console.log('smoke: all passed (features + 2 rounds + serve/stop/stop-serve + invalid json)')
  )
  .catch((e) => {
    console.error('smoke failed:', e.message || e);
    process.exit(1);
  });

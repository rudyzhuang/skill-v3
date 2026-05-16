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
      if (!Array.isArray(o.rows) || o.rows.length !== 14) {
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

function smokeServe() {
  const { createServer } = require('./serve.cjs');
  const server = createServer({ port: 0, host: '127.0.0.1', project: FIXTURE });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const http = require('http');
      http
        .get(`http://127.0.0.1:${port}/api/dashboard?project=${encodeURIComponent(FIXTURE)}`, (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => {
            server.close();
            try {
              const o = JSON.parse(body);
              if (o.schema !== 'ai-dash3.dashboard.v1') {
                reject(new Error(`bad dashboard schema: ${o.schema}`));
                return;
              }
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', (e) => {
          server.close();
          reject(e);
        });
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

Promise.resolve()
  .then(() => smokeServe())
  .then(() => smokeServeInvalidJson())
  .then(() => console.log('smoke: all passed (2 rounds + serve api + invalid json)'))
  .catch((e) => {
    console.error('smoke failed:', e.message || e);
    process.exit(1);
  });

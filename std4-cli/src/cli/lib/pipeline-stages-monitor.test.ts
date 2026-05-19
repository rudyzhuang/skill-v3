import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startPipelineStagesMonitor } from './pipeline-stages-monitor.js';

test('emits snapshot after stages.json write (debounced)', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stages-mon-'));
  const pipelineDir = path.join(tmp, '.pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const stagesPath = path.join(pipelineDir, 'stages.json');

  const snaps: unknown[] = [];
  const mon = startPipelineStagesMonitor(
    tmp,
    {
      onSnapshot(s) {
        snaps.push(s);
      },
    },
    { debounceMs: 30, pollIntervalMs: 200 },
  );

  t.after(() => mon.stop());

  fs.writeFileSync(
    stagesPath,
    JSON.stringify({
      pipeline: {
        current_stage: 'setup',
        last_completed_stage: null,
        updated_at: null,
        updated_by: 'ai-std4',
        project: {
          project_id: 'pid',
          root_path: tmp,
          name: 't',
          git: {
            remote: null,
            remote_url: null,
            default_branch: null,
            repo_initialized_at: null,
            remote_configured_at: null,
          },
        },
      },
      stages: {
        setup: {
          status: 'running',
          started_at: null,
          completed_at: null,
          validation: {
            passed: true,
            checked_at: null,
            summary: null,
            required_files: [],
            missing_required_fields: [],
            warnings: [],
          },
          generated_files: [],
          blocking_issues: [],
          git_sync: {
            initial_pushed_at: null,
            docs_pipeline_pushed_at: null,
            last_commit: null,
            last_push_status: null,
          },
        },
      },
    }),
    'utf8',
  );

  await new Promise(r => setTimeout(r, 250));

  assert.ok(snaps.length >= 1);
  const last = snaps[snaps.length - 1] as { ok: boolean };
  assert.equal(last.ok, true);
});

test('reports missing file without throwing', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stages-mon-miss-'));
  const snaps: unknown[] = [];
  const mon = startPipelineStagesMonitor(
    tmp,
    {
      onSnapshot(s) {
        snaps.push(s);
      },
    },
    { debounceMs: 10, pollIntervalMs: 50 },
  );
  t.after(() => mon.stop());

  await new Promise(r => setTimeout(r, 120));
  assert.ok(snaps.some(s => typeof s === 'object' && s && (s as { ok?: boolean }).ok === false));
});

test('reports invalid JSON without throwing', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stages-mon-badjson-'));
  const pipelineDir = path.join(tmp, '.pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'stages.json'), '{not json', 'utf8');

  const snaps: unknown[] = [];
  const mon = startPipelineStagesMonitor(
    tmp,
    {
      onSnapshot(s) {
        snaps.push(s);
      },
    },
    { debounceMs: 15, pollIntervalMs: 80 },
  );
  t.after(() => mon.stop());

  await new Promise(r => setTimeout(r, 150));
  assert.ok(
    snaps.some(
      s =>
        typeof s === 'object' &&
        s &&
        (s as { ok?: boolean; kind?: string }).ok === false &&
        (s as { kind?: string }).kind === 'invalid_json',
    ),
  );
});

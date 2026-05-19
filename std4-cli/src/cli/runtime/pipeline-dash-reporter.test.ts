import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pipelineUpsertPath } from '../../dash/contracts/pipeline-upsert.js';
import { startPipelineDashReporter } from './pipeline-dash-reporter.js';

function minimalStages(status: string, current: string | null) {
  return {
    pipeline: {
      current_stage: current,
      last_completed_stage: null,
      updated_at: null,
      updated_by: 'ai-std4',
      project: {
        project_id: 'proj-dash-test',
        root_path: '/',
        name: 'n',
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
        status,
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
  };
}

test('reporter sends debounced PUT with Bearer + stages/current_stage after stages.json change', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-rep-'));
  const pipelineDir = path.join(tmp, '.pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const stagesPath = path.join(pipelineDir, 'stages.json');
  fs.writeFileSync(stagesPath, JSON.stringify(minimalStages('running', 'setup')), 'utf8');

  const puts: { url: string; auth: string | null; body: unknown }[] = [];
  const apiKey = 'test-api-key-not-logged';

  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const h = new Headers(init?.headers);
    puts.push({
      url,
      auth: h.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response('{}', { status: 200 });
  };

  const rep = startPipelineDashReporter({
    projectRoot: tmp,
    apiBaseUrl: 'https://dash.example.invalid',
    apiKey,
    fetchFn,
    debounceMs: 40,
    pollIntervalMs: 200,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });
  t.after(() => rep.stop());

  await new Promise(r => setTimeout(r, 120));

  fs.writeFileSync(stagesPath, JSON.stringify(minimalStages('completed', 'setup')), 'utf8');

  await new Promise(r => setTimeout(r, 350));

  assert.ok(puts.length >= 1);
  const last = puts[puts.length - 1];
  assert.equal(last.url, `https://dash.example.invalid${pipelineUpsertPath('proj-dash-test')}`);
  assert.equal(last.auth, `Bearer ${apiKey}`);
  assert.ok(last.body && typeof last.body === 'object');
  const b = last.body as { stages?: unknown[]; current_stage?: string | null };
  assert.ok(Array.isArray(b.stages));
  assert.ok(b.stages!.some(s => typeof s === 'object' && s && (s as { stage_id?: string }).stage_id === 'setup'));
  assert.equal(b.current_stage, 'setup');
});

test('reporter does not throw when stages.json is invalid JSON', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-rep-bad-'));
  const pipelineDir = path.join(tmp, '.pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'stages.json'), '{bad', 'utf8');

  let warns = 0;
  const rep = startPipelineDashReporter({
    projectRoot: tmp,
    apiBaseUrl: 'https://dash.example.invalid',
    apiKey: 'k',
    debounceMs: 15,
    pollIntervalMs: 60,
    degradeOnFileError: 'retry',
    log: {
      info: () => {},
      warn: () => {
        warns++;
      },
      error: () => {},
    },
  });
  t.after(() => rep.stop());

  await new Promise(r => setTimeout(r, 180));
  assert.ok(warns >= 1);
});

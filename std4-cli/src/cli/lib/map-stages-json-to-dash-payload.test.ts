import assert from 'node:assert/strict';
import test from 'node:test';

import { PIPELINE_STAGE_STATUS_VALUES } from '../../dash/contracts/pipeline-upsert.js';
import { mapStagesJsonToDashPayload } from './map-stages-json-to-dash-payload.js';

test('maps stages.json subset to dash payload with stages array + current_stage', () => {
  const stagesRoot = {
    pipeline: {
      current_stage: 'prd',
      last_completed_stage: 'setup',
      updated_at: '2026-05-19T00:00:00Z',
      updated_by: 'ai-std4',
      project: {
        project_id: 'proj-1',
        root_path: '/tmp/p',
        name: 'n',
        git: {
          remote: 'origin',
          remote_url: 'https://example.invalid/x.git',
          default_branch: 'main',
          repo_initialized_at: null,
          remote_configured_at: null,
        },
      },
    },
    stages: {
      setup: {
        status: 'completed',
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
      prd: {
        status: 'running',
        started_at: '2026-05-19T01:00:00Z',
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
        blocking_issues: ['missing review'],
        git_sync: {
          initial_pushed_at: null,
          docs_pipeline_pushed_at: null,
          last_commit: null,
          last_push_status: null,
        },
        outputs: {
          client_targets: [],
          duration_ms: null,
          timed_out: false,
          timeout_reason: null,
          features: [
            {
              feature_id: 'FEAT-001',
              name: 'Example',
              priority: 'P0',
              phase: 'mvp',
              client_targets: ['cli'],
            },
          ],
        },
      },
    },
  };

  const payload = mapStagesJsonToDashPayload(stagesRoot, { correlationId: 'corr-1', logTail: 'line1\nline2' });

  assert.equal(payload.current_stage, 'prd');
  assert.ok(Array.isArray(payload.stages));
  assert.ok(payload.stages.some(s => s.stage_id === 'prd' && s.status === 'running'));
  assert.ok(payload.blocking_issues.includes('missing review'));
  assert.ok(payload.features.some(f => f.feature_id === 'FEAT-001'));
  assert.equal(payload.correlation_id, 'corr-1');
  assert.ok(!payload.run_id);
  assert.ok(payload.log_tail.includes('line1'));
});

test('prefers recovery_history last run_id over correlation id', () => {
  const stagesRoot = {
    pipeline: {
      current_stage: null,
      last_completed_stage: null,
      updated_at: null,
      updated_by: 'ai-std4',
      recovery_history: [{ stage: 'x', run_id: 'run-z', at: 't' }],
      project: {
        project_id: 'p',
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
        status: 'completed',
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

  const payload = mapStagesJsonToDashPayload(stagesRoot, { correlationId: 'corr-9' });
  assert.equal(payload.run_id, 'run-z');
  assert.ok(!payload.correlation_id);
});

test('stage status strings align with schema enums', () => {
  for (const s of PIPELINE_STAGE_STATUS_VALUES) {
    assert.ok(typeof s === 'string');
  }
});

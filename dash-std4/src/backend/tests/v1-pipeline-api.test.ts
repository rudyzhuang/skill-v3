import { describe, expect, it } from 'vitest';
import { hashApiKey } from '../src/lib/api-key';
import { normalizePipelinePayload } from '../src/lib/pipeline-normalize';
import { app, type Env } from '../src/index';
import { getLatestPipelinePayload } from '../src/services/pipeline-snapshot';
import { LOG_TAIL_MAX_BYTES, PAYLOAD_MAX_BYTES } from '../src/validators/pipeline-upsert';
import { createMemoryD1, insertApiKey, insertProject } from './helpers/memory-d1';

const TEST_KEY = 'test-open-api-key-secret';

function envWith(db: D1Database): Env {
  return { DB: db, OPEN_API_KEY: undefined };
}

async function request(
  db: D1Database,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization') && !headers.has('X-API-Key')) {
    headers.set('Authorization', `Bearer ${TEST_KEY}`);
  }
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers }),
    envWith(db),
  );
}

const validCreateBody = {
  name_zh: '流水线项目',
  name_en: 'Pipeline Project',
  description: '通过 Open API 创建',
  client_targets: ['admin', 'backend'],
  is_new: true,
};

describe('POST /api/v1/projects', () => {
  it('returns 201 with id and status for valid body', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await request(db, '/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('active');
    expect(body.client_targets).toEqual(['admin', 'backend']);
    expect(body.is_new).toBe(true);
    expect(body.source).toBe('open_api');

    const text = JSON.stringify(body);
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain('key_hash');
  });

  it('returns 400 with errors[] for invalid client_targets', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await request(db, '/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validCreateBody,
        client_targets: ['website'],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('returns 401 without API key', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validCreateBody),
      }),
      envWith(db),
    );

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain('OPEN_API_KEY');
    expect(text).not.toContain('config.env');
  });

  it('created project appears in GET list and detail', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const createRes = await request(db, '/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody),
    });
    const created = await createRes.json();

    const listRes = await request(db, '/api/v1/projects');
    const listBody = await listRes.json();
    expect(listBody.items.some((i: { id: string }) => i.id === created.id)).toBe(true);

    const detailRes = await request(db, `/api/v1/projects/${created.id}`);
    const detail = await detailRes.json();
    expect(detail.name_zh).toBe(validCreateBody.name_zh);
    expect(detail.name_en).toBe(validCreateBody.name_en);
    expect(detail.is_new).toBe(true);
  });
});

describe('PUT /api/v1/projects/:id/pipeline', () => {
  const pipelinePayload = {
    current_stage: 'build_phase',
    last_completed_stage: 'design_phase',
    stages: {
      setup: { status: 'completed', started_at: '2026-01-01', completed_at: '2026-01-02' },
      build_phase: { status: 'running', started_at: '2026-01-03' },
    },
    features: {
      'FEAT-001': { status: 'running', current_stage: 'build_phase' },
    },
    blocking_issues: [{ message: 'waiting review', stage: 'build_phase', severity: 'warn' }],
    log_tail: 'line1\nline2\n',
  };

  it('returns 200 and persists normalized snapshot', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'pipe-proj',
      name_zh: '管道',
      name_en: 'Pipe',
      client_targets: ['backend'],
    });

    const res = await request(db, '/api/v1/projects/pipe-proj/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pipelinePayload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project_id).toBe('pipe-proj');
    expect(body.current_stage).toBe('build_phase');
    expect(body.stages_count).toBe(2);

    const stored = await getLatestPipelinePayload(db, 'pipe-proj');
    expect(stored).not.toBeNull();
    expect(stored!.current_stage).toBe('build_phase');
    expect(stored!.stages).toHaveLength(2);
    expect(stored!.features).toHaveLength(1);
    expect(stored!.blocking_issues[0].message).toBe('waiting review');
    expect(stored!.log_tail).toBe('line1\nline2\n');
  });

  it('returns 404 for unknown project', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await request(db, '/api/v1/projects/missing/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_stage: 'setup' }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 401 without API key', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'p401',
      name_zh: 'x',
      name_en: 'y',
      client_targets: ['backend'],
    });

    const res = await app.fetch(
      new Request('http://localhost/api/v1/projects/p401/pipeline', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      envWith(db),
    );

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(TEST_KEY);
  });

  it('returns 400 for invalid JSON', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'bad-json',
      name_zh: 'x',
      name_en: 'y',
      client_targets: ['backend'],
    });

    const res = await request(db, '/api/v1/projects/bad-json/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toBeTruthy();
  });

  it('returns 413 when log_tail exceeds limit', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'big-log',
      name_zh: 'x',
      name_en: 'y',
      client_targets: ['backend'],
    });

    const huge = 'x'.repeat(LOG_TAIL_MAX_BYTES + 1);
    const res = await request(db, '/api/v1/projects/big-log/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ log_tail: huge }),
    });

    expect(res.status).toBe(413);
  });

  it('returns 413 when entire body exceeds payload limit', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'big-body',
      name_zh: 'x',
      name_en: 'y',
      client_targets: ['backend'],
    });

    const padding = 'a'.repeat(PAYLOAD_MAX_BYTES);
    const res = await request(db, '/api/v1/projects/big-body/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: padding }),
    });

    expect(res.status).toBe(413);
  });

  it('tolerates missing stages/features without 5xx', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'partial',
      name_zh: 'x',
      name_en: 'y',
      client_targets: ['backend'],
    });

    const res = await request(db, '/api/v1/projects/partial/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_stage: 'setup' }),
    });

    expect(res.status).toBe(200);
    const stored = await getLatestPipelinePayload(db, 'partial');
    expect(stored!.current_stage).toBe('setup');
    expect(stored!.stages).toEqual([]);
    expect(stored!.features).toEqual([]);
  });

  it('read path matches dashboard-shaped fields after upsert', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'dash-read',
      name_zh: '看板',
      name_en: 'Dash',
      client_targets: ['admin'],
    });

    const upsert = {
      current_stage: 'codegen',
      stages: [{ id: 'codegen', name: 'Codegen', status: 'running' }],
      features: [
        {
          feature_id: 'BACKEND-API-PIPELINE-001',
          name: 'Pipeline API',
          phase: 'mvp',
          status: 'running',
        },
      ],
      blocking_issues: [],
      log_tail: 'tail line',
    };

    await request(db, '/api/v1/projects/dash-read/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upsert),
    });

    const stored = await getLatestPipelinePayload(db, 'dash-read');
    const dashboard = normalizePipelinePayload(stored);
    expect(dashboard.stages[0]).toMatchObject({ id: 'codegen', status: 'running' });
    expect(dashboard.features[0].feature_id).toBe('BACKEND-API-PIPELINE-001');
    expect(dashboard.log_tail).toBe('tail line');
  });
});

describe('normalizePipelinePayload', () => {
  it('accepts stages.json-shaped payload subset', async () => {
    const normalized = normalizePipelinePayload({
      pipeline: { current_stage: 'build_phase', last_completed_stage: 'prd' },
      stages: {
        setup: { status: 'completed', started_at: 'a', completed_at: 'b' },
      },
      features: { 'FEAT-A': { status: 'pending' } },
      blocking_issues: ['blocked globally'],
      log_tail: 'log',
    });

    expect(normalized.current_stage).toBe('build_phase');
    expect(normalized.stages.length).toBeGreaterThan(0);
    expect(normalized.features.length).toBe(1);
    expect(normalized.blocking_issues.length).toBeGreaterThan(0);
    expect(normalized.log_tail).toBe('log');
  });
});

describe('auth edge cases', () => {
  it('accepts X-API-Key header for POST and PUT', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'x-api-key-proj',
      name_zh: 'x',
      name_en: 'y',
      client_targets: ['backend'],
    });

    const createRes = await app.fetch(
      new Request('http://localhost/api/v1/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': TEST_KEY,
        },
        body: JSON.stringify(validCreateBody),
      }),
      envWith(db),
    );
    expect(createRes.status).toBe(201);

    const putRes = await app.fetch(
      new Request('http://localhost/api/v1/projects/x-api-key-proj/pipeline', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': TEST_KEY,
        },
        body: JSON.stringify({ current_stage: 'setup' }),
      }),
      envWith(db),
    );
    expect(putRes.status).toBe(200);
  });

  it('does not leak stored key hash on invalid key', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/projects', {
        headers: { Authorization: 'Bearer wrong' },
      }),
      envWith(db),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(await hashApiKey(TEST_KEY));
  });
});

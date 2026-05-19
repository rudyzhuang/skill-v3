import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Env } from '../src/index';
import { insertProject, insertUser } from '../src/db/schema';
import { hashPassword } from '../src/services/password';
import { resetBootstrapForTests } from '../src/services/bootstrap-admin';
import { SESSION_COOKIE } from '../src/services/session';
import { LOG_TAIL_MAX_BYTES, LOG_TAIL_MAX_LINES, truncateLogTail } from '../src/lib/log-tail-truncate';
import { normalizePipelinePayload } from '../src/lib/pipeline-normalize';
import { createTestDb } from './test-db';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createTestDb(),
    COOKIE_SECURE: 'false',
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'test-secret-password',
    ...overrides,
  };
}

async function seedUser(env: Env): Promise<void> {
  await insertUser(env.DB, {
    id: crypto.randomUUID(),
    email: 'admin@example.com',
    password_hash: await hashPassword('correct-password'),
    role: 'admin',
    status: 'active',
    created_at: new Date().toISOString(),
  });
}

function extractCookie(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  const match = setCookie!.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  expect(match).toBeTruthy();
  return `${SESSION_COOKIE}=${match![1]}`;
}

async function loginCookie(env: Env): Promise<string> {
  const app = createApp();
  const res = await app.request(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'correct-password',
      }),
    },
    env,
  );
  return extractCookie(res.headers.get('Set-Cookie'));
}

async function seedProject(env: Env, id: string): Promise<void> {
  const now = new Date().toISOString();
  await insertProject(env.DB, {
    id,
    name_zh: '看板测试',
    name_en: 'Dashboard Test',
    description: null,
    client_targets: '["admin","backend"]',
    status: 'active',
    is_new: 0,
    source: 'admin',
    root_path: null,
    pipeline_summary: null,
    created_at: now,
    updated_at: now,
  });
}

async function insertSnapshot(
  env: Env,
  projectId: string,
  payload: unknown,
): Promise<void> {
  const normalized = normalizePipelinePayload(payload);
  await env.DB.prepare(
    `INSERT INTO pipeline_snapshots (id, project_id, payload_json, stages_hash, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      `snap-${projectId}`,
      projectId,
      JSON.stringify(normalized),
      'hash',
      '2026-05-19T10:00:00.000Z',
    )
    .run();
}

describe('truncateLogTail', () => {
  it('truncates by line count first', () => {
    const lines = Array.from({ length: LOG_TAIL_MAX_LINES + 10 }, (_, i) => `line-${i}`);
    const { text, truncated } = truncateLogTail(lines.join('\n'));
    expect(truncated).toBe(true);
    expect(text.split('\n').length).toBeLessThanOrEqual(LOG_TAIL_MAX_LINES);
  });

  it('truncates by byte limit', () => {
    const big = 'x'.repeat(LOG_TAIL_MAX_BYTES + 1000);
    const { text, truncated } = truncateLogTail(big);
    expect(truncated).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(LOG_TAIL_MAX_BYTES);
  });
});

describe('GET /api/projects/:id/pipeline', () => {
  beforeEach(() => {
    resetBootstrapForTests();
  });

  it('returns 401 without session', async () => {
    const env = makeEnv();
    await seedProject(env, 'proj-1');
    const app = createApp();
    const res = await app.request('/api/projects/proj-1/pipeline', {}, env);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown project', async () => {
    const env = makeEnv();
    await seedUser(env);
    const cookie = await loginCookie(env);
    const app = createApp();
    const res = await app.request(
      '/api/projects/missing-id/pipeline',
      { headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 with empty data_status when no snapshot', async () => {
    const env = makeEnv();
    await seedUser(env);
    await seedProject(env, 'proj-empty');
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects/proj-empty/pipeline',
      { headers: { Cookie: cookie } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.project).toMatchObject({ id: 'proj-empty' });
    expect(body.data_status).toBe('empty');
    expect(body.stages).toEqual([]);
    expect(body.features).toEqual([]);
    expect(body.blocking_issues).toEqual([]);
    expect(body.log_tail).toBe('');
    expect(body.synced_at).toBeNull();

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('config.env');
    expect(raw).not.toContain('ADMIN_PASSWORD');
    expect(raw).not.toMatch(/\/Users\//);
  });

  it('returns 200 with stages and features from snapshot', async () => {
    const env = makeEnv();
    await seedUser(env);
    await seedProject(env, 'proj-ok');
    await insertSnapshot(env, 'proj-ok', {
      pipeline: { current_stage: 'codegen', last_completed_stage: 'prd' },
      stages: {
        setup: { status: 'completed', blocking_issues: [] },
        codegen: {
          status: 'running',
          blocking_issues: [{ message: 'waiting review' }],
          features: {
            'FEAT-001': { status: 'in_progress', phase: 'mvp' },
          },
        },
      },
      log_tail: 'hello log',
    });
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects/proj-ok/pipeline',
      { headers: { Cookie: cookie } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data_status: string;
      current_stage: string;
      stages: { id: string; status: string }[];
      features: { feature_id: string; name: string }[];
      blocking_issues: { message: string }[];
      log_tail: string;
      synced_at: string;
    };

    expect(body.data_status).toBe('ok');
    expect(body.current_stage).toBe('codegen');
    expect(body.stages.length).toBeGreaterThanOrEqual(2);
    expect(body.stages.some((s) => s.id === 'setup' && s.status === 'completed')).toBe(true);
    expect(body.features.some((f) => f.feature_id === 'FEAT-001')).toBe(true);
    expect(body.blocking_issues.some((b) => b.message === 'waiting review')).toBe(true);
    expect(body.log_tail).toBe('hello log');
    expect(body.synced_at).toBeTruthy();
  });

  it('returns 200 with partial data_status for unparseable snapshot', async () => {
    const env = makeEnv();
    await seedUser(env);
    await seedProject(env, 'proj-partial');
    await env.DB.prepare(
      `INSERT INTO pipeline_snapshots (id, project_id, payload_json, stages_hash, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('snap-p', 'proj-partial', 'not-json{{{', null, '2026-05-19T11:00:00.000Z')
      .run();

    const cookie = await loginCookie(env);
    const app = createApp();
    const res = await app.request(
      '/api/projects/proj-partial/pipeline',
      { headers: { Cookie: cookie } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data_status: string; stages: unknown[] };
    expect(['empty', 'partial']).toContain(body.data_status);
    expect(body.stages).toEqual([]);
  });

  it('truncates oversized log_tail and returns 200', async () => {
    const env = makeEnv();
    await seedUser(env);
    await seedProject(env, 'proj-log');
    const hugeLog = 'L'.repeat(LOG_TAIL_MAX_BYTES + 5000);
    await insertSnapshot(env, 'proj-log', { log_tail: hugeLog, stages: { a: { status: 'ok' } } });

    const cookie = await loginCookie(env);
    const app = createApp();
    const res = await app.request(
      '/api/projects/proj-log/pipeline',
      { headers: { Cookie: cookie } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      log_tail: string;
      meta?: { truncated?: boolean };
    };
    expect(new TextEncoder().encode(body.log_tail).length).toBeLessThanOrEqual(LOG_TAIL_MAX_BYTES);
    expect(body.meta?.truncated).toBe(true);
  });
});

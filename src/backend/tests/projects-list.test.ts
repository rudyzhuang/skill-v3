import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Env } from '../src/index';
import { insertProject, insertUser } from '../src/db/schema';
import { hashPassword } from '../src/services/password';
import { resetBootstrapForTests } from '../src/services/bootstrap-admin';
import { SESSION_COOKIE } from '../src/services/session';
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

async function seedUser(
  env: Env,
  email: string,
  password: string,
): Promise<void> {
  await insertUser(env.DB, {
    id: crypto.randomUUID(),
    email: email.toLowerCase(),
    password_hash: await hashPassword(password),
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

async function seedProject(
  env: Env,
  data: {
    id: string;
    name_zh: string;
    name_en: string;
    status?: 'active' | 'blocked' | 'completed' | 'unknown';
    client_targets?: string;
    pipeline_summary?: string | null;
    updated_at: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await insertProject(env.DB, {
    id: data.id,
    name_zh: data.name_zh,
    name_en: data.name_en,
    description: '测试项目简介',
    client_targets: data.client_targets ?? '["admin"]',
    status: data.status ?? 'active',
    is_new: 0,
    source: 'admin',
    root_path: null,
    pipeline_summary: data.pipeline_summary ?? null,
    created_at: now,
    updated_at: data.updated_at,
  });
}

describe('GET /api/projects', () => {
  beforeEach(() => {
    resetBootstrapForTests();
  });

  it('returns 401 without session', async () => {
    const env = makeEnv();
    const app = createApp();
    const res = await app.request('/api/projects', {}, env);
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty items when no projects', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects',
      { headers: { Cookie: cookie } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('returns project summaries with session', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    await seedProject(env, {
      id: 'proj-1',
      name_zh: '测试项目',
      name_en: 'Test Project',
      client_targets: '["admin","backend"]',
      pipeline_summary: 'stage: design',
      updated_at: '2026-05-01T10:00:00.000Z',
    });
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects',
      { headers: { Cookie: cookie } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        name_zh: string;
        name_en: string;
        status: string;
        client_targets: string[];
        pipeline_summary: string | null;
        updated_at: string;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 'proj-1',
      name_zh: '测试项目',
      name_en: 'Test Project',
      status: 'active',
      client_targets: ['admin', 'backend'],
      pipeline_summary: 'stage: design',
    });
    expect(JSON.stringify(body)).not.toContain('password');
    expect(JSON.stringify(body)).not.toContain('API_KEY');
  });

  it('filters by status', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    await seedProject(env, {
      id: 'a',
      name_zh: '活跃',
      name_en: 'Active',
      status: 'active',
      updated_at: '2026-05-02T00:00:00.000Z',
    });
    await seedProject(env, {
      id: 'b',
      name_zh: '阻塞',
      name_en: 'Blocked',
      status: 'blocked',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects?status=blocked',
      { headers: { Cookie: cookie } },
      env,
    );

    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('b');
  });

  it('filters by q on zh or en name', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    await seedProject(env, {
      id: 'match-zh',
      name_zh: 'E2E 专用',
      name_en: 'Other',
      updated_at: '2026-05-03T00:00:00.000Z',
    });
    await seedProject(env, {
      id: 'match-en',
      name_zh: '其他',
      name_en: 'E2E Suite',
      updated_at: '2026-05-02T00:00:00.000Z',
    });
    await seedProject(env, {
      id: 'no-match',
      name_zh: '无关',
      name_en: 'Unrelated',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects?q=E2E',
      { headers: { Cookie: cookie } },
      env,
    );

    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id).sort()).toEqual(['match-en', 'match-zh']);
  });

  it('orders by updated_at DESC by default', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    await seedProject(env, {
      id: 'old',
      name_zh: '旧',
      name_en: 'Old',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await seedProject(env, {
      id: 'new',
      name_zh: '新',
      name_en: 'New',
      updated_at: '2026-06-01T00:00:00.000Z',
    });
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects',
      { headers: { Cookie: cookie } },
      env,
    );

    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('returns 400 for invalid status', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects?status=invalid',
      { headers: { Cookie: cookie } },
      env,
    );

    expect(res.status).toBe(400);
  });
});

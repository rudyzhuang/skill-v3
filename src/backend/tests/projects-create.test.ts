import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Env } from '../src/index';
import { insertUser } from '../src/db/schema';
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
  role: string,
): Promise<void> {
  await insertUser(env.DB, {
    id: crypto.randomUUID(),
    email: email.toLowerCase(),
    password_hash: await hashPassword(password),
    role: role as 'admin',
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

async function loginCookie(
  env: Env,
  email = 'admin@example.com',
  password = 'correct-password',
): Promise<string> {
  const app = createApp();
  const res = await app.request(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    env,
  );
  return extractCookie(res.headers.get('Set-Cookie'));
}

const validBody = {
  name_zh: '新建项目中文',
  name_en: 'New Project EN',
  description: '项目简介内容',
  client_targets: ['admin', 'backend'],
  is_new: true,
};

describe('POST /api/projects', () => {
  beforeEach(() => {
    resetBootstrapForTests();
  });

  it('returns 401 without session', async () => {
    const env = makeEnv();
    const app = createApp();
    const res = await app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for operator role', async () => {
    const env = makeEnv();
    await seedUser(env, 'op@example.com', 'correct-password', 'operator');
    const cookie = await loginCookie(env, 'op@example.com');
    const app = createApp();

    const res = await app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      env,
    );

    expect(res.status).toBe(403);
  });

  it('returns 201 for admin with valid body', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password', 'admin');
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      env,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name_zh: string;
      name_en: string;
      status: string;
      client_targets: string[];
      is_new: boolean;
      source: string;
      updated_at: string;
    };
    expect(body).toMatchObject({
      name_zh: validBody.name_zh,
      name_en: validBody.name_en,
      status: 'active',
      client_targets: ['admin', 'backend'],
      is_new: true,
      source: 'admin',
    });
    expect(body.id).toBeTruthy();
    expect(body.updated_at).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('password');
    expect(JSON.stringify(body)).not.toContain('API_KEY');
  });

  it('returns 201 for super_admin', async () => {
    const env = makeEnv();
    await seedUser(env, 'super@example.com', 'correct-password', 'super_admin');
    const cookie = await loginCookie(env, 'super@example.com');
    const app = createApp();

    const res = await app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, name_zh: '超管创建' }),
      },
      env,
    );

    expect(res.status).toBe(201);
  });

  it('returns 400 with errors for missing required fields', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password', 'admin');
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_targets: ['admin'], is_new: false }),
      },
      env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: string[] };
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('returns 400 for invalid client_targets', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password', 'admin');
    const cookie = await loginCookie(env);
    const app = createApp();

    const res = await app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validBody,
          client_targets: ['invalid-client'],
        }),
      },
      env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors.some((e) => e.includes('client_targets'))).toBe(true);
  });

  it('created project appears in GET /api/projects with matching fields', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password', 'admin');
    const cookie = await loginCookie(env);
    const app = createApp();

    const createRes = await app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validBody,
          name_zh: '列表可查中文',
          name_en: 'Listable EN',
          is_new: false,
        }),
      },
      env,
    );
    const created = (await createRes.json()) as {
      id: string;
      name_zh: string;
      name_en: string;
      status: string;
      client_targets: string[];
      is_new: boolean;
    };

    const listRes = await app.request(
      '/api/projects',
      { headers: { Cookie: cookie } },
      env,
    );
    const list = (await listRes.json()) as {
      items: Array<{
        id: string;
        name_zh: string;
        name_en: string;
        status: string;
        client_targets: string[];
        is_new: boolean;
      }>;
    };

    const found = list.items.find((p) => p.id === created.id);
    expect(found).toBeDefined();
    expect(found).toMatchObject({
      name_zh: created.name_zh,
      name_en: created.name_en,
      status: created.status,
      client_targets: created.client_targets,
      is_new: created.is_new,
    });
  });

  it('persists is_new in database', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password', 'admin');
    const cookie = await loginCookie(env);
    const app = createApp();

    const createRes = await app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, is_new: true }),
      },
      env,
    );
    const created = (await createRes.json()) as { id: string; is_new: boolean };
    expect(created.is_new).toBe(true);

    const row = await env.DB.prepare(
      'SELECT is_new FROM projects WHERE id = ?',
    )
      .bind(created.id)
      .first<{ is_new: number }>();
    expect(row?.is_new).toBe(1);
  });
});

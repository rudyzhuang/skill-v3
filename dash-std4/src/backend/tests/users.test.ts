import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Env } from '../src/index';
import { hashPassword } from '../src/services/password';
import { insertUser } from '../src/db/schema';
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
  role: 'admin' | 'operator' | 'super_admin' = 'admin',
  isBootstrap = 0,
): Promise<string> {
  const id = crypto.randomUUID();
  await insertUser(env.DB, {
    id,
    email: email.toLowerCase(),
    password_hash: await hashPassword(password),
    role,
    status: 'active',
    is_bootstrap: isBootstrap,
    created_at: new Date().toISOString(),
  });
  return id;
}

function extractCookie(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  const match = setCookie!.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  expect(match).toBeTruthy();
  return `${SESSION_COOKIE}=${match![1]}`;
}

async function loginAs(
  app: ReturnType<typeof createApp>,
  env: Env,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.request(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    env,
  );
  expect(res.status).toBe(200);
  return extractCookie(res.headers.get('Set-Cookie'));
}

describe('users routes', () => {
  beforeEach(() => {
    resetBootstrapForTests();
  });

  it('GET /api/users returns 401 without session', async () => {
    const env = makeEnv();
    const app = createApp();
    const res = await app.request('/api/users', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/users returns 403 for operator session', async () => {
    const env = makeEnv();
    await seedUser(env, 'op@example.com', 'op-pass', 'operator');
    const app = createApp();
    const cookie = await loginAs(app, env, 'op@example.com', 'op-pass');

    const res = await app.request('/api/users', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(403);
  });

  it('GET /api/users returns 200 with user list for admin', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'admin-pass', 'admin');
    const app = createApp();
    const cookie = await loginAs(app, env, 'admin@example.com', 'admin-pass');

    const res = await app.request('/api/users', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        email: string;
        role: string;
        status: string;
        created_at: string;
      }>;
    };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const item = body.items.find((u) => u.email === 'admin@example.com');
    expect(item).toBeTruthy();
    expect(item!.role).toBe('admin');
    expect(item!.status).toBe('active');
    expect(item!.created_at).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('password_hash');
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('POST /api/users returns 201 and user can login', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'admin-pass', 'admin');
    const app = createApp();
    const cookie = await loginAs(app, env, 'admin@example.com', 'admin-pass');

    const createRes = await app.request(
      '/api/users',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          email: 'new-op@example.com',
          password: 'NewUserPass123!',
          role: 'operator',
        }),
      },
      env,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      user: { email: string; role: string };
    };
    expect(created.user.email).toBe('new-op@example.com');
    expect(created.user.role).toBe('operator');
    expect(JSON.stringify(created)).not.toContain('NewUserPass123!');

    const loginRes = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'new-op@example.com',
          password: 'NewUserPass123!',
        }),
      },
      env,
    );
    expect(loginRes.status).toBe(200);
  });

  it('POST /api/users returns 409 for duplicate email', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'admin-pass', 'admin');
    await seedUser(env, 'taken@example.com', 'pass', 'operator');
    const app = createApp();
    const cookie = await loginAs(app, env, 'admin@example.com', 'admin-pass');

    const res = await app.request(
      '/api/users',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          email: 'taken@example.com',
          password: 'AnotherPass123!',
          role: 'operator',
        }),
      },
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('邮箱');
    expect(JSON.stringify(body)).not.toContain('AnotherPass123!');
  });

  it('PATCH /api/users/:id updates non-bootstrap user', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'admin-pass', 'admin');
    const targetId = await seedUser(env, 'target@example.com', 'target-pass', 'operator');
    const app = createApp();
    const cookie = await loginAs(app, env, 'admin@example.com', 'admin-pass');

    const res = await app.request(
      `/api/users/${targetId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ status: 'disabled' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { status: string } };
    expect(body.user.status).toBe('disabled');
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('PATCH /api/users/:id forbids disabling bootstrap user', async () => {
    const env = makeEnv();
    const bootstrapId = await seedUser(
      env,
      'bootstrap@example.com',
      'bootstrap-pass',
      'admin',
      1,
    );
    await seedUser(env, 'admin@example.com', 'admin-pass', 'admin');
    const app = createApp();
    const cookie = await loginAs(app, env, 'admin@example.com', 'admin-pass');

    const disableRes = await app.request(
      `/api/users/${bootstrapId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ status: 'disabled' }),
      },
      env,
    );
    expect([400, 403]).toContain(disableRes.status);

    const downgradeRes = await app.request(
      `/api/users/${bootstrapId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ role: 'operator' }),
      },
      env,
    );
    expect([400, 403]).toContain(downgradeRes.status);
  });

  it('bootstrap admin is created with is_bootstrap on first request', async () => {
    const env = makeEnv({
      ADMIN_EMAIL: 'bootstrap@example.com',
      ADMIN_PASSWORD: 'bootstrap-pass',
    });
    const app = createApp();

    await app.request('/health', {}, env);

    await seedUser(env, 'admin@example.com', 'admin-pass', 'admin');
    const cookie = await loginAs(app, env, 'admin@example.com', 'admin-pass');

    const listRes = await app.request('/api/users', { headers: { Cookie: cookie } }, env);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      items: Array<{ email: string; is_bootstrap: boolean }>;
    };
    const bootstrap = body.items.find((u) => u.email === 'bootstrap@example.com');
    expect(bootstrap).toBeTruthy();
    expect(bootstrap!.is_bootstrap).toBe(true);
  });

  it('DELETE /api/users is not available', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'admin-pass', 'admin');
    const app = createApp();
    const cookie = await loginAs(app, env, 'admin@example.com', 'admin-pass');

    const res = await app.request(
      '/api/users/some-id',
      { method: 'DELETE', headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(404);
  });
});

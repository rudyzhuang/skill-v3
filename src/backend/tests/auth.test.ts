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
): Promise<void> {
  await insertUser(env.DB, {
    id: crypto.randomUUID(),
    email: email.toLowerCase(),
    password_hash: await hashPassword(password),
    role,
    status: 'active',
    is_bootstrap: 0,
    created_at: new Date().toISOString(),
  });
}

function extractCookie(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  const match = setCookie!.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  expect(match).toBeTruthy();
  return `${SESSION_COOKIE}=${match![1]}`;
}

describe('auth routes', () => {
  beforeEach(() => {
    resetBootstrapForTests();
  });

  it('POST /api/auth/login returns 200 and Set-Cookie for valid credentials', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
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

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);

    const body = (await res.json()) as { user: { email: string; role: string } };
    expect(body.user.email).toBe('admin@example.com');
    expect(body.user.role).toBe('admin');
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('POST /api/auth/login returns 401 with generic error for wrong password', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    const app = createApp();

    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'wrong-password',
        }),
      },
      env,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('邮箱或密码不正确');
    expect(body.error).not.toContain('默认');
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('GET /api/auth/me returns 401 without session', async () => {
    const env = makeEnv();
    const app = createApp();
    const res = await app.request('/api/auth/me', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me returns user with valid session cookie', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    const app = createApp();

    const loginRes = await app.request(
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
    const cookie = extractCookie(loginRes.headers.get('Set-Cookie'));

    const meRes = await app.request(
      '/api/auth/me',
      { headers: { Cookie: cookie } },
      env,
    );
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { user: { email: string } };
    expect(me.user.email).toBe('admin@example.com');
  });

  it('POST /api/auth/logout clears session; old cookie cannot access me', async () => {
    const env = makeEnv();
    await seedUser(env, 'admin@example.com', 'correct-password');
    const app = createApp();

    const loginRes = await app.request(
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
    const cookie = extractCookie(loginRes.headers.get('Set-Cookie'));

    const logoutRes = await app.request(
      '/api/auth/logout',
      { method: 'POST', headers: { Cookie: cookie } },
      env,
    );
    expect(logoutRes.status).toBe(200);

    const meRes = await app.request(
      '/api/auth/me',
      { headers: { Cookie: cookie } },
      env,
    );
    expect(meRes.status).toBe(401);
  });

  it('POST /api/auth/logout is idempotent without session', async () => {
    const env = makeEnv();
    const app = createApp();
    const res = await app.request('/api/auth/logout', { method: 'POST' }, env);
    expect(res.status).toBe(200);
  });

  it('bootstrap creates admin from env on first request', async () => {
    const env = makeEnv({
      ADMIN_EMAIL: 'bootstrap@example.com',
      ADMIN_PASSWORD: 'bootstrap-pass',
    });
    const app = createApp();

    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'bootstrap@example.com',
          password: 'bootstrap-pass',
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
  });
});

import { Hono } from 'hono';
import {
  cookieOptionsFromEnv,
  getCurrentUser,
  LOGIN_ERROR_MESSAGE,
  loginWithCredentials,
  logout,
  type AppEnv,
} from '../services/auth';
import {
  buildClearSessionCookie,
  buildSessionCookie,
} from '../services/session';

export const authRoutes = new Hono<{ Bindings: AppEnv }>();

authRoutes.post('/login', async (c) => {
  let body: { email?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: LOGIN_ERROR_MESSAGE }, 401);
  }

  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return c.json({ error: LOGIN_ERROR_MESSAGE }, 401);
  }

  const result = await loginWithCredentials(c.env, email, password);
  if (!result.ok) {
    return c.json({ error: LOGIN_ERROR_MESSAGE }, 401);
  }

  const cookieOpts = cookieOptionsFromEnv(c.env);
  const setCookie = buildSessionCookie(
    result.sessionId,
    result.expiresAt,
    cookieOpts,
  );

  return c.json({ user: result.user }, 200, {
    'Set-Cookie': setCookie,
  });
});

authRoutes.post('/logout', async (c) => {
  await logout(c.env, c.req.header('Cookie'));
  const cookieOpts = cookieOptionsFromEnv(c.env);
  return c.json({ ok: true }, 200, {
    'Set-Cookie': buildClearSessionCookie(cookieOpts),
  });
});

authRoutes.get('/me', async (c) => {
  const user = await getCurrentUser(c.env, c.req.header('Cookie'));
  if (!user) {
    return c.json({ error: '未授权' }, 401);
  }
  return c.json({ user });
});

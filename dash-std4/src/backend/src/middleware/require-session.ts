import type { Context, Next } from 'hono';
import { getCurrentUser, type AppEnv } from '../services/auth';

export type AuthVariables = {
  user: { id: string; email: string; role: string };
};

export async function requireSession(
  c: Context<{ Bindings: AppEnv; Variables: AuthVariables }>,
  next: Next,
): Promise<Response | void> {
  const user = await getCurrentUser(c.env, c.req.header('Cookie'));
  if (!user) {
    return c.json({ error: '未授权' }, 401);
  }
  c.set('user', user);
  await next();
}

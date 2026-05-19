import type { Context, Next } from 'hono';
import { ADMIN_ROLES, type UserRole } from '../db/schema';
import type { AppEnv } from '../services/auth';
import type { AuthVariables } from './require-session';

export async function requireAdmin(
  c: Context<{ Bindings: AppEnv; Variables: AuthVariables }>,
  next: Next,
): Promise<Response | void> {
  const user = c.get('user');
  if (!ADMIN_ROLES.includes(user.role as UserRole)) {
    return c.json({ error: '无权限' }, 403);
  }
  await next();
}

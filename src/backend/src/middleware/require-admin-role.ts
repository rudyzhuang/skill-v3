import type { Context, Next } from 'hono';
import type { AppEnv } from '../services/auth';
import type { AuthVariables } from './require-session';

const ADMIN_WRITE_ROLES = new Set(['admin', 'super_admin']);

export async function requireAdminRole(
  c: Context<{ Bindings: AppEnv; Variables: AuthVariables }>,
  next: Next,
): Promise<Response | void> {
  const user = c.get('user');
  if (!ADMIN_WRITE_ROLES.has(user.role)) {
    return c.json({ error: '无权限' }, 403);
  }
  await next();
}

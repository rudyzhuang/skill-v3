import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../middleware/require-session';
import type { AppEnv } from '../services/auth';
import {
  listProjectsForAdmin,
  parseAdminListQuery,
} from '../services/projects-list';

export const projectsRoutes = new Hono<{
  Bindings: AppEnv;
  Variables: AuthVariables;
}>();

projectsRoutes.use('*', requireSession);

projectsRoutes.get('/', async (c) => {
  const parsed = parseAdminListQuery(new URL(c.req.url).searchParams);
  if ('error' in parsed) {
    return c.json({ error: parsed.error }, 400);
  }

  const result = await listProjectsForAdmin(c.env.DB, parsed.query);
  return c.json(result);
});

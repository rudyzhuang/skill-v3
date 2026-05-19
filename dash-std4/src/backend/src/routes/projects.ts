import { Hono } from 'hono';
import { requireAdminRole } from '../middleware/require-admin-role';
import { requireSession, type AuthVariables } from '../middleware/require-session';
import type { AppEnv } from '../services/auth';
import { createProjectForAdmin } from '../services/projects-create';
import {
  listProjectsForAdmin,
  parseAdminListQuery,
} from '../services/projects-list';
import { validateCreateProjectBody } from '../validators/project-create';

export const projectsRoutes = new Hono<{
  Bindings: AppEnv;
  Variables: AuthVariables;
}>();

projectsRoutes.use('*', requireSession);

projectsRoutes.post('/', requireAdminRole, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: ['请求体须为有效 JSON'] }, 400);
  }

  const parsed = validateCreateProjectBody(body);
  if (!parsed.ok) {
    return c.json({ errors: parsed.errors }, 400);
  }

  const created = await createProjectForAdmin(c.env.DB, parsed.data);
  return c.json(created, 201);
});

projectsRoutes.get('/', async (c) => {
  const parsed = parseAdminListQuery(new URL(c.req.url).searchParams);
  if ('error' in parsed) {
    return c.json({ error: parsed.error }, 400);
  }

  const result = await listProjectsForAdmin(c.env.DB, parsed.query);
  return c.json(result);
});

import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../middleware/require-session';
import type { AppEnv } from '../services/auth';
import {
  listProjectsForAdmin,
  parseAdminListQuery,
} from '../services/projects-list';
import { getPipelineDashboard } from '../services/pipeline-dashboard';

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

projectsRoutes.get('/:id/pipeline', async (c) => {
  const projectId = c.req.param('id');
  const dashboard = await getPipelineDashboard(c.env.DB, projectId, {
    PIPELINE_FS_FALLBACK: c.env.PIPELINE_FS_FALLBACK,
  });

  if (!dashboard) {
    return c.json({ error: '项目不存在' }, 404);
  }

  return c.json(dashboard);
});

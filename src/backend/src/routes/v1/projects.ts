import { Hono } from 'hono';
import { apiKeyAuth, type ApiKeyAuthVariables } from '../../middleware/api-key-auth';
import { getProjectById, listProjects, parseListQuery } from '../../services/projects-query';
import type { Env } from '../../index';

const projectsV1 = new Hono<{
  Bindings: Env;
  Variables: ApiKeyAuthVariables;
}>();

projectsV1.use('*', apiKeyAuth);

projectsV1.get('/', async (c) => {
  const params = parseListQuery(new URL(c.req.url).searchParams);
  const body = await listProjects(c.env.DB, params);
  return c.json(body);
});

projectsV1.get('/:id', async (c) => {
  const id = c.req.param('id');
  const project = await getProjectById(c.env.DB, id);

  if (!project) {
    return c.json({ error: 'Project not found', code: 'not_found' }, 404);
  }

  return c.json(project);
});

export { projectsV1 };

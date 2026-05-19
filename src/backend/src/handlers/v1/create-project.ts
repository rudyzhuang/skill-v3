import type { Context } from 'hono';
import type { ApiKeyAuthVariables } from '../../middleware/api-key-auth';
import { createOpenApiProject } from '../../services/projects-write';
import type { Env } from '../../index';
import { validateOpenApiProjectCreate } from '../../validators/open-api-project-create';

export async function handleCreateProject(
  c: Context<{ Bindings: Env; Variables: ApiKeyAuthVariables }>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: ['请求体须为合法 JSON'] }, 400);
  }

  const validated = validateOpenApiProjectCreate(body);
  if (!validated.ok) {
    return c.json({ errors: validated.errors }, 400);
  }

  const created = await createOpenApiProject(c.env.DB, validated.data);
  return c.json(
    {
      id: created.id,
      name_zh: created.name_zh,
      name_en: created.name_en,
      status: created.status,
      client_targets: created.client_targets,
      is_new: created.is_new,
      source: created.source,
      updated_at: created.updated_at,
    },
    201,
  );
}

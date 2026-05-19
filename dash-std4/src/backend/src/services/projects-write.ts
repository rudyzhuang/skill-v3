import type { OpenApiProjectCreateInput } from '../validators/open-api-project-create';
import type { ProjectStatus } from '../types/project';

export interface CreatedProject {
  id: string;
  name_zh: string;
  name_en: string;
  description: string;
  client_targets: OpenApiProjectCreateInput['client_targets'];
  status: ProjectStatus;
  is_new: boolean;
  source: 'open_api';
  updated_at: string;
}

export async function projectExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM projects WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ id: string }>();
  return row !== null;
}

export async function createOpenApiProject(
  db: D1Database,
  input: OpenApiProjectCreateInput,
): Promise<CreatedProject> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status: ProjectStatus = 'active';

  await db
    .prepare(
      `INSERT INTO projects (
        id, name_zh, name_en, description, client_targets, status, is_new,
        source, root_path, pipeline_summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open_api', NULL, NULL, ?, ?)`,
    )
    .bind(
      id,
      input.name_zh,
      input.name_en,
      input.description,
      JSON.stringify(input.client_targets),
      status,
      input.is_new ? 1 : 0,
      now,
      now,
    )
    .run();

  return {
    id,
    name_zh: input.name_zh,
    name_en: input.name_en,
    description: input.description,
    client_targets: input.client_targets,
    status,
    is_new: input.is_new,
    source: 'open_api',
    updated_at: now,
  };
}

import type { D1Database } from '@cloudflare/workers-types';
import { insertProject } from '../db/schema';
import type { ClientTarget } from '../types/project-summary';
import type { CreateProjectInput } from '../validators/project-create';

export interface CreatedProjectDto {
  id: string;
  name_zh: string;
  name_en: string;
  status: 'active';
  client_targets: ClientTarget[];
  is_new: boolean;
  source: 'admin';
  updated_at: string;
}

function newProjectId(): string {
  return crypto.randomUUID();
}

export async function createProjectForAdmin(
  db: D1Database,
  input: CreateProjectInput,
): Promise<CreatedProjectDto> {
  const now = new Date().toISOString();
  const id = newProjectId();
  const clientTargetsJson = JSON.stringify(input.client_targets);

  await insertProject(db, {
    id,
    name_zh: input.name_zh,
    name_en: input.name_en,
    description: input.description,
    client_targets: clientTargetsJson,
    status: 'active',
    is_new: input.is_new ? 1 : 0,
    source: 'admin',
    root_path: null,
    pipeline_summary: null,
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    name_zh: input.name_zh,
    name_en: input.name_en,
    status: 'active',
    client_targets: input.client_targets as ClientTarget[],
    is_new: input.is_new,
    source: 'admin',
    updated_at: now,
  };
}

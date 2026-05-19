import { apiFetch } from './client';

export type ProjectStatus = 'active' | 'blocked' | 'completed' | 'unknown';

export interface ProjectSummary {
  id: string;
  name_zh: string;
  name_en: string;
  status: ProjectStatus;
  client_targets: string[];
  is_new: boolean;
  pipeline_summary: string | null;
  updated_at: string;
}

export interface ProjectListResponse {
  items: ProjectSummary[];
}

export interface ListProjectsParams {
  status?: ProjectStatus | '';
  q?: string;
  sort?: 'updated_at_desc';
}

export async function fetchProjects(
  params: ListProjectsParams = {},
): Promise<ProjectListResponse> {
  const search = new URLSearchParams();
  if (params.status) {
    search.set('status', params.status);
  }
  if (params.q?.trim()) {
    search.set('q', params.q.trim());
  }
  if (params.sort) {
    search.set('sort', params.sort);
  }
  const qs = search.toString();
  const path = qs ? `/api/projects?${qs}` : '/api/projects';
  return apiFetch<ProjectListResponse>(path);
}

export interface CreateProjectPayload {
  name_zh: string;
  name_en: string;
  description: string;
  client_targets: string[];
  is_new: boolean;
}

export interface CreatedProject {
  id: string;
  name_zh: string;
  name_en: string;
  status: ProjectStatus;
  client_targets: string[];
  is_new: boolean;
  source: 'admin';
  updated_at: string;
}

export async function createProject(
  body: CreateProjectPayload,
): Promise<CreatedProject> {
  return apiFetch<CreatedProject>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export const PROJECT_STATUSES = ['active', 'blocked', 'completed', 'unknown'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ALLOWED_CLIENT_TARGETS = ['admin', 'backend'] as const;
export type ClientTarget = (typeof ALLOWED_CLIENT_TARGETS)[number];

export interface ProjectSummary {
  id: string;
  name_zh: string;
  name_en: string;
  status: ProjectStatus;
  client_targets: ClientTarget[];
  updated_at: string;
}

export interface ProjectDetail {
  id: string;
  name_zh: string;
  name_en: string;
  description: string | null;
  client_targets: ClientTarget[];
  status: ProjectStatus;
  is_new: boolean;
  updated_at: string;
  created_at: string;
  root_path: string | null;
  pipeline_status: string | null;
  /** Present when stored client_targets contained values outside admin|backend */
  client_targets_note?: string;
}

export interface ProjectListResponse {
  items: ProjectSummary[];
  total: number;
  page: number;
  page_size: number;
}

export interface ApiErrorBody {
  error: string;
  code?: string;
}

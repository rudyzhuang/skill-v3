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
  is_new: boolean;
  pipeline_summary: string | null;
  updated_at: string;
}

export interface ProjectListItemsResponse {
  items: ProjectSummary[];
}

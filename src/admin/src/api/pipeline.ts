import { apiFetch } from './client';

export type PipelineDataStatus = 'ok' | 'empty' | 'partial';

export interface PipelineStageRow {
  id: string;
  name: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface PipelineFeatureRow {
  feature_id: string;
  name: string;
  phase: string | null;
  status: string;
  current_stage: string | null;
  dependencies: string[];
}

export interface PipelineBlockingIssue {
  message: string;
  stage: string | null;
  severity: string | null;
}

export interface PipelineDashboardProject {
  id: string;
  name_zh: string;
  name_en: string;
  status: string;
  client_targets: string[];
}

export interface PipelineDashboardResponse {
  project: PipelineDashboardProject;
  current_stage: string | null;
  last_completed_stage: string | null;
  stages: PipelineStageRow[];
  features: PipelineFeatureRow[];
  blocking_issues: PipelineBlockingIssue[];
  log_tail: string;
  data_status: PipelineDataStatus;
  synced_at: string | null;
  meta?: { truncated?: boolean };
}

export function pipelineApiPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/pipeline`;
}

export function dashboardPagePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/dashboard`;
}

export async function fetchPipelineDashboard(
  projectId: string,
): Promise<PipelineDashboardResponse> {
  return apiFetch<PipelineDashboardResponse>(pipelineApiPath(projectId));
}

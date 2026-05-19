import type {
  NormalizedBlockingIssue,
  NormalizedFeatureRow,
  NormalizedStageRow,
} from '../lib/pipeline-normalize';

export type PipelineDataStatus = 'ok' | 'empty' | 'partial';

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
  stages: NormalizedStageRow[];
  features: NormalizedFeatureRow[];
  blocking_issues: NormalizedBlockingIssue[];
  log_tail: string;
  data_status: PipelineDataStatus;
  synced_at: string | null;
  meta?: { truncated?: boolean };
}

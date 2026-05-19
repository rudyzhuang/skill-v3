import type { D1Database } from '@cloudflare/workers-types';
import { normalizeClientTargets } from '../lib/client-targets';
import { truncateLogTail } from '../lib/log-tail-truncate';
import {
  buildPipelineSummary,
  normalizePipelinePayload,
  type NormalizedPipelinePayload,
} from '../lib/pipeline-normalize';
import type {
  PipelineDashboardResponse,
  PipelineDataStatus,
} from '../types/pipeline-dashboard';
import { findProjectById, type ProjectRow } from '../db/schema';

const MAX_STAGE_ROWS = 50;
const MAX_FEATURE_ROWS = 50;

export interface PipelineDashboardEnv {
  PIPELINE_FS_FALLBACK?: string;
}

interface SnapshotRow {
  payload_json: string;
  updated_at: string;
}

async function loadLatestSnapshot(
  db: D1Database,
  projectId: string,
): Promise<{ raw: unknown; updatedAt: string } | null> {
  const row = await db
    .prepare(
      `SELECT payload_json, updated_at FROM pipeline_snapshots
       WHERE project_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(projectId)
    .first<SnapshotRow>();

  if (!row?.payload_json?.trim()) {
    return null;
  }

  try {
    return {
      raw: JSON.parse(row.payload_json) as unknown,
      updatedAt: row.updated_at,
    };
  } catch {
    return { raw: null, updatedAt: row.updated_at };
  }
}

async function tryDevFilesystemFallback(
  rootPath: string | null,
  env: PipelineDashboardEnv,
): Promise<unknown | null> {
  if (env.PIPELINE_FS_FALLBACK !== 'true' || !rootPath?.trim()) {
    return null;
  }
  try {
    const { readStagesJsonFromRoot } = await import('../lib/pipeline-dev-fs');
    return readStagesJsonFromRoot(rootPath.trim());
  } catch {
    return null;
  }
}

function resolveDataStatus(
  normalized: NormalizedPipelinePayload,
  hadSnapshot: boolean,
  hadDevFile: boolean,
): PipelineDataStatus {
  const hasContent =
    normalized.stages.length > 0 ||
    normalized.features.length > 0 ||
    normalized.current_stage !== null;

  if (!hadSnapshot && !hadDevFile) {
    return 'empty';
  }

  if (!hasContent) {
    return 'partial';
  }

  return 'ok';
}

function capRows<T>(rows: T[], max: number): T[] {
  return rows.length > max ? rows.slice(0, max) : rows;
}

function projectToDashboardProject(row: ProjectRow): PipelineDashboardResponse['project'] {
  const { targets } = normalizeClientTargets(row.client_targets);
  return {
    id: row.id,
    name_zh: row.name_zh,
    name_en: row.name_en,
    status: row.status,
    client_targets: targets,
  };
}

export async function getPipelineDashboard(
  db: D1Database,
  projectId: string,
  env: PipelineDashboardEnv = {},
): Promise<PipelineDashboardResponse | null> {
  const project = await findProjectById(db, projectId);
  if (!project) {
    return null;
  }

  const snapshot = await loadLatestSnapshot(db, projectId);
  let rawPayload: unknown = snapshot?.raw ?? null;
  let syncedAt: string | null = snapshot?.updatedAt ?? null;
  const hadSnapshot = snapshot !== null;

  let hadDevFile = false;
  if (rawPayload === null || rawPayload === undefined) {
    const fromFs = await tryDevFilesystemFallback(project.root_path, env);
    if (fromFs !== null) {
      rawPayload = fromFs;
      hadDevFile = true;
      if (!syncedAt) {
        syncedAt = new Date().toISOString();
      }
    }
  }

  const normalized = normalizePipelinePayload(rawPayload);
  const { text: logTail, truncated } = truncateLogTail(normalized.log_tail);
  const dataStatus = resolveDataStatus(normalized, hadSnapshot, hadDevFile);

  const response: PipelineDashboardResponse = {
    project: projectToDashboardProject(project),
    current_stage: normalized.current_stage,
    last_completed_stage: normalized.last_completed_stage,
    stages: capRows(normalized.stages, MAX_STAGE_ROWS),
    features: capRows(normalized.features, MAX_FEATURE_ROWS),
    blocking_issues: normalized.blocking_issues,
    log_tail: logTail,
    data_status: dataStatus,
    synced_at: syncedAt,
  };

  if (truncated) {
    response.meta = { truncated: true };
  }

  const summary = buildPipelineSummary(normalized);
  await db
    .prepare(`UPDATE projects SET pipeline_summary = ?, updated_at = ? WHERE id = ?`)
    .bind(summary, new Date().toISOString(), projectId)
    .run();

  return response;
}

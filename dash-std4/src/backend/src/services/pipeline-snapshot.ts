import {
  buildPipelineSummary,
  normalizePipelinePayload,
  type NormalizedPipelinePayload,
} from '../lib/pipeline-normalize';
import type { PipelineUpsertInput } from '../validators/pipeline-upsert';

export interface PipelineSnapshotSummary {
  snapshot_id: string;
  project_id: string;
  stages_hash: string | null;
  updated_at: string;
  current_stage: string | null;
  stages_count: number;
  features_count: number;
  blocking_count: number;
}

async function hashStagesJson(stagesJson: string): Promise<string> {
  const data = new TextEncoder().encode(stagesJson);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function upsertPipelineSnapshot(
  db: D1Database,
  projectId: string,
  input: PipelineUpsertInput,
): Promise<{ normalized: NormalizedPipelinePayload; summary: PipelineSnapshotSummary }> {
  const normalized = normalizePipelinePayload(input);
  const payloadJson = JSON.stringify(normalized);
  const stagesHash = await hashStagesJson(JSON.stringify(normalized.stages));
  const snapshotId = `snap-${projectId}`;
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO pipeline_snapshots (id, project_id, payload_json, stages_hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json,
         stages_hash = excluded.stages_hash,
         updated_at = excluded.updated_at`,
    )
    .bind(snapshotId, projectId, payloadJson, stagesHash, now)
    .run();

  const pipelineSummary = buildPipelineSummary(normalized);
  await db
    .prepare(`UPDATE projects SET pipeline_summary = ?, updated_at = ? WHERE id = ?`)
    .bind(pipelineSummary, now, projectId)
    .run();

  return {
    normalized,
    summary: {
      snapshot_id: snapshotId,
      project_id: projectId,
      stages_hash: stagesHash,
      updated_at: now,
      current_stage: normalized.current_stage,
      stages_count: normalized.stages.length,
      features_count: normalized.features.length,
      blocking_count: normalized.blocking_issues.length,
    },
  };
}

export async function getLatestPipelinePayload(
  db: D1Database,
  projectId: string,
): Promise<NormalizedPipelinePayload | null> {
  const row = await db
    .prepare(
      `SELECT payload_json FROM pipeline_snapshots
       WHERE project_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(projectId)
    .first<{ payload_json: string }>();

  if (!row?.payload_json) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    return normalizePipelinePayload(parsed);
  } catch {
    return normalizePipelinePayload(null);
  }
}

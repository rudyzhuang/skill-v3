/**
 * Dash Open API 契约：PUT /api/v1/projects/:id/pipeline
 * 与 dash-std4 BACKEND-API-PIPELINE-001 / pipeline-upsert 校验对齐（类型与路径常量）。
 * 禁止在此文件写入任何密钥或默认 Base URL。
 */

/** ai-std4 `stages.json` 中 stage 状态枚举（与 schema 一致）。 */
export const PIPELINE_STAGE_STATUS_VALUES = [
  'started',
  'running',
  'completed',
  'failed',
  'skipped',
  'stopped',
  'pending_user_input',
] as const;

export type PipelineStageStatus = (typeof PIPELINE_STAGE_STATUS_VALUES)[number];

export type PipelineStageDash = {
  stage_id: string;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  blocking_issues?: string[];
};

export type PipelineFeatureDash = {
  feature_id: string;
  name: string;
  priority?: string;
  phase?: string;
  description?: string;
  client_targets?: string[];
  dependencies?: string[];
};

/**
 * 上报体（与 OpenAPI 示例字段集合对齐；服务端以 dash-std4 实现为准）。
 */
export type PipelineUpsertBody = {
  current_stage: string | null;
  stages: PipelineStageDash[];
  features: PipelineFeatureDash[];
  blocking_issues: string[];
  /** 单行或大段文本；客户端负责截断。 */
  log_tail: string;
  updated_at?: string | null;
  /** 优先取自 `pipeline.recovery_history` 最近项的 `run_id`。 */
  run_id?: string;
  /** 无 run_id 时由 CLI 生成的稳定关联 id（单次 reporter 生命周期内不变）。 */
  correlation_id?: string;
};

/** 与 dash-std4 文档对齐的客户端预处理上限（体积演进时可集中调整）。 */
export const PIPELINE_PAYLOAD_LIMITS = {
  /** log_tail 字符上限（UTF-16 长度近似；超额截断）。 */
  maxLogTailChars: 32_768,
  /** 整个 JSON 字节上限（近似；超额时裁剪 log_tail / blocking）。 */
  maxApproxJsonBytes: 480 * 1024,
} as const;

export function pipelineUpsertPath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline`;
}

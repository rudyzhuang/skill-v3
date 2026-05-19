import {
  PIPELINE_PAYLOAD_LIMITS,
  type PipelineFeatureDash,
  type PipelineStageDash,
  type PipelineUpsertBody,
} from '../../dash/contracts/pipeline-upsert.js';

export type MapStagesOptions = {
  /** 无 recovery run_id 时使用，应在 reporter 启动时生成并保持不变。 */
  correlationId: string;
  /** 已由 reporter 读取并脱敏的日志尾（可为空）。 */
  logTail?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function lastRecoveryRunId(pipeline: Record<string, unknown>): string | undefined {
  const hist = pipeline.recovery_history;
  if (!Array.isArray(hist) || hist.length === 0) return undefined;
  const last = hist[hist.length - 1];
  if (!isRecord(last)) return undefined;
  const rid = last.run_id;
  return typeof rid === 'string' && rid.length > 0 ? rid : undefined;
}

function collectBlockingIssues(stagesObj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(stagesObj)) {
    if (!isRecord(v)) continue;
    const bi = v.blocking_issues;
    if (!Array.isArray(bi)) continue;
    for (const x of bi) {
      if (typeof x === 'string' && x.trim()) out.push(x);
    }
  }
  return dedupePreserveOrder(out);
}

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const r: string[] = [];
  for (const x of items) {
    if (seen.has(x)) continue;
    seen.add(x);
    r.push(x);
  }
  return r;
}

function extractFeatures(stagesObj: Record<string, unknown>): PipelineFeatureDash[] {
  const prd = stagesObj.prd;
  if (!isRecord(prd)) return [];
  const outputs = prd.outputs;
  if (!isRecord(outputs)) return [];
  const features = outputs.features;
  if (!Array.isArray(features)) return [];
  const out: PipelineFeatureDash[] = [];
  for (const f of features) {
    if (!isRecord(f)) continue;
    const feature_id = f.feature_id;
    const name = f.name;
    if (typeof feature_id !== 'string' || typeof name !== 'string') continue;
    const row: PipelineFeatureDash = { feature_id, name };
    if (typeof f.priority === 'string') row.priority = f.priority;
    if (typeof f.phase === 'string') row.phase = f.phase;
    if (typeof f.description === 'string') row.description = f.description;
    if (Array.isArray(f.client_targets)) {
      row.client_targets = f.client_targets.filter((x): x is string => typeof x === 'string');
    }
    if (Array.isArray(f.dependencies)) {
      row.dependencies = f.dependencies.filter((x): x is string => typeof x === 'string');
    }
    out.push(row);
  }
  return out;
}

function mapStagesObject(stagesObj: Record<string, unknown>): PipelineStageDash[] {
  const rows: PipelineStageDash[] = [];
  for (const [stage_id, raw] of Object.entries(stagesObj)) {
    if (!isRecord(raw)) continue;
    const status = raw.status;
    if (typeof status !== 'string') continue;
    const row: PipelineStageDash = {
      stage_id,
      status,
      started_at: typeof raw.started_at === 'string' || raw.started_at === null ? (raw.started_at as string | null) : undefined,
      completed_at:
        typeof raw.completed_at === 'string' || raw.completed_at === null
          ? (raw.completed_at as string | null)
          : undefined,
    };
    if (Array.isArray(raw.blocking_issues)) {
      row.blocking_issues = raw.blocking_issues.filter((x): x is string => typeof x === 'string');
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.stage_id.localeCompare(b.stage_id));
  return rows;
}

function truncateChars(s: string, maxChars: number): { text: string; truncated: boolean } {
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars), truncated: true };
}

function approxUtf8Bytes(json: string): number {
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c <= 0x7f) bytes += 1;
    else if (c <= 0x7ff) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * 将 ai-std4 `.pipeline/stages.json` 解析后的对象映射为 Dash `pipeline-upsert` 体。
 */
export function mapStagesJsonToDashPayload(stagesRoot: unknown, opts: MapStagesOptions): PipelineUpsertBody {
  if (!isRecord(stagesRoot)) {
    throw new TypeError('stages.json root must be an object');
  }
  const pipeline = stagesRoot.pipeline;
  const stages = stagesRoot.stages;
  if (!isRecord(pipeline)) throw new TypeError('stages.json missing pipeline object');
  if (!isRecord(stages)) throw new TypeError('stages.json missing stages object');

  const current_stage =
    pipeline.current_stage === null ? null : typeof pipeline.current_stage === 'string' ? pipeline.current_stage : null;

  const stagesRows = mapStagesObject(stages);
  const features = extractFeatures(stages);
  const blocking_issues = collectBlockingIssues(stages);

  const run_id = lastRecoveryRunId(pipeline);
  const correlation_id = opts.correlationId;

  let log_tail = opts.logTail ?? '';

  const { text: lt, truncated: ltTrunc } = truncateChars(log_tail, PIPELINE_PAYLOAD_LIMITS.maxLogTailChars);
  log_tail = ltTrunc ? `${lt}\n…(log_tail truncated)` : lt;

  const body: PipelineUpsertBody = {
    current_stage,
    stages: stagesRows,
    features,
    blocking_issues,
    log_tail,
    updated_at: typeof pipeline.updated_at === 'string' || pipeline.updated_at === null ? (pipeline.updated_at as string | null) : undefined,
    ...(run_id ? { run_id } : { correlation_id }),
  };

  return shrinkPayloadToByteBudget(body);
}

function shrinkPayloadToByteBudget(body: PipelineUpsertBody): PipelineUpsertBody {
  let b = { ...body };
  let json = JSON.stringify(b);

  if (approxUtf8Bytes(json) <= PIPELINE_PAYLOAD_LIMITS.maxApproxJsonBytes) return b;

  // 1) 收紧 log_tail
  const halfTail = Math.max(2_048, Math.floor(PIPELINE_PAYLOAD_LIMITS.maxLogTailChars / 4));
  let { text } = truncateChars(b.log_tail, halfTail);
  b = { ...b, log_tail: `${text}\n…(log_tail truncated for payload size)` };
  json = JSON.stringify(b);
  if (approxUtf8Bytes(json) <= PIPELINE_PAYLOAD_LIMITS.maxApproxJsonBytes) return b;

  // 2) 裁剪 blocking_issues
  const bi = [...b.blocking_issues];
  while (bi.length > 1 && approxUtf8Bytes(JSON.stringify({ ...b, blocking_issues: bi })) > PIPELINE_PAYLOAD_LIMITS.maxApproxJsonBytes) {
    bi.pop();
  }
  b = {
    ...b,
    blocking_issues: bi.length === b.blocking_issues.length ? bi.slice(0, Math.max(1, Math.floor(bi.length / 2))) : bi,
  };
  b = {
    ...b,
    blocking_issues:
      b.blocking_issues.length === 0 && body.blocking_issues.length > 0
        ? [body.blocking_issues[0].slice(0, 512) + (body.blocking_issues[0].length > 512 ? '…' : '')]
        : b.blocking_issues,
  };
  json = JSON.stringify(b);
  if (approxUtf8Bytes(json) <= PIPELINE_PAYLOAD_LIMITS.maxApproxJsonBytes) return b;

  // 3) 移除 features 条目
  const feats = [...b.features];
  while (feats.length > 0 && approxUtf8Bytes(JSON.stringify({ ...b, features: feats })) > PIPELINE_PAYLOAD_LIMITS.maxApproxJsonBytes) {
    feats.pop();
  }
  return { ...b, features: feats };
}

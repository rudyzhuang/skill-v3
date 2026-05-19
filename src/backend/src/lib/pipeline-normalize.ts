export interface NormalizedStageRow {
  id: string;
  name: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface NormalizedFeatureRow {
  feature_id: string;
  name: string;
  phase: string | null;
  status: string;
  current_stage: string | null;
  dependencies: string[];
}

export interface NormalizedBlockingIssue {
  message: string;
  stage: string | null;
  severity: string | null;
}

export interface NormalizedPipelinePayload {
  current_stage: string | null;
  last_completed_stage: string | null;
  stages: NormalizedStageRow[];
  features: NormalizedFeatureRow[];
  blocking_issues: NormalizedBlockingIssue[];
  log_tail: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStageRow(id: string, raw: unknown): NormalizedStageRow | null {
  const rec = asRecord(raw);
  if (!rec) {
    return { id, name: id, status: 'unknown', started_at: null, completed_at: null };
  }
  const status = asString(rec.status) ?? 'unknown';
  return {
    id,
    name: asString(rec.name) ?? id,
    status,
    started_at: asString(rec.started_at),
    completed_at: asString(rec.completed_at),
  };
}

function normalizeStagesFromMap(stagesMap: Record<string, unknown>): NormalizedStageRow[] {
  return Object.entries(stagesMap)
    .map(([id, raw]) => normalizeStageRow(id, raw))
    .filter((row): row is NormalizedStageRow => row !== null);
}

function normalizeStagesFromArray(arr: unknown[]): NormalizedStageRow[] {
  const rows: NormalizedStageRow[] = [];
  for (const item of arr) {
    const rec = asRecord(item);
    if (!rec) {
      continue;
    }
    const id = asString(rec.id) ?? asString(rec.stage_id) ?? asString(rec.name);
    if (!id) {
      continue;
    }
    rows.push(
      normalizeStageRow(id, rec) ?? {
        id,
        name: id,
        status: 'unknown',
        started_at: null,
        completed_at: null,
      },
    );
  }
  return rows;
}

function normalizeFeaturesFromMap(
  featuresMap: Record<string, unknown>,
  nameLookup: Map<string, string>,
): NormalizedFeatureRow[] {
  return Object.entries(featuresMap).map(([featureId, raw]) => {
    const rec = asRecord(raw) ?? {};
    const deps = Array.isArray(rec.dependencies)
      ? rec.dependencies.filter((d): d is string => typeof d === 'string')
      : [];
    return {
      feature_id: featureId,
      name: nameLookup.get(featureId) ?? featureId,
      phase: asString(rec.phase),
      status: asString(rec.status) ?? 'unknown',
      current_stage: asString(rec.current_stage),
      dependencies: deps,
    };
  });
}

function normalizeFeaturesFromArray(arr: unknown[]): NormalizedFeatureRow[] {
  const rows: NormalizedFeatureRow[] = [];
  for (const item of arr) {
    const rec = asRecord(item);
    if (!rec) {
      continue;
    }
    const featureId = asString(rec.feature_id) ?? asString(rec.id);
    if (!featureId) {
      continue;
    }
    const deps = Array.isArray(rec.dependencies)
      ? rec.dependencies.filter((d): d is string => typeof d === 'string')
      : [];
    rows.push({
      feature_id: featureId,
      name: asString(rec.name) ?? featureId,
      phase: asString(rec.phase),
      status: asString(rec.status) ?? 'unknown',
      current_stage: asString(rec.current_stage),
      dependencies: deps,
    });
  }
  return rows;
}

function buildFeatureNameLookup(root: Record<string, unknown>): Map<string, string> {
  const lookup = new Map<string, string>();
  const stages = asRecord(root.stages);
  if (!stages) {
    return lookup;
  }
  for (const stageVal of Object.values(stages)) {
    const stageRec = asRecord(stageVal);
    const outputs = asRecord(stageRec?.outputs);
    const features = outputs?.features;
    if (!Array.isArray(features)) {
      continue;
    }
    for (const f of features) {
      const fRec = asRecord(f);
      const fid = asString(fRec?.feature_id);
      const name = asString(fRec?.name);
      if (fid && name) {
        lookup.set(fid, name);
      }
    }
  }
  return lookup;
}

function normalizeBlockingIssue(raw: unknown, defaultStage: string | null): NormalizedBlockingIssue | null {
  if (typeof raw === 'string' && raw.trim()) {
    return { message: raw.trim(), stage: defaultStage, severity: null };
  }
  const rec = asRecord(raw);
  if (!rec) {
    return null;
  }
  const message = asString(rec.message) ?? asString(rec.summary);
  if (!message) {
    return null;
  }
  return {
    message,
    stage: asString(rec.stage) ?? defaultStage,
    severity: asString(rec.severity),
  };
}

function collectStageBlocking(stagesMap: Record<string, unknown>): NormalizedBlockingIssue[] {
  const issues: NormalizedBlockingIssue[] = [];
  const seen = new Set<string>();

  for (const [stageId, stageVal] of Object.entries(stagesMap)) {
    const stageRec = asRecord(stageVal);
    const list = stageRec?.blocking_issues;
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      const normalized = normalizeBlockingIssue(item, stageId);
      if (!normalized) {
        continue;
      }
      const key = `${normalized.stage ?? ''}:${normalized.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      issues.push(normalized);
    }
  }
  return issues;
}

/**
 * Normalize pipeline upsert or stages.json-shaped payloads for persistence and dashboard read.
 * Tolerates missing stages/features/blocking fields without throwing.
 */
export function normalizePipelinePayload(raw: unknown): NormalizedPipelinePayload {
  const empty: NormalizedPipelinePayload = {
    current_stage: null,
    last_completed_stage: null,
    stages: [],
    features: [],
    blocking_issues: [],
    log_tail: '',
  };

  const root = asRecord(raw);
  if (!root) {
    return empty;
  }

  const pipelineMeta = asRecord(root.pipeline);
  const nameLookup = buildFeatureNameLookup(root);

  const currentStage =
    asString(root.current_stage) ?? asString(pipelineMeta?.current_stage) ?? null;
  const lastCompleted =
    asString(root.last_completed_stage) ??
    asString(pipelineMeta?.last_completed_stage) ??
    null;

  let stages: NormalizedStageRow[] = [];
  const stagesRaw = root.stages;
  if (Array.isArray(stagesRaw)) {
    stages = normalizeStagesFromArray(stagesRaw);
  } else {
    const stagesMap = asRecord(stagesRaw);
    if (stagesMap) {
      stages = normalizeStagesFromMap(stagesMap);
    }
  }

  let features: NormalizedFeatureRow[] = [];
  const featuresRaw = root.features;
  if (Array.isArray(featuresRaw)) {
    features = normalizeFeaturesFromArray(featuresRaw);
  } else {
    const featuresMap = asRecord(featuresRaw);
    if (featuresMap) {
      features = normalizeFeaturesFromMap(featuresMap, nameLookup);
    }
  }

  const blocking: NormalizedBlockingIssue[] = [];
  const seen = new Set<string>();

  const pushIssue = (issue: NormalizedBlockingIssue | null) => {
    if (!issue) {
      return;
    }
    const key = `${issue.stage ?? ''}:${issue.message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    blocking.push(issue);
  };

  if (Array.isArray(root.blocking_issues)) {
    for (const item of root.blocking_issues) {
      pushIssue(normalizeBlockingIssue(item, currentStage));
    }
  }

  const stagesMap = asRecord(stagesRaw);
  if (stagesMap) {
    for (const issue of collectStageBlocking(stagesMap)) {
      pushIssue(issue);
    }
  }

  const logTail = typeof root.log_tail === 'string' ? root.log_tail : '';

  return {
    current_stage: currentStage,
    last_completed_stage: lastCompleted,
    stages,
    features,
    blocking_issues: blocking,
    log_tail: logTail,
  };
}

/** One-line summary for projects.pipeline_summary list column. */
export function buildPipelineSummary(normalized: NormalizedPipelinePayload): string {
  const stage = normalized.current_stage ?? '—';
  const blocking = normalized.blocking_issues.length;
  return `stage: ${stage}; blocking: ${blocking}`;
}

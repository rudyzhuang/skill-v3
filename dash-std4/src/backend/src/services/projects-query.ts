import { normalizeClientTargets } from '../lib/client-targets';
import {
  PROJECT_STATUSES,
  type ProjectDetail,
  type ProjectListResponse,
  type ProjectStatus,
  type ProjectSummary,
} from '../types/project';

export interface ListProjectsParams {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
}

interface ProjectRow {
  id: string;
  name_zh: string;
  name_en: string;
  description: string | null;
  client_targets: string;
  status: string;
  is_new: number;
  root_path: string | null;
  pipeline_summary: string | null;
  created_at: string;
  updated_at: string;
}

function toStatus(raw: string): ProjectStatus {
  if ((PROJECT_STATUSES as readonly string[]).includes(raw)) {
    return raw as ProjectStatus;
  }
  return 'unknown';
}

function rowToSummary(row: ProjectRow): ProjectSummary {
  const { targets } = normalizeClientTargets(row.client_targets);
  return {
    id: row.id,
    name_zh: row.name_zh,
    name_en: row.name_en,
    status: toStatus(row.status),
    client_targets: targets,
    updated_at: row.updated_at,
  };
}

function rowToDetail(row: ProjectRow): ProjectDetail {
  const { targets, hadInvalid } = normalizeClientTargets(row.client_targets);
  const detail: ProjectDetail = {
    id: row.id,
    name_zh: row.name_zh,
    name_en: row.name_en,
    description: row.description,
    client_targets: targets,
    status: toStatus(row.status),
    is_new: row.is_new !== 0,
    updated_at: row.updated_at,
    created_at: row.created_at,
    root_path: row.root_path,
    pipeline_status: row.pipeline_summary,
  };

  if (hadInvalid) {
    detail.client_targets_note =
      'stored client_targets contained values outside admin|backend; invalid entries were omitted';
  }

  return detail;
}

function buildListWhere(
  status: string | undefined,
  q: string | undefined,
): { clause: string; binds: (string | number)[] } {
  const clauses: string[] = [];
  const binds: (string | number)[] = [];

  if (status?.trim()) {
    clauses.push('status = ?');
    binds.push(status.trim());
  }

  const term = q?.trim();
  if (term) {
    const pattern = `%${term}%`;
    clauses.push('(name_zh LIKE ? OR name_en LIKE ?)');
    binds.push(pattern, pattern);
  }

  const clause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return { clause, binds };
}

export async function listProjects(
  db: D1Database,
  params: ListProjectsParams,
): Promise<ProjectListResponse> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(100, Math.max(1, params.pageSize));
  const offset = (page - 1) * pageSize;

  const { clause, binds } = buildListWhere(params.status, params.q);

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM projects ${clause}`)
    .bind(...binds)
    .first<{ total: number }>();

  const total = countRow?.total ?? 0;

  const listResult = await db
    .prepare(
      `SELECT id, name_zh, name_en, description, client_targets, status, is_new,
              root_path, pipeline_summary, created_at, updated_at
       FROM projects
       ${clause}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, pageSize, offset)
    .all<ProjectRow>();

  const items = (listResult.results ?? []).map(rowToSummary);

  return {
    items,
    total,
    page,
    page_size: pageSize,
  };
}

export async function getProjectById(
  db: D1Database,
  id: string,
): Promise<ProjectDetail | null> {
  const row = await db
    .prepare(
      `SELECT id, name_zh, name_en, description, client_targets, status, is_new,
              root_path, pipeline_summary, created_at, updated_at
       FROM projects
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(id)
    .first<ProjectRow>();

  if (!row) {
    return null;
  }

  return rowToDetail(row);
}

export function parseListQuery(searchParams: URLSearchParams): ListProjectsParams {
  const pageRaw = Number.parseInt(searchParams.get('page') ?? '1', 10);
  const pageSizeRaw = Number.parseInt(searchParams.get('page_size') ?? '20', 10);

  return {
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    pageSize: Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : 20,
    status: searchParams.get('status') ?? undefined,
    q: searchParams.get('q') ?? undefined,
  };
}

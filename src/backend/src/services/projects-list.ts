import type { D1Database } from '@cloudflare/workers-types';
import { normalizeClientTargets } from '../lib/client-targets';
import {
  PROJECT_STATUSES,
  type ProjectListItemsResponse,
  type ProjectStatus,
  type ProjectSummary,
} from '../types/project-summary';

export interface ListProjectsQuery {
  status?: ProjectStatus;
  q?: string;
  sort: 'updated_at_desc';
}

interface ProjectRow {
  id: string;
  name_zh: string;
  name_en: string;
  client_targets: string;
  status: string;
  pipeline_summary: string | null;
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
    pipeline_summary: row.pipeline_summary,
    updated_at: row.updated_at,
  };
}

function buildWhere(
  status: ProjectStatus | undefined,
  q: string | undefined,
): { clause: string; binds: string[] } {
  const clauses: string[] = [];
  const binds: string[] = [];

  if (status) {
    clauses.push('status = ?');
    binds.push(status);
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

function orderByClause(sort: ListProjectsQuery['sort']): string {
  if (sort === 'updated_at_desc') {
    return 'ORDER BY updated_at DESC';
  }
  return 'ORDER BY updated_at DESC';
}

export async function listProjectsForAdmin(
  db: D1Database,
  query: ListProjectsQuery,
): Promise<ProjectListItemsResponse> {
  const { clause, binds } = buildWhere(query.status, query.q);

  const listResult = await db
    .prepare(
      `SELECT id, name_zh, name_en, client_targets, status, pipeline_summary, updated_at
       FROM projects
       ${clause}
       ${orderByClause(query.sort)}`,
    )
    .bind(...binds)
    .all<ProjectRow>();

  const items = (listResult.results ?? []).map(rowToSummary);
  return { items };
}

export function parseAdminListQuery(
  searchParams: URLSearchParams,
): { query: ListProjectsQuery } | { error: string } {
  const statusRaw = searchParams.get('status');
  let status: ProjectStatus | undefined;
  if (statusRaw !== null && statusRaw !== '') {
    if (!(PROJECT_STATUSES as readonly string[]).includes(statusRaw)) {
      return {
        error: `status 须为 ${PROJECT_STATUSES.join('|')} 之一`,
      };
    }
    status = statusRaw as ProjectStatus;
  }

  const q = searchParams.get('q') ?? undefined;
  const sortRaw = searchParams.get('sort');
  if (sortRaw !== null && sortRaw !== '' && sortRaw !== 'updated_at_desc') {
    return { error: 'sort 目前仅支持 updated_at_desc' };
  }

  return {
    query: {
      status,
      q: q || undefined,
      sort: 'updated_at_desc',
    },
  };
}

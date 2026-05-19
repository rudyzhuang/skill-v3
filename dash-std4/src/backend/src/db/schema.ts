import type { D1Database } from '@cloudflare/workers-types';

export const USER_ROLES = ['super_admin', 'admin', 'operator'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ADMIN_ROLES: UserRole[] = ['admin', 'super_admin'];

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  is_bootstrap: number;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface UserSummary {
  id: string;
  email: string;
  role: UserRole;
}

export interface UserListItem {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  is_bootstrap: boolean;
  created_at: string;
}

export function toUserSummary(row: UserRow): UserSummary {
  return { id: row.id, email: row.email, role: row.role };
}

export function toUserListItem(row: UserRow): UserListItem {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    is_bootstrap: row.is_bootstrap === 1,
    created_at: row.created_at,
  };
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT id, email, password_hash, role, status, is_bootstrap, created_at
       FROM users WHERE email = ? COLLATE NOCASE`,
    )
    .bind(email.trim().toLowerCase())
    .first<UserRow>();
}

export async function findUserById(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT id, email, password_hash, role, status, is_bootstrap, created_at
       FROM users WHERE id = ?`,
    )
    .bind(id)
    .first<UserRow>();
}

export async function insertUser(
  db: D1Database,
  user: UserRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, status, is_bootstrap, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      user.id,
      user.email,
      user.password_hash,
      user.role,
      user.status,
      user.is_bootstrap,
      user.created_at,
    )
    .run();
}

export async function listUsers(
  db: D1Database,
  options: { limit?: number; offset?: number } = {},
): Promise<{ items: UserListItem[]; total: number }> {
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM users`)
    .first<{ total: number }>();
  const total = countRow?.total ?? 0;

  let query = `SELECT id, email, password_hash, role, status, is_bootstrap, created_at
               FROM users ORDER BY created_at DESC`;
  const bindings: unknown[] = [];

  if (options.limit !== undefined) {
    query += ` LIMIT ?`;
    bindings.push(options.limit);
    if (options.offset !== undefined) {
      query += ` OFFSET ?`;
      bindings.push(options.offset);
    }
  }

  const stmt = db.prepare(query);
  const bound = bindings.length > 0 ? stmt.bind(...bindings) : stmt;
  const { results } = await bound.all<UserRow>();

  return {
    items: (results ?? []).map(toUserListItem),
    total,
  };
}

export async function updateUserFields(
  db: D1Database,
  id: string,
  fields: { role?: UserRole; status?: UserStatus },
): Promise<UserRow | null> {
  const sets: string[] = [];
  const bindings: unknown[] = [];

  if (fields.role !== undefined) {
    sets.push('role = ?');
    bindings.push(fields.role);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    bindings.push(fields.status);
  }

  if (sets.length === 0) {
    return findUserById(db, id);
  }

  bindings.push(id);
  await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...bindings)
    .run();

  return findUserById(db, id);
}

export async function findSessionById(
  db: D1Database,
  sessionId: string,
): Promise<SessionRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = ?`,
    )
    .bind(sessionId)
    .first<SessionRow>();
}

export async function insertSession(
  db: D1Database,
  session: SessionRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(session.id, session.user_id, session.expires_at, session.created_at)
    .run();
}

export async function deleteSession(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}

export type ProjectStatus = 'active' | 'blocked' | 'completed' | 'unknown';

export interface ProjectRow {
  id: string;
  name_zh: string;
  name_en: string;
  description: string | null;
  client_targets: string;
  status: ProjectStatus;
  is_new: number;
  source: string | null;
  root_path: string | null;
  pipeline_summary: string | null;
  created_at: string;
  updated_at: string;
}

export async function findProjectById(
  db: D1Database,
  id: string,
): Promise<ProjectRow | null> {
  return db
    .prepare(
      `SELECT id, name_zh, name_en, description, client_targets, status, is_new,
              source, root_path, pipeline_summary, created_at, updated_at
       FROM projects WHERE id = ?`,
    )
    .bind(id)
    .first<ProjectRow>();
}

export async function insertProject(
  db: D1Database,
  project: ProjectRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO projects (
        id, name_zh, name_en, description, client_targets, status, is_new,
        source, root_path, pipeline_summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      project.id,
      project.name_zh,
      project.name_en,
      project.description,
      project.client_targets,
      project.status,
      project.is_new,
      project.source,
      project.root_path,
      project.pipeline_summary,
      project.created_at,
      project.updated_at,
    )
    .run();
}

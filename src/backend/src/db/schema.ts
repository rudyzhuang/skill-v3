import type { D1Database } from '@cloudflare/workers-types';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
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

export function toUserSummary(row: UserRow): UserSummary {
  return { id: row.id, email: row.email, role: row.role };
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT id, email, password_hash, role, status, created_at
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
      `SELECT id, email, password_hash, role, status, created_at
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
      `INSERT INTO users (id, email, password_hash, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      user.id,
      user.email,
      user.password_hash,
      user.role,
      user.status,
      user.created_at,
    )
    .run();
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
  description: string;
  client_targets: string;
  status: ProjectStatus;
  is_new: number;
  source: string | null;
  root_path: string | null;
  pipeline_summary: string | null;
  created_at: string;
  updated_at: string;
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

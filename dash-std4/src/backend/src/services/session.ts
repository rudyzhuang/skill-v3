import type { D1Database } from '@cloudflare/workers-types';
import {
  deleteSession,
  findSessionById,
  insertSession,
  type SessionRow,
  type UserRow,
} from '../db/schema';

export const SESSION_COOKIE = 'dash_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CookieOptions {
  domain?: string;
  secure: boolean;
  sameSite: 'None' | 'Lax' | 'Strict';
}

export function getSessionIdFromCookie(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return value || null;
    }
  }
  return null;
}

export function buildSessionCookie(
  sessionId: string,
  expiresAt: Date,
  opts: CookieOptions,
): string {
  const segments = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}`,
    `Expires=${expiresAt.toUTCString()}`,
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.secure) {
    segments.push('Secure');
  }
  if (opts.domain) {
    segments.push(`Domain=${opts.domain}`);
  }
  return segments.join('; ');
}

export function buildClearSessionCookie(opts: CookieOptions): string {
  const segments = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    `Expires=${new Date(0).toUTCString()}`,
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.secure) {
    segments.push('Secure');
  }
  if (opts.domain) {
    segments.push(`Domain=${opts.domain}`);
  }
  return segments.join('; ');
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const row: SessionRow = {
    id: sessionId,
    user_id: userId,
    expires_at: expiresAt.toISOString(),
    created_at: new Date().toISOString(),
  };
  await insertSession(db, row);
  return { sessionId, expiresAt };
}

export async function resolveSessionUser(
  db: D1Database,
  sessionId: string | null,
): Promise<UserRow | null> {
  if (!sessionId) {
    return null;
  }
  const session = await findSessionById(db, sessionId);
  if (!session) {
    return null;
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await deleteSession(db, sessionId);
    return null;
  }
  const { findUserById } = await import('../db/schema');
  const user = await findUserById(db, session.user_id);
  if (!user || user.status !== 'active') {
    return null;
  }
  return user;
}

export async function destroySession(
  db: D1Database,
  sessionId: string | null,
): Promise<void> {
  if (!sessionId) {
    return;
  }
  await deleteSession(db, sessionId);
}

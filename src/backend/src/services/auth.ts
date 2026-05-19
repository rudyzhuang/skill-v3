import type { D1Database } from '@cloudflare/workers-types';
import {
  findUserByEmail,
  toUserSummary,
  type UserSummary,
} from '../db/schema';
import { verifyPassword } from './password';
import {
  createSession,
  destroySession,
  getSessionIdFromCookie,
  resolveSessionUser,
  type CookieOptions,
} from './session';

export const LOGIN_ERROR_MESSAGE = '邮箱或密码不正确';

export interface AppEnv {
  DB: D1Database;
  COOKIE_DOMAIN?: string;
  COOKIE_SECURE?: string;
}

export function cookieOptionsFromEnv(env: AppEnv): CookieOptions {
  return {
    domain: env.COOKIE_DOMAIN || undefined,
    secure: env.COOKIE_SECURE !== 'false',
    sameSite: 'None',
  };
}

export async function loginWithCredentials(
  env: AppEnv,
  email: string,
  password: string,
): Promise<
  | { ok: true; user: UserSummary; sessionId: string; expiresAt: Date }
  | { ok: false }
> {
  const user = await findUserByEmail(env.DB, email);
  if (!user || user.status !== 'active') {
    return { ok: false };
  }
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return { ok: false };
  }
  const { sessionId, expiresAt } = await createSession(env.DB, user.id);
  return { ok: true, user: toUserSummary(user), sessionId, expiresAt };
}

export async function getCurrentUser(
  env: AppEnv,
  cookieHeader: string | null | undefined,
): Promise<UserSummary | null> {
  const sessionId = getSessionIdFromCookie(cookieHeader);
  const user = await resolveSessionUser(env.DB, sessionId);
  return user ? toUserSummary(user) : null;
}

export async function logout(
  env: AppEnv,
  cookieHeader: string | null | undefined,
): Promise<void> {
  const sessionId = getSessionIdFromCookie(cookieHeader);
  await destroySession(env.DB, sessionId);
}

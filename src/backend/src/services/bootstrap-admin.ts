import type { D1Database } from '@cloudflare/workers-types';
import { findUserByEmail, insertUser } from '../db/schema';
import { hashPassword } from './password';

export interface BootstrapEnv {
  DB: D1Database;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
}

let bootstrapped = false;

/** Idempotent: create default admin only when email does not exist; never overwrite password. */
export async function bootstrapAdmin(env: BootstrapEnv): Promise<void> {
  if (bootstrapped) {
    return;
  }
  bootstrapped = true;

  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) {
    return;
  }

  const existing = await findUserByEmail(env.DB, email);
  if (existing) {
    return;
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  await insertUser(env.DB, {
    id: crypto.randomUUID(),
    email,
    password_hash: passwordHash,
    role: 'admin',
    status: 'active',
    created_at: now,
  });
}

/** Reset bootstrap flag for tests. */
export function resetBootstrapForTests(): void {
  bootstrapped = false;
}

import type { D1Database } from '@cloudflare/workers-types';
import {
  findUserByEmail,
  findUserById,
  insertUser,
  listUsers,
  toUserListItem,
  updateUserFields,
  type UserListItem,
  type UserRole,
  type UserStatus,
} from '../db/schema';
import { hashPassword } from './password';

export interface UserPublicItem {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  is_bootstrap: boolean;
}

function toPublicItem(item: UserListItem): UserPublicItem {
  return {
    id: item.id,
    email: item.email,
    role: item.role,
    status: item.status,
    created_at: item.created_at,
    is_bootstrap: item.is_bootstrap,
  };
}

export async function listUsersPublic(
  db: D1Database,
  options: { page?: number; pageSize?: number },
): Promise<{ items: UserPublicItem[]; total: number }> {
  const page = options.page ?? 1;
  const pageSize = options.pageSize;
  const listOpts =
    pageSize !== undefined
      ? { limit: pageSize, offset: (page - 1) * pageSize }
      : {};
  const { items, total } = await listUsers(db, listOpts);
  return { items: items.map(toPublicItem), total };
}

export async function createUser(
  db: D1Database,
  input: { email: string; password: string; role: UserRole },
): Promise<
  | { ok: true; user: UserPublicItem }
  | { ok: false; code: 'conflict' | 'invalid' }
> {
  const existing = await findUserByEmail(db, input.email);
  if (existing) {
    return { ok: false, code: 'conflict' };
  }

  const passwordHash = await hashPassword(input.password);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await insertUser(db, {
    id,
    email: input.email,
    password_hash: passwordHash,
    role: input.role,
    status: 'active',
    is_bootstrap: 0,
    created_at: now,
  });

  const row = await findUserById(db, id);
  if (!row) {
    return { ok: false, code: 'invalid' };
  }
  return { ok: true, user: toPublicItem(toUserListItem(row)) };
}

export async function updateUser(
  db: D1Database,
  id: string,
  fields: { role?: UserRole; status?: UserStatus },
): Promise<
  | { ok: true; user: UserPublicItem }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid' }
> {
  const existing = await findUserById(db, id);
  if (!existing) {
    return { ok: false, code: 'not_found' };
  }

  if (existing.is_bootstrap === 1) {
    if (fields.status === 'disabled') {
      return { ok: false, code: 'forbidden' };
    }
    if (fields.role === 'operator') {
      return { ok: false, code: 'forbidden' };
    }
  }

  const updated = await updateUserFields(db, id, fields);
  if (!updated) {
    return { ok: false, code: 'not_found' };
  }
  return { ok: true, user: toPublicItem(toUserListItem(updated)) };
}

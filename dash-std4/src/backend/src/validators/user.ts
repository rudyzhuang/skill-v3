import { USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from '../db/schema';

export interface CreateUserInput {
  email: string;
  password: string;
  role: UserRole;
}

export interface UpdateUserInput {
  role?: UserRole;
  status?: UserStatus;
}

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseCreateUserBody(
  body: unknown,
): ValidationResult<CreateUserInput> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: '请求体无效' };
  }
  const record = body as Record<string, unknown>;
  const email = record.email;
  const password = record.password;
  const role = record.role ?? 'operator';

  if (!isNonEmptyString(email)) {
    return { ok: false, error: '邮箱不能为空' };
  }
  if (!isNonEmptyString(password)) {
    return { ok: false, error: '密码不能为空' };
  }
  if (!USER_ROLES.includes(role as UserRole)) {
    return { ok: false, error: '角色无效' };
  }
  if (role === 'super_admin') {
    return { ok: false, error: '无法创建超级管理员' };
  }

  return {
    ok: true,
    data: {
      email: email.trim().toLowerCase(),
      password,
      role: role as UserRole,
    },
  };
}

export function parseUpdateUserBody(
  body: unknown,
): ValidationResult<UpdateUserInput> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: '请求体无效' };
  }
  const record = body as Record<string, unknown>;
  const data: UpdateUserInput = {};

  if ('role' in record) {
    if (!USER_ROLES.includes(record.role as UserRole)) {
      return { ok: false, error: '角色无效' };
    }
    if (record.role === 'super_admin') {
      return { ok: false, error: '无法授予超级管理员' };
    }
    data.role = record.role as UserRole;
  }

  if ('status' in record) {
    if (!USER_STATUSES.includes(record.status as UserStatus)) {
      return { ok: false, error: '状态无效' };
    }
    data.status = record.status as UserStatus;
  }

  if (data.role === undefined && data.status === undefined) {
    return { ok: false, error: '无有效更新字段' };
  }

  return { ok: true, data };
}

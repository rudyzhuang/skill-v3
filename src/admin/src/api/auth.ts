import { apiFetch, ApiError } from './client';

export interface UserSummary {
  id: string;
  email: string;
  role: string;
}

export interface MeResponse {
  user: UserSummary;
}

export interface LoginResponse {
  user: UserSummary;
}

export async function login(
  email: string,
  password: string,
): Promise<UserSummary> {
  const data = await apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return data.user;
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export async function fetchMe(): Promise<UserSummary | null> {
  try {
    const data = await apiFetch<MeResponse>('/api/auth/me');
    return data.user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return null;
    }
    throw err;
  }
}

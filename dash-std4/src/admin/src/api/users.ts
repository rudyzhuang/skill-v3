import { apiFetch } from './client';

export interface UserListItem {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  is_bootstrap?: boolean;
}

export interface UsersListResponse {
  items: UserListItem[];
  total: number;
}

export interface CreateUserInput {
  email: string;
  password: string;
  role: string;
}

export interface UserResponse {
  user: UserListItem;
}

export async function listUsers(): Promise<UsersListResponse> {
  return apiFetch<UsersListResponse>('/api/users');
}

export async function createUser(input: CreateUserInput): Promise<UserListItem> {
  const data = await apiFetch<UserResponse>('/api/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.user;
}

export async function updateUser(
  id: string,
  fields: { role?: string; status?: string },
): Promise<UserListItem> {
  const data = await apiFetch<UserResponse>(`/api/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  return data.user;
}

import { useCallback, useEffect, useState } from 'react';
import { CreateUserDialog } from '../components/CreateUserDialog';
import { EditUserDialog } from '../components/EditUserDialog';
import { UserTable } from '../components/UserTable';
import { ApiError } from '../api/client';
import { listUsers, type UserListItem } from '../api/users';

export function UsersPage() {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);

  const loadUsers = useCallback(async () => {
    setError(null);
    try {
      const data = await listUsers();
      setUsers(data.items);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || '加载用户列表失败');
      } else {
        setError('加载用户列表失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const bootstrapEmails = new Set(
    users.filter((u) => u.is_bootstrap).map((u) => u.email),
  );

  return (
    <main className="users-page">
      <div className="users-page__header">
        <h1>用户管理</h1>
        <button type="button" onClick={() => setCreateOpen(true)}>
          创建用户
        </button>
      </div>
      {loading && <p className="loading">加载中…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && (
        <UserTable
          users={users}
          bootstrapEmails={bootstrapEmails}
          onEdit={setEditingUser}
        />
      )}
      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void loadUsers()}
      />
      <EditUserDialog
        user={editingUser}
        onClose={() => setEditingUser(null)}
        onUpdated={() => void loadUsers()}
      />
    </main>
  );
}

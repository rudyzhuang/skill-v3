import { FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import { updateUser, type UserListItem } from '../api/users';

interface EditUserDialogProps {
  user: UserListItem | null;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditUserDialog({ user, onClose, onUpdated }: EditUserDialogProps) {
  const [status, setStatus] = useState(user?.status ?? 'active');
  const [role, setRole] = useState(user?.role ?? 'operator');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!user) {
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await updateUser(user!.id, { status, role });
      onUpdated();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || '更新失败');
      } else {
        setError('更新失败，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-overlay" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-labelledby="edit-user-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="edit-user-title">编辑用户</h2>
        <p className="dialog-subtitle">{user.email}</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="edit-status">状态</label>
          <select
            id="edit-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="active">正常</option>
            <option value="disabled">已禁用</option>
          </select>
          <label htmlFor="edit-role">角色</label>
          <select
            id="edit-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="operator">操作员</option>
            <option value="admin">管理员</option>
          </select>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button type="submit" disabled={submitting}>
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import { createUser, type CreateUserInput } from '../api/users';

interface CreateUserDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: CreateUserDialogProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('operator');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) {
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const input: CreateUserInput = {
        email: email.trim(),
        password,
        role,
      };
      await createUser(input);
      setEmail('');
      setPassword('');
      setRole('operator');
      onCreated();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('邮箱重复，请使用其他邮箱');
      } else if (err instanceof ApiError) {
        setError(err.message || '创建失败');
      } else {
        setError('创建失败，请稍后重试');
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
        aria-labelledby="create-user-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="create-user-title">创建用户</h2>
        <form onSubmit={handleSubmit}>
          <label htmlFor="create-email">邮箱</label>
          <input
            id="create-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label htmlFor="create-password">初始密码</label>
          <input
            id="create-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
          />
          <label htmlFor="create-role">角色</label>
          <select
            id="create-role"
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
              {submitting ? '创建中…' : '确认'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

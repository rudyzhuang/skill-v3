import type { UserListItem } from '../api/users';

const ROLE_LABELS: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  operator: '操作员',
};

const STATUS_LABELS: Record<string, string> = {
  active: '正常',
  disabled: '已禁用',
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso;
  }
}

interface UserTableProps {
  users: UserListItem[];
  bootstrapEmails?: Set<string>;
  onEdit?: (user: UserListItem) => void;
}

export function UserTable({ users, bootstrapEmails, onEdit }: UserTableProps) {
  if (users.length === 0) {
    return <p className="users-empty">暂无用户</p>;
  }

  return (
    <table className="user-table" aria-label="用户列表表格">
      <thead>
        <tr>
          <th>邮箱</th>
          <th>角色</th>
          <th>状态</th>
          <th>创建时间</th>
          {onEdit && <th>操作</th>}
        </tr>
      </thead>
      <tbody>
        {users.map((user) => {
          const isBootstrap = bootstrapEmails?.has(user.email);
          return (
            <tr key={user.id}>
              <td>{user.email}</td>
              <td>{ROLE_LABELS[user.role] ?? user.role}</td>
              <td>{STATUS_LABELS[user.status] ?? user.status}</td>
              <td>{formatDate(user.created_at)}</td>
              {onEdit && (
                <td>
                  {!isBootstrap && (
                    <button type="button" onClick={() => onEdit(user)}>
                      编辑
                    </button>
                  )}
                  {isBootstrap && (
                    <span className="user-table__hint">引导账号</span>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

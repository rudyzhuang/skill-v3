import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

export function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <p className="loading">加载中…</p>;
  }

  if (!user || !ADMIN_ROLES.has(user.role)) {
    return (
      <main className="forbidden-page">
        <h1>无权限</h1>
        <p>您没有访问此页面的权限。</p>
        <Navigate to="/" replace />
      </main>
    );
  }

  return <>{children}</>;
}

import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function canManageProjects(role: string): boolean {
  return role === 'admin' || role === 'super_admin';
}

export function AdminOnlyRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <p className="loading">加载中…</p>;
  }

  if (!user || !canManageProjects(user.role)) {
    return (
      <main className="forbidden-page">
        <h1>无权限</h1>
        <p>您没有权限访问此页面。</p>
        <Link to="/projects">返回项目列表</Link>
      </main>
    );
  }

  return <>{children}</>;
}

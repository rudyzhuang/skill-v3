import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function AppHeader() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="app-header">
      <div className="app-header__brand">Dash 管理端</div>
      {user && (
        <div className="app-header__account" aria-label="顶栏账户区">
          <span className="app-header__email">{user.email}</span>
          <button type="button" onClick={handleLogout}>
            退出登录
          </button>
        </div>
      )}
    </header>
  );
}

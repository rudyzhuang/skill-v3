import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

export function AppHeader() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const showUsersNav = user && ADMIN_ROLES.has(user.role);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="app-header">
      <div className="app-header__brand">Dash 管理端</div>
      <nav className="app-header__nav" aria-label="主导航">
        {showUsersNav && (
          <Link to="/users" className="app-header__nav-link">
            用户管理
          </Link>
        )}
      </nav>
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

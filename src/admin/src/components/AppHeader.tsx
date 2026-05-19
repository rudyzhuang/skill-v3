import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

function isProjectListPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/projects';
}

export function AppHeader() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const listNavActive = isProjectListPath(location.pathname);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="app-header">
      <div className="app-header__left">
        <div className="app-header__brand">Dash 管理端</div>
        <nav className="app-header__nav" aria-label="主导航">
          <Link
            to="/projects"
            className={
              listNavActive
                ? 'app-header__nav-link app-header__nav-link--active'
                : 'app-header__nav-link'
            }
          >
            项目列表
          </Link>
        </nav>
      </div>
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

import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { SearchBox } from './SearchBox';
import { useSession } from '../session';

export function Shell() {
  const { user, unreadTotal, notifUnread, logout } = useSession();
  const navigate = useNavigate();

  return (
    <div className="shell">
      <header className="sidebar">
        <Link className="wordmark" to="/">
          хроника
        </Link>

        <div className="search-slot">
          <SearchBox />
        </div>

        <nav className="nav">
          <NavLink to="/" end>
            Лента
          </NavLink>
          <NavLink to="/messages">
            Сообщения
            {unreadTotal > 0 && (
              <span className="badge">
                {unreadTotal}
                <span className="sr-only"> непрочитанных</span>
              </span>
            )}
          </NavLink>
          <NavLink to="/notifications">
            События
            {notifUnread > 0 && (
              <span className="badge">
                {notifUnread}
                <span className="sr-only"> новых</span>
              </span>
            )}
          </NavLink>
          {user && <NavLink to={`/u/${user.username}`}>Мой профиль</NavLink>}
        </nav>

        <div className="sidebar-foot">
          {user && (
            <p className="sidebar-me">
              <strong>{user.displayName}</strong>@{user.username}
            </p>
          )}
          <button
            className="btn ghost"
            type="button"
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            Выйти
          </button>
        </div>
      </header>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

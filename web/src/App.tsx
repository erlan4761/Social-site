import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Shell } from './components/Shell';
import { DemoBanner } from './demo/DemoBanner';
import { Auth } from './pages/Auth';
import { Feed } from './pages/Feed';
import { Messages } from './pages/Messages';
import { Profile } from './pages/Profile';
import { Thread } from './pages/Thread';
import { SessionProvider, useSession } from './session';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useSession();
  if (!ready) return <div className="center" />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="center">
      <div className="auth">
        <span className="wordmark" style={{ fontSize: '2.5rem' }}>
          не туда
        </span>
        <p className="auth-lede">Такой страницы нет. Бывает.</p>
        <Link className="btn" to="/">
          Вернуться в ленту
        </Link>
      </div>
    </div>
  );
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <DemoBanner />
        <Routes>
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/register" element={<Auth mode="register" />} />

          <Route
            element={
              <RequireAuth>
                <Shell />
              </RequireAuth>
            }
          >
            <Route index element={<Feed />} />
            <Route path="u/:username" element={<Profile />} />
            <Route path="messages" element={<Messages />} />
            <Route path="messages/:username" element={<Thread />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}

import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Shell } from './components/Shell';
import { DemoBanner } from './demo/DemoBanner';
import { Auth } from './pages/Auth';
import { Bookmarks } from './pages/Bookmarks';
import { Settings } from './pages/Settings';
import { ChannelComments } from './pages/ChannelComments';
import { ChannelView } from './pages/ChannelView';
import { ChatThread } from './pages/ChatThread';
import { Feed } from './pages/Feed';
import { Join } from './pages/Join';
import { Moderation } from './pages/Moderation';
import { QrApprove } from './pages/QrApprove';
import { ForgotPassword } from './pages/ForgotPassword';
import { Messenger, MessengerEmpty } from './pages/Messenger';
import { Notifications } from './pages/Notifications';
import { PostPage } from './pages/PostPage';
import { Profile } from './pages/Profile';
import { ResetPassword } from './pages/ResetPassword';
import { Search } from './pages/Search';
import { Thread } from './pages/Thread';
import { SessionProvider, useSession } from './session';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useSession();
  const location = useLocation();
  if (!ready) return <div className="center" />;
  // Куда шли — запоминаем: после входа ссылка-приглашение откроется, а не лента.
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
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
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password/:token" element={<ResetPassword />} />

          <Route
            element={
              <RequireAuth>
                <Shell />
              </RequireAuth>
            }
          >
            <Route index element={<Feed />} />
            {/* Один сегмент, как и `u/:username`, но постоянный: конфликта нет,
                а объявление раньше закрепляет, что «search» — это экран, а не
                чей-то логин. */}
            <Route path="search" element={<Search />} />
            <Route path="bookmarks" element={<Bookmarks />} />
            <Route path="settings" element={<Settings />} />
            <Route path="u/:username" element={<Profile />} />
            <Route path="p/:id" element={<PostPage />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="join/:token" element={<Join />} />
            <Route path="moderation" element={<Moderation />} />
            <Route path="qr/:token" element={<QrApprove />} />
            {/* Мессенджер — список чатов и открытая переписка рядом, как в
                Телеграме. Переписка вложена в него, поэтому список не
                перерисовывается при переходе между чатами. */}
            <Route path="messages" element={<Messenger />}>
              <Route index element={<MessengerEmpty />} />
              {/* Групповой чат объявлен раньше личной переписки: путь у него
                  длиннее (`c/:id` против `:username`), и порядок закрепляет
                  это намерение в коде. Человек с логином «c» ничего не
                  ломает — его диалог живёт на `/messages/c`, это по-прежнему
                  один сегмент, а не два. */}
              <Route path="c/:id" element={<ChatThread />} />
              {/* Канал и ветка комментариев под его публикацией. Путь из двух
                  и трёх сегментов — с личной перепиской (`:username`, один
                  сегмент) не пересекается, даже у человека с логином «ch». */}
              <Route path="ch/:handle" element={<ChannelView />} />
              <Route path="ch/:handle/:postId" element={<ChannelComments />} />
              <Route path=":username" element={<Thread />} />
            </Route>
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}

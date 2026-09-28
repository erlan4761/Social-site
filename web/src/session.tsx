import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, type Badges, type User } from './api';

/** Без WebSocket новые события находятся опросом. Полминуты — компромисс
 *  между «узнал вовремя» и «не долбим сервер вхолостую». */
const UNREAD_POLL_MS = 30_000;

const NO_BADGES: Badges = { messages: 0, chats: 0, channels: 0, notifications: 0 };

type Session = {
  user: User | null;
  ready: boolean;
  /** Что показывает сайдбар у «Сообщений»: личные, групповые чаты и каналы. */
  unreadTotal: number;
  messageUnread: number;
  chatUnread: number;
  notifUnread: number;
  setUser: (user: User | null) => void;
  /** Непрочитанные личные сообщения. Имя оставлено прежним ради существующих
   *  вызовов из `Messages` и `Thread`, которые как раз это число и приносят. */
  setUnreadTotal: (n: number) => void;
  setNotifUnread: (n: number) => void;
  /** Обновить счётчики сразу, не дожидаясь следующего опроса. */
  refreshBadges: () => void;
  logout: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [badges, setBadges] = useState<Badges>(NO_BADGES);

  // Опрос и ручное обновление читают признак входа отсюда, а не из замыкания:
  // иначе refreshBadges пересоздавался бы при каждой смене пользователя и
  // перезапускал эффекты потребителей.
  const signedIn = useRef(false);
  signedIn.current = user !== null;

  useEffect(() => {
    api
      .me()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const refreshBadges = useCallback(() => {
    // Все три счётчика требуют входа: гостю сервер ответит 401, и опрашивать
    // его каждые 30 секунд бессмысленно.
    if (!signedIn.current) return;
    api
      .badges()
      .then(setBadges)
      .catch(() => undefined); // молча: счётчик не повод показывать ошибку
  }, []);

  useEffect(() => {
    if (!user) {
      setBadges(NO_BADGES);
      return;
    }

    refreshBadges();
    const timer = setInterval(refreshBadges, UNREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [user, refreshBadges]);

  const setUnreadTotal = useCallback((n: number) => {
    setBadges((prev) => ({ ...prev, messages: n }));
  }, []);

  const setNotifUnread = useCallback((n: number) => {
    setBadges((prev) => ({ ...prev, notifications: n }));
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      ready,
      unreadTotal: badges.messages + badges.chats + (badges.channels ?? 0),
      messageUnread: badges.messages,
      chatUnread: badges.chats,
      notifUnread: badges.notifications,
      setUser,
      setUnreadTotal,
      setNotifUnread,
      refreshBadges,
      logout,
    }),
    [user, ready, badges, setUnreadTotal, setNotifUnread, refreshBadges, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession должен вызываться внутри SessionProvider');
  return ctx;
}

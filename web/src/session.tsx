import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, type User } from './api';

/** Без WebSocket новые письма находятся опросом. Полминуты — компромисс
 *  между «узнал вовремя» и «не долбим сервер вхолостую». */
const UNREAD_POLL_MS = 30_000;

type Session = {
  user: User | null;
  ready: boolean;
  unreadTotal: number;
  setUser: (user: User | null) => void;
  setUnreadTotal: (n: number) => void;
  logout: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [unreadTotal, setUnreadTotal] = useState(0);

  useEffect(() => {
    api
      .me()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!user) {
      setUnreadTotal(0);
      return;
    }

    let cancelled = false;
    const poll = () => {
      api
        .conversations()
        .then((res) => !cancelled && setUnreadTotal(res.unreadTotal))
        .catch(() => undefined); // молча: счётчик не повод показывать ошибку
    };

    poll();
    const timer = setInterval(poll, UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, unreadTotal, setUser, setUnreadTotal, logout }),
    [user, ready, unreadTotal, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession должен вызываться внутри SessionProvider');
  return ctx;
}

import { useEffect, useState } from 'react';
import { api, type PrefKind } from './api';
import { useLive } from './live';

/**
 * Темы переписки — фон и цвет своих пузырей, как «Темы чатов» в Телеграме.
 * Тема личная: собеседник её не видит, а на другом устройстве того же
 * человека она та же — хранится на сервере в настройках чата (chat_prefs).
 * Сервер знает только имена; как выглядит тема — CSS по атрибуту
 * data-chat-theme (styles/messaging/conversation.css).
 */
export type ChatTheme = 'gold' | 'sea' | 'forest' | 'dusk' | 'rose' | 'plain';

export const THEMES: { key: ChatTheme | null; name: string }[] = [
  { key: null, name: 'Как везде' },
  { key: 'gold', name: 'Золото' },
  { key: 'sea', name: 'Море' },
  { key: 'forest', name: 'Лес' },
  { key: 'dusk', name: 'Сумерки' },
  { key: 'rose', name: 'Роза' },
  { key: 'plain', name: 'Чистый лист' },
];

/**
 * Тема этой переписки и смена её. Нет доступа к настройкам (канал без
 * подписки) — просто «как везде». Сменили на другом устройстве — живой поток
 * толкает «список», и тема перечитывается.
 */
export function useChatTheme(kind: PrefKind, target: string | number | null): [ChatTheme | null, (t: ChatTheme | null) => Promise<void>] {
  const [theme, setTheme] = useState<ChatTheme | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (target == null || target === '') return;
    let cancelled = false;
    api
      .getPref(kind, target)
      .then((res) => !cancelled && setTheme((res.theme as ChatTheme | null) ?? null))
      .catch(() => !cancelled && setTheme(null));
    return () => {
      cancelled = true;
    };
  }, [kind, target, version]);

  useLive((e) => {
    if (e.t === 'list') setVersion((v) => v + 1);
  });

  const change = async (next: ChatTheme | null) => {
    if (target == null) return;
    const before = theme;
    setTheme(next);
    try {
      await api.setPref(kind, target, { theme: next });
    } catch {
      setTheme(before);
    }
  };

  return [theme, change];
}

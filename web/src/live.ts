import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Живой поток от сервера (/api/events, Server-Sent Events). Сервер шлёт не
 * данные, а толчок: «в переписке с 7 что-то изменилось», «в чате 12»,
 * «проверь счётчики». Экран перечитывает нужное обычным запросом — теми же
 * методами api, что и опрос, так что правила доступа остаются на сервере.
 *
 * Одно соединение на вкладку. Пока оно живо, опрос становится редкой
 * страховкой; оборвалось — экраны сами возвращаются к частому опросу, а
 * браузер переподключается и после «ready» экраны дочитывают пропущенное.
 * В витрине сервера нет: толчки шлёт подставной API через dispatchLive.
 */

export type LiveEvent =
  | { t: 'ready' }
  | { t: 'dm'; with: number }
  | { t: 'chat'; id: number }
  | { t: 'channel'; id: number }
  | { t: 'badges' }
  | { t: 'list' };

const listeners = new Set<(event: LiveEvent) => void>();
const connectionListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = false;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  connectionListeners.forEach((l) => l());
}

/** Раздать событие подписчикам — из потока или из витрины. */
export function dispatchLive(event: LiveEvent) {
  listeners.forEach((l) => l(event));
}

export function startLive() {
  if (source || import.meta.env.VITE_DEMO === '1' || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  source.onmessage = (message) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (event.t === 'ready') setConnected(true);
    dispatchLive(event);
  };
  // Обрыв: браузер переподключится сам, а до тех пор экраны опрашивают часто.
  // Отказ (сеанс закрыт, 401) — EventSource сдаётся, и это тоже «нет потока».
  source.onerror = () => setConnected(false);
}

export function stopLive() {
  source?.close();
  source = null;
  setConnected(false);
}

const subscribeConnection = (l: () => void) => {
  connectionListeners.add(l);
  return () => {
    connectionListeners.delete(l);
  };
};

/** Жив ли поток — чтобы выбрать, как часто опрашивать. */
export const useLiveConnected = () => useSyncExternalStore(subscribeConnection, () => connected, () => false);

/** Подписка экрана на толчки. Обработчик можно менять между отрисовками. */
export function useLive(handler: (event: LiveEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (event: LiveEvent) => ref.current(event);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}

/** Сколько ждать между опросами: без потока — как раньше, с потоком — страховка. */
export const pollEvery = (live: boolean, fast: number, safety = 30_000) => (live ? Math.max(fast, safety) : fast);

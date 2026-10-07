import { useEffect, type RefObject } from 'react';
import { api } from './api';

/**
 * Просмотры записей. «Увидел» — запись не меньше чем наполовину на экране
 * (или заняла полэкрана, если она выше окна) дольше секунды: пролистанное
 * мимо — не просмотр. Отправка пачкой раз в пару секунд, до пятидесяти id;
 * каждая запись — один раз за открытую вкладку, остальное решает сервер
 * (один человек — один просмотр, свои не считаются).
 */
const DWELL_MS = 1000;
const FLUSH_MS = 2000;
const BATCH = 50;

const sent = new Set<number>();
let queue: number[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const ids = queue.splice(0, BATCH);
  if (ids.length === 0) return;
  // Не дошло — пусть засчитается при следующем показе.
  api.recordViews(ids).catch(() => ids.forEach((id) => sent.delete(id)));
  if (queue.length > 0) schedule();
}

function schedule() {
  timer ??= setTimeout(flush, FLUSH_MS);
}

export function markViewed(id: number) {
  if (sent.has(id)) return;
  sent.add(id);
  queue.push(id);
  if (queue.length >= BATCH) flush();
  else schedule();
}

/** Следит за строкой записи; `enabled` — false для гостя и своих записей. */
export function useViewTracker(ref: RefObject<Element | null>, postId: number, enabled: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || sent.has(postId) || typeof IntersectionObserver === 'undefined') return;
    let dwell: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const seen = entry.isIntersecting
          && (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= window.innerHeight / 2);
        if (seen) {
          dwell ??= setTimeout(() => {
            markViewed(postId);
            observer.disconnect();
          }, DWELL_MS);
        } else if (dwell) {
          clearTimeout(dwell);
          dwell = null;
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (dwell) clearTimeout(dwell);
    };
  }, [ref, postId, enabled]);
}

/** Для тестов: забыть отправленное и очередь. */
export function resetViewTracking() {
  sent.clear();
  queue = [];
  if (timer) clearTimeout(timer);
  timer = null;
}

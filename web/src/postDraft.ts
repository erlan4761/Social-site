import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { DRAFT_SAVE_MS } from './components/chat/draft';

/**
 * Черновик записи ленты — на сервере, как черновики переписки (chat/draft.ts):
 * начатое на телефоне продолжается на компьютере. При открытии подставляет
 * сохранённое, если поле ещё пусто; по паузе в наборе сохраняет; при уходе
 * дописывает несохранённое сразу. Опубликовали или отложили — сервер сам
 * убирает черновик, и хук об этом знает (`forget`).
 */
export function usePostDraft(text: string, setText: (s: string) => void, enabled: boolean) {
  const loaded = useRef(false);
  /** Что лежит на сервере — от этого считаем, есть ли что сохранять. */
  const saved = useRef('');
  const latest = useRef(text);
  latest.current = text;
  /** Текст в поле пришёл из черновика — композер скажет об этом. */
  const [restored, setRestored] = useState(false);

  const put = (body: string) => {
    saved.current = body;
    void api.savePostDraft(body).catch(() => undefined);
  };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .postDraft()
      .then((res) => {
        if (cancelled) return;
        saved.current = res.draft?.body ?? '';
        if (saved.current && !latest.current) {
          setText(saved.current);
          setRestored(true);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      cancelled = true;
      // Ушли со страницы — несохранённое сразу, без паузы.
      if (loaded.current && latest.current !== saved.current) put(latest.current);
    };
    // setText стабилен по смыслу; черновик один на человека.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !loaded.current || text === saved.current) return;
    const timer = setTimeout(() => put(text), DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled]);

  // Начали печатать своё — подсказка «из черновика» больше ни к чему.
  useEffect(() => {
    if (restored && text !== saved.current) setRestored(false);
  }, [text, restored]);

  return {
    restored,
    /** Сервер уже убрал черновик (запись вышла или отложена) — не сохранять пустое заново. */
    forget() {
      saved.current = '';
      setRestored(false);
    },
    /** «Очистить» — поле и черновик сразу. */
    discard() {
      setText('');
      setRestored(false);
      put('');
    },
  };
}

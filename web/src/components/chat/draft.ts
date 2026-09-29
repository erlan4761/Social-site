import { useEffect, useRef } from 'react';
import { api, type PrefKind } from '../../api';

/** Чей черновик: вид чата и его адрес — логин, id группы или адрес канала. */
export type DraftTarget = { kind: PrefKind; target: string | number };

/** Пауза в наборе, после которой черновик уходит на сервер. */
export const DRAFT_SAVE_MS = 1_200;

/**
 * Черновик поля ввода — на сервере, как в Телеграме: начатое на телефоне
 * продолжается на компьютере, а в списке чатов видно «Черновик: …».
 *
 * Поле ввода монтируется заново для каждого чата (key), поэтому хук живёт
 * ровно одну переписку: при открытии подставляет сохранённое (если человек
 * ещё ничего не набрал), по паузе в наборе сохраняет, при уходе дописывает
 * несохранённое сразу. `paused` — правка своего сообщения: её текст не
 * черновик.
 */
export function useDraft(draft: DraftTarget | undefined, text: string, setText: (s: string) => void, paused: boolean) {
  const loaded = useRef(false);
  /** Что лежит на сервере — от этого считаем, есть ли что сохранять. */
  const saved = useRef('');
  const latest = useRef({ text, paused });
  latest.current = { text, paused };
  const kind = draft?.kind;
  const target = draft?.target;

  const put = (body: string) => {
    if (kind == null || target == null) return;
    saved.current = body;
    void api.saveDraft(kind, target, body).catch(() => undefined);
  };

  useEffect(() => {
    if (kind == null || target == null) return;
    let cancelled = false;
    api
      .draft(kind, target)
      .then((res) => {
        if (cancelled) return;
        saved.current = res.draft?.body ?? '';
        if (saved.current && !latest.current.text) setText(saved.current);
      })
      .catch(() => undefined)
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      cancelled = true;
      // Уход из чата: несохранённое — сразу, без паузы.
      const now = latest.current;
      if (loaded.current && !now.paused && now.text !== saved.current) put(now.text);
    };
    // setText и put стабильны по смыслу: чат меняется только вместе с key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, target]);

  useEffect(() => {
    if (kind == null || !loaded.current || paused || text === saved.current) return;
    const timer = setTimeout(() => put(text), DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, paused, kind]);

  return {
    /** Сохранить набранное прямо сейчас — перед тем как поле займёт правка. */
    flush() {
      if (loaded.current && latest.current.text !== saved.current) put(latest.current.text);
    },
    /** Текст ушёл сообщением — черновика больше нет, тоже сразу. */
    clear() {
      if (saved.current || latest.current.text) put('');
    },
    /** Черновик, который вернуть в поле после правки. */
    body: () => saved.current,
  };
}

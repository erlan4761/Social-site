import { useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { api, ApiError, type ReactionEntry } from '../../api';
import { fullDate } from '../../time';
import { PresenceAvatar } from './status';

type Props = {
  chatId: number;
  messageId: number;
  /** С какой реакции открыть — правый клик по значку открывает сразу её. */
  emoji?: string | null;
  onClose: () => void;
};

/**
 * Кто поставил реакции на сообщение в группе — как в Телеграме: вкладка «Все»
 * и по вкладке на каждую реакцию, свежие сверху. Окно — нативный `<dialog>`,
 * как «Кто прочитал».
 */
export function ReactionsDialog({ chatId, messageId, emoji = null, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [list, setList] = useState<ReactionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(emoji);

  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.showModal();
    const onNativeClose = () => closeHandler.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .chatReactions(chatId, messageId)
      .then((res) => !cancelled && setList(res.reactions))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Не удалось загрузить'));
    return () => {
      cancelled = true;
    };
  }, [chatId, messageId]);

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current) dialog.current.close();
  }

  // Вкладки — в порядке первой реакции каждого вида, как чипы под сообщением.
  const kinds = list ? [...new Set([...list].reverse().map((r) => r.emoji))] : [];
  const count = (e: string) => list?.filter((r) => r.emoji === e).length ?? 0;
  const shown = list && filter ? list.filter((r) => r.emoji === filter) : list;

  return (
    <dialog className="sheet readers-sheet" ref={dialog} onClick={backdrop} aria-labelledby={titleId}>
      <h2 className="sheet-title" id={titleId}>
        Реакции
      </h2>
      {error && <p className="error">{error}</p>}
      {!list && !error && <p className="empty flush">Загружаю…</p>}
      {list && list.length === 0 && <p className="empty flush">Реакций больше нет.</p>}
      {list && list.length > 0 && (
        <>
          <div className="reactors-tabs" role="group" aria-label="Какие реакции показать">
            <button className="reactors-tab" type="button" aria-pressed={filter === null} onClick={() => setFilter(null)}>
              Все {list.length}
            </button>
            {kinds.map((e) => (
              <button key={e} className="reactors-tab" type="button" aria-pressed={filter === e} onClick={() => setFilter(e)}>
                {e} {count(e)}
              </button>
            ))}
          </div>
          <ul className="readers-list reactors-list">
            {shown!.map((r) => (
              <li key={r.user.id}>
                <PresenceAvatar person={r.user} size="sm" />
                <span className="reactors-name">{r.user.displayName}</span>
                <span className="reactors-emoji" title={fullDate(r.at)}>
                  {r.emoji}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="sheet-foot">
        <button className="btn ghost" type="button" onClick={() => dialog.current?.close()}>
          Закрыть
        </button>
      </div>
    </dialog>
  );
}

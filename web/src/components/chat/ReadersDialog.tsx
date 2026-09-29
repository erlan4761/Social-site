import { useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { api, ApiError, type Person } from '../../api';
import { PresenceAvatar } from './status';

/**
 * «Кто прочитал» своё сообщение в группе — как в Телеграме: прочитавшие и
 * ещё нет. Окно — нативный `<dialog>`, как «Переслать».
 */
export function ReadersDialog({ chatId, messageId, onClose }: { chatId: number; messageId: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [data, setData] = useState<{ read: Person[]; unread: Person[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      .chatReaders(chatId, messageId)
      .then((res) => !cancelled && setData(res))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Не удалось загрузить'));
    return () => {
      cancelled = true;
    };
  }, [chatId, messageId]);

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current) dialog.current.close();
  }

  return (
    <dialog className="sheet readers-sheet" ref={dialog} onClick={backdrop} aria-labelledby={titleId}>
      <h2 className="sheet-title" id={titleId}>
        Кто прочитал
      </h2>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="empty flush">Загружаю…</p>}
      {data && (
        <>
          <PeopleGroup title={`Прочитали — ${data.read.length}`} people={data.read} empty="Пока никто." />
          {data.unread.length > 0 && <PeopleGroup title={`Ещё не прочитали — ${data.unread.length}`} people={data.unread} />}
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

function PeopleGroup({ title, people, empty }: { title: string; people: Person[]; empty?: string }) {
  return (
    <section className="readers-group">
      <h3 className="readers-title">{title}</h3>
      {people.length === 0 ? (
        <p className="empty flush">{empty}</p>
      ) : (
        <ul className="readers-list">
          {people.map((p) => (
            <li key={p.id}>
              <PresenceAvatar person={p} size="sm" />
              <span>{p.displayName}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

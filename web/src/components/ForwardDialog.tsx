import { useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type ForwardRef, type ForwardTarget } from '../api';
import { Monogram } from './Monogram';

type Target = { key: string; name: string; hint: string; username: string; avatarUrl: string | null; to: ForwardTarget; path: string };

type Props = {
  source: ForwardRef;
  /** Начало пересылаемого текста — чтобы было видно, что именно уходит. */
  preview: string;
  onClose: () => void;
};

const fold = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');

/**
 * «Переслать»: выбрать переписку — и сообщение уходит туда, а экран переходит
 * в неё, как в Телеграме. Кому пересылать, берётся из своих же чатов: новому
 * человеку сначала пишут, потом пересылают. Окно — нативный `<dialog>`, как
 * «Новый чат»: фокус и Esc достаются от платформы.
 */
export function ForwardDialog({ source, preview, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const navigate = useNavigate();

  const [targets, setTargets] = useState<Target[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
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
    Promise.allSettled([api.conversations(), api.chats()]).then(([dm, chats]) => {
      if (cancelled) return;
      const list: (Target & { at: string })[] = [];
      if (dm.status === 'fulfilled') {
        for (const c of dm.value.conversations) {
          // Туда, где переписка закрыта блокировкой, переслать всё равно не выйдет.
          if (c.blocked) continue;
          list.push({
            key: `dm-${c.user.id}`,
            name: c.user.displayName,
            hint: `@${c.user.username}`,
            username: c.user.username,
            avatarUrl: c.user.avatarUrl,
            to: { kind: 'dm', username: c.user.username },
            path: `/messages/${c.user.username}`,
            at: c.lastMessage.createdAt,
          });
        }
      }
      if (chats.status === 'fulfilled') {
        for (const c of chats.value.chats) {
          list.push({
            key: `chat-${c.id}`,
            name: c.title,
            hint: `${c.memberCount} в чате`,
            username: c.title,
            avatarUrl: null,
            to: { kind: 'chat', id: c.id },
            path: `/messages/c/${c.id}`,
            at: c.lastMessage?.createdAt ?? c.createdAt,
          });
        }
      }
      list.sort((a, b) => b.at.localeCompare(a.at));
      setTargets(list);
      if (dm.status === 'rejected' && chats.status === 'rejected') setError('Не удалось загрузить чаты');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(t: Target) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.forward(t.to, source);
      dialog.current?.close();
      navigate(t.path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось переслать');
      setBusy(false);
    }
  }

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current) dialog.current.close();
  }

  const q = fold(query.trim());
  const shown = targets && q ? targets.filter((t) => fold(t.name).includes(q) || fold(t.hint).includes(q)) : targets;

  return (
    <dialog className="sheet forward-sheet" ref={dialog} onClick={backdrop} aria-labelledby={titleId}>
      <h2 className="sheet-title" id={titleId}>
        Переслать
      </h2>
      <p className="sheet-subject forward-preview">{preview}</p>

      {error && <p className="error">{error}</p>}

      <label className="list-search forward-search">
        <span className="sr-only">Найти чат</span>
        <input
          type="search"
          value={query}
          placeholder="Кому переслать"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="forward-list">
        {shown === null ? (
          <p className="list-note">Загружаю…</p>
        ) : shown.length === 0 ? (
          <p className="list-note">{q ? 'Ничего не нашлось.' : 'Переписок пока нет.'}</p>
        ) : (
          <ul className="dialogs">
            {shown.map((t) => (
              <li key={t.key}>
                <button className="dialog" type="button" disabled={busy} onClick={() => void pick(t)}>
                  <Monogram username={t.username} displayName={t.name} avatarUrl={t.avatarUrl} />
                  <span className="dialog-body">
                    <span className="dialog-head">
                      <span className="dialog-name">{t.name}</span>
                    </span>
                    <span className="dialog-foot">
                      <span className="dialog-last">{t.hint}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sheet-foot">
        <button className="btn ghost" type="button" onClick={() => dialog.current?.close()}>
          Отмена
        </button>
      </div>
    </dialog>
  );
}

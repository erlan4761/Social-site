import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type Author } from '../api';
import { MemberSearch } from './MemberSearch';
import { Monogram } from './Monogram';
import { useSession } from '../session';
import { plural } from '../time';

const TITLE_LIMIT = 60;
/** Столько человек помещается в чат вместе с создателем — так считает сервер. */
const MAX_MEMBERS = 20;

type Props = { onClose: () => void };

/**
 * Окно «Новый чат»: название и люди. Устроено как окно жалобы — нативный
 * `<dialog>` с `showModal()`, чтобы фокус, Esc и возврат фокуса на кнопку
 * достались от платформы.
 */
export function NewChatDialog({ onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const group = useId();
  const navigate = useNavigate();
  const { user } = useSession();

  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Author[]>([]);
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

  // Себя в списке держать не нужно: создатель добавляется сам и становится
  // владельцем. Отдать своё имя серверу можно, он его молча схлопнет, но в
  // чипах оно выглядело бы как ошибка.
  const exclude = [user?.username ?? '', ...picked.map((p) => p.username)];
  const free = MAX_MEMBERS - 1 - picked.length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;

    const name = title.trim();
    if (!name) {
      setError('У чата должно быть название.');
      return;
    }
    if (picked.length === 0) {
      setError('Добавьте хотя бы одного человека — в чате не может быть одного вас.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await api.createChat({ title: name, members: picked.map((p) => p.username) });
      navigate(`/messages/c/${res.chat.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать чат');
      setBusy(false);
    }
  }

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current) dialog.current.close();
  }

  const left = TITLE_LIMIT - title.length;

  return (
    <dialog className="sheet" ref={dialog} onClick={backdrop} aria-labelledby={`${group}-title`}>
      <h2 className="sheet-title" id={`${group}-title`}>
        Новый чат
      </h2>
      <p className="sheet-subject">
        Общая переписка на несколько человек. Позже можно переименовать и позвать ещё людей.
      </p>

      <form onSubmit={submit}>
        {error && <p className="error">{error}</p>}

        <label className="field" htmlFor={`${group}-name`}>
          <span>Название</span>
          <input
            id={`${group}-name`}
            type="text"
            value={title}
            maxLength={TITLE_LIMIT}
            placeholder="Например: Поход в октябре"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {left <= 20 && (
          <p className="hint">
            <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>
          </p>
        )}

        <MemberSearch
          label="Кого позвать"
          exclude={exclude}
          disabled={free <= 0}
          onPick={(u) => {
            setError(null);
            setPicked((prev) => (prev.some((p) => p.id === u.id) ? prev : [...prev, u]));
          }}
        />

        {picked.length > 0 && (
          <ul className="chips">
            {picked.map((p) => (
              <li key={p.id}>
                <span className="chip">
                  <Monogram
                    username={p.username}
                    displayName={p.displayName}
                    avatarUrl={p.avatarUrl}
                    size="sm"
                  />
                  <span className="chip-name">{p.displayName}</span>
                  <button
                    className="chip-off"
                    type="button"
                    aria-label={`Убрать ${p.displayName} из списка`}
                    onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="hint chips-hint">
          {free > 0
            ? `Вы и ещё ${picked.length}. Можно позвать до ${free} ${plural(free, 'человека', 'человек', 'человек')}.`
            : 'Больше двадцати человек в один чат не помещается.'}
        </p>

        <div className="sheet-foot">
          <button className="btn ghost" type="button" onClick={() => dialog.current?.close()} disabled={busy}>
            Отмена
          </button>
          <button className="btn" type="submit" disabled={busy || !title.trim() || picked.length === 0}>
            {busy ? 'Создаю…' : 'Создать'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

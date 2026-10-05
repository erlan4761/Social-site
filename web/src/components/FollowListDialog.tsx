import { useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type FollowEntry } from '../api';
import { useSession } from '../session';
import { Monogram } from './Monogram';

export type FollowSide = 'followers' | 'following';

type Props = {
  username: string;
  side: FollowSide;
  counts: { followers: number; following: number };
  onClose: () => void;
  /** Подписались или отписались прямо в списке — профилю пересчитать своё. */
  onChanged?: () => void;
};

/**
 * Подписчики и подписки — по нажатию на счётчики в профиле. Две вкладки,
 * свежие сверху, «Показать ещё» по 50. У каждого — кнопка подписки прямо в
 * списке, имя ведёт в профиль. Нативный `<dialog>`, как «Переслать».
 */
export function FollowListDialog({ username, side: initial, counts, onClose, onChanged }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { user } = useSession();
  const [side, setSide] = useState<FollowSide>(initial);
  const [list, setList] = useState<FollowEntry[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
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
    setList(null);
    setError(null);
    (side === 'followers' ? api.followers(username) : api.following(username))
      .then((res) => {
        if (cancelled) return;
        setList(res.users);
        setCursor(res.nextCursor);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Не удалось загрузить'));
    return () => {
      cancelled = true;
    };
  }, [username, side]);

  async function more() {
    if (cursor == null) return;
    setLoadingMore(true);
    try {
      const res = await (side === 'followers' ? api.followers(username, cursor) : api.following(username, cursor));
      setList((prev) => [...(prev ?? []), ...res.users]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить');
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggle(person: FollowEntry) {
    setBusy(person.id);
    setError(null);
    try {
      const res = await api.setFollow(person.username, !person.followedByMe);
      setList((prev) => prev?.map((x) => (x.id === person.id ? { ...x, followedByMe: res.followedByMe } : x)) ?? null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить подписку');
    } finally {
      setBusy(null);
    }
  }

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current) dialog.current.close();
  }

  return (
    <dialog className="sheet follow-sheet" ref={dialog} onClick={backdrop} aria-labelledby={titleId}>
      <h2 className="sheet-title" id={titleId}>
        @{username}
      </h2>
      <div className="follow-tabs" role="tablist" aria-label="Подписчики или подписки">
        {(['followers', 'following'] as const).map((s) => (
          <button
            key={s}
            className={side === s ? 'follow-tab on' : 'follow-tab'}
            type="button"
            role="tab"
            aria-selected={side === s}
            onClick={() => setSide(s)}
          >
            {s === 'followers' ? 'Подписчики' : 'Подписки'} <span>{counts[s]}</span>
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      <div className="follow-list" role="tabpanel">
        {list === null ? (
          !error && <p className="list-note">Загружаю…</p>
        ) : list.length === 0 ? (
          <p className="list-note">{side === 'followers' ? 'Подписчиков пока нет.' : 'Подписок пока нет.'}</p>
        ) : (
          <ul className="follow-people">
            {list.map((p) => (
              <li key={p.id}>
                <Link className="follow-person" to={`/u/${p.username}`} onClick={() => dialog.current?.close()}>
                  <Monogram username={p.username} displayName={p.displayName} avatarUrl={p.avatarUrl} size="sm" />
                  <span className="follow-who">
                    <strong>{p.displayName}</strong>
                    <span>@{p.username}</span>
                    {p.bio && <span className="follow-bio">{p.bio}</span>}
                  </span>
                </Link>
                {user && user.id !== p.id && (
                  <button
                    className={p.followedByMe ? 'btn ghost small' : 'btn small'}
                    type="button"
                    disabled={busy === p.id}
                    aria-label={p.followedByMe ? `Отписаться от ${p.displayName}` : `Подписаться на ${p.displayName}`}
                    onClick={() => void toggle(p)}
                  >
                    {p.followedByMe ? 'Вы подписаны' : 'Подписаться'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {cursor != null && (
          <button className="btn ghost small follow-more" type="button" disabled={loadingMore} onClick={() => void more()}>
            {loadingMore ? 'Загружаю…' : 'Показать ещё'}
          </button>
        )}
      </div>

      <div className="sheet-foot">
        <button className="btn ghost" type="button" onClick={() => dialog.current?.close()}>
          Закрыть
        </button>
      </div>
    </dialog>
  );
}

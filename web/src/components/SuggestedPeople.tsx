import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Suggestion } from '../api';
import { useSession } from '../session';
import { plural } from '../time';
import { Monogram } from './Monogram';

/** «Скрыть» прячет блок на неделю — в этом браузере: это удобство, а не настройка аккаунта. */
const HIDE_KEY = 'duet:suggestions-hidden-until';
const HIDE_MS = 7 * 24 * 60 * 60_000;

function hiddenNow() {
  try {
    return Number(localStorage.getItem(HIDE_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

/** Почему этот человек: кого из ваших подписок он читает — или сколько у него читателей. */
export function reasonOf(p: Suggestion) {
  if (p.mutualName && p.mutualCount > 1) return `Читают ${p.mutualName} и ещё ${p.mutualCount - 1}`;
  if (p.mutualName) return `Читает ${p.mutualName}`;
  if (p.followerCount > 0) return `${p.followerCount} ${plural(p.followerCount, 'подписчик', 'подписчика', 'подписчиков')}`;
  return `@${p.username}`;
}

function People() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="7.5" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 16.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M13 4.3a3 3 0 0 1 0 5.4M15 12.4c1.4.6 2.5 2 2.9 4.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * «Кого почитать» — пять человек, на которых вы ещё не подписаны: сперва те,
 * кого читают ваши подписки. В ленте — строкой на «хребте» (`rail`), в поиске
 * — простым блоком (`plain`). Подписались — человек остаётся в списке с «Вы
 * подписаны», чтобы можно было передумать. Пусто или скрыто — блока нет.
 */
export function SuggestedPeople({ variant = 'rail' }: { variant?: 'rail' | 'plain' }) {
  const { user } = useSession();
  const titleId = useId();
  const [people, setPeople] = useState<Suggestion[] | null>(null);
  const [hidden, setHidden] = useState(hiddenNow);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    api
      .suggestions()
      .then((res) => {
        if (!cancelled) setPeople(res.users);
      })
      .catch(() => {
        if (!cancelled) setPeople([]);
      });
    return () => {
      cancelled = true;
    };
  }, [hidden]);

  if (hidden || !people || people.length === 0) return null;

  async function toggle(p: Suggestion) {
    setBusy(p.id);
    setError(null);
    try {
      // Закрытый профиль отвечает заявкой — её отзывает та же кнопка.
      const res = await api.setFollow(p.username, !(p.followedByMe || p.requestedByMe));
      setPeople(
        (list) => list?.map((x) => (x.id === p.id ? { ...x, followedByMe: res.followedByMe, requestedByMe: Boolean(res.requested) } : x)) ?? list,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подписаться');
    } finally {
      setBusy(null);
    }
  }

  function hide() {
    try {
      localStorage.setItem(HIDE_KEY, String(Date.now() + HIDE_MS));
    } catch {
      // Нет хранилища — скроем до перезагрузки, и только.
    }
    setHidden(true);
  }

  const body = (
    <>
      <div className="suggest-head">
        <h2 className="suggest-title" id={titleId}>
          Кого почитать
        </h2>
        <button className="post-delete" type="button" title="Спрятать на неделю" onClick={hide}>
          Скрыть
        </button>
      </div>
      <ul className="follow-people">
        {people.map((p) => (
          <li key={p.id}>
            <Link className="follow-person" to={`/u/${p.username}`}>
              <Monogram username={p.username} displayName={p.displayName} avatarUrl={p.avatarUrl} size="sm" />
              <span className="follow-who">
                <strong>{p.displayName}</strong>
                <span>{reasonOf(p)}</span>
              </span>
            </Link>
            {user && (
              <button
                className={p.followedByMe || p.requestedByMe ? 'btn ghost small' : 'btn small'}
                type="button"
                disabled={busy === p.id}
                aria-label={p.followedByMe ? `Отписаться от ${p.displayName}` : `Подписаться на ${p.displayName}`}
                onClick={() => void toggle(p)}
              >
                {p.followedByMe ? 'Вы подписаны' : p.requestedByMe ? 'Заявка отправлена' : 'Подписаться'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </>
  );

  return variant === 'rail' ? (
    <section className="rail-row suggest-row" aria-labelledby={titleId}>
      <span className="suggest-mark">
        <People />
      </span>
      <div>{body}</div>
    </section>
  ) : (
    <section className="suggest-plain" aria-labelledby={titleId}>
      {body}
    </section>
  );
}

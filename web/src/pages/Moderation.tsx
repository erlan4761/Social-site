import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type BannedUser, type ModerationAction, type ModerationItem } from '../api';
import { Monogram } from '../components/Monogram';
import { fullDate, plural, timeAgo } from '../time';

/**
 * Панель модератора: жалобы по предметам — сколько, за что, что пишут
 * жалующиеся — и три решения. Модератора назначает владелец сервера
 * (`npm run moderator -- <логин>`), в интерфейсе этого нет.
 */

const REASONS: Record<string, string> = { spam: 'спам', abuse: 'оскорбления', adult: 'для взрослых', other: 'другое' };
const RESOLUTIONS: Record<string, string> = { dismissed: 'оставлено', removed: 'удалено', banned: 'автор заблокирован' };
const KINDS: Record<string, string> = { post: 'Запись', comment: 'Комментарий', user: 'Профиль' };

export function Moderation() {
  const [tab, setTab] = useState<'open' | 'resolved' | 'banned'>('open');
  const [items, setItems] = useState<ModerationItem[] | null>(null);
  const [banned, setBanned] = useState<BannedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    if (tab === 'banned') {
      setBanned(null);
      api.bannedUsers().then((r) => setBanned(r.users)).catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить'));
    } else {
      setItems(null);
      api.moderationReports(tab).then((r) => setItems(r.reports)).catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить'));
    }
  }, [tab]);
  useEffect(load, [load]);

  async function decide(item: ModerationItem, action: ModerationAction) {
    const what = action === 'ban' ? `Заблокировать @${item.subject?.author?.username}? Все его сеансы закроются, войти он не сможет.` : null;
    if (what && !window.confirm(what)) return;
    setBusy(`${item.targetType}:${item.targetId}`);
    setError(null);
    try {
      await api.resolveReport(item.targetType, item.targetId, action);
      setItems((prev) => prev?.filter((x) => x !== item) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    } finally {
      setBusy(null);
    }
  }

  async function unban(u: BannedUser) {
    setBusy(u.username);
    try {
      await api.unbanUser(u.username);
      setBanned((prev) => prev?.filter((x) => x.username !== u.username) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="events-top">
        <h1 className="page-title">Жалобы</h1>
      </div>
      <div className="mod-tabs" role="tablist" aria-label="Что показать">
        {(['open', 'resolved', 'banned'] as const).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} className={tab === t ? 'chip on' : 'chip'} onClick={() => setTab(t)}>
            {t === 'open' ? 'Открытые' : t === 'resolved' ? 'Разобранные' : 'Заблокированные'}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}

      {tab === 'banned' ? (
        banned === null ? (
          <p className="empty flush">Загружаю…</p>
        ) : banned.length === 0 ? (
          <p className="empty flush">Никто не заблокирован.</p>
        ) : (
          <ul className="mod-list">
            {banned.map((u) => (
              <li key={u.username} className="mod-card">
                <div className="mod-who">
                  <Monogram username={u.username} displayName={u.displayName} avatarUrl={u.avatarUrl} size="sm" />
                  <span>
                    <strong>{u.displayName}</strong> @{u.username}
                    <span className="mod-meta">
                      заблокирован {timeAgo(u.bannedAt)}
                      {u.reason ? ` — ${u.reason}` : ''}
                    </span>
                  </span>
                </div>
                <div className="members-actions">
                  <button className="act" type="button" disabled={busy === u.username} onClick={() => void unban(u)}>
                    Снять блокировку
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : items === null ? (
        <p className="empty flush">Загружаю…</p>
      ) : items.length === 0 ? (
        <p className="empty flush">{tab === 'open' ? 'Открытых жалоб нет.' : 'Разобранных пока нет.'}</p>
      ) : (
        <ul className="mod-list">
          {items.map((item) => {
            const s = item.subject;
            const key = `${item.targetType}:${item.targetId}`;
            return (
              <li key={key} className="mod-card">
                <div className="mod-head">
                  <span className="mod-kind">{KINDS[item.targetType]}</span>
                  <span className="mod-count">
                    {item.count} {plural(item.count, 'жалоба', 'жалобы', 'жалоб')}:{' '}
                    {Object.entries(item.reasons).map(([r, n]) => `${REASONS[r] ?? r} × ${n}`).join(', ')}
                  </span>
                  <time className="mod-meta" dateTime={item.lastAt} title={fullDate(item.lastAt)}>
                    {timeAgo(item.lastAt)}
                  </time>
                </div>
                {s ? (
                  <div className="mod-subject">
                    {s.author && (
                      <Link className="mod-who" to={`/u/${s.author.username}`}>
                        <Monogram username={s.author.username} displayName={s.author.displayName} avatarUrl={s.author.avatarUrl} size="sm" />
                        <span>
                          <strong>{s.author.displayName}</strong> @{s.author.username}
                          {s.banned && <span className="dialog-flag">заблокирован</span>}
                        </span>
                      </Link>
                    )}
                    {s.text && <p className="mod-text">{s.text}</p>}
                    {s.media && <img className="mod-media" src={s.media} alt="" loading="lazy" />}
                    {item.targetType === 'post' && <Link to={`/p/${item.targetId}`}>Открыть запись</Link>}
                    {item.targetType === 'comment' && s.postId && <Link to={`/p/${s.postId}`}>Открыть обсуждение</Link>}
                  </div>
                ) : (
                  <p className="mod-text gone">Этого уже нет — удалено автором или модератором.</p>
                )}
                {item.notes.length > 0 && (
                  <ul className="mod-notes">
                    {item.notes.map((n, i) => (
                      <li key={i}>
                        <strong>@{n.reporter}</strong> ({REASONS[n.reason] ?? n.reason}): {n.note}
                      </li>
                    ))}
                  </ul>
                )}
                {tab === 'open' ? (
                  <div className="members-actions">
                    <button className="act" type="button" disabled={busy === key} onClick={() => void decide(item, 'dismiss')}>
                      Оставить
                    </button>
                    {s && item.targetType !== 'user' && (
                      <button className="act act-danger" type="button" disabled={busy === key} onClick={() => void decide(item, 'remove')}>
                        Удалить {item.targetType === 'post' ? 'запись' : 'комментарий'}
                      </button>
                    )}
                    {s && !s.banned && (
                      <button className="act act-danger" type="button" disabled={busy === key} onClick={() => void decide(item, 'ban')}>
                        Заблокировать автора
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="mod-meta">Решение: {RESOLUTIONS[item.resolution ?? ''] ?? item.resolution}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

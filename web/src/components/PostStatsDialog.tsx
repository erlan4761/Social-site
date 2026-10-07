import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type PostStats } from '../api';
import { plural } from '../time';

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * Статистика своей записи: сколько человек видели (и сколько из них
 * подписчики), как отозвались и как шли просмотры по дням — столбиками.
 * Числа обезличены: кто именно смотрел и сохранял — не показывается никому.
 */
export function PostStatsDialog({ postId, onClose }: { postId: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [stats, setStats] = useState<PostStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = `stats-${postId}-title`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.showModal();
    const onNativeClose = () => close.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .postStats(postId)
      .then((res) => {
        if (!cancelled) setStats(res.stats);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить статистику');
      });
    return () => {
      cancelled = true;
    };
  }, [postId]);

  const peak = Math.max(1, ...(stats?.byDay.map((d) => d.views) ?? [0]));

  return (
    <dialog
      className="sheet stats-sheet"
      ref={ref}
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === ref.current) ref.current.close();
      }}
    >
      <h2 className="sheet-title" id={titleId}>
        Статистика записи
      </h2>
      {error && <p className="error">{error}</p>}
      {!stats && !error && <p className="list-note">Загружаю…</p>}
      {stats && (
        <>
          <dl className="stats-grid">
            <div className="stats-main">
              <dt>Видели</dt>
              <dd>
                {stats.views} {plural(stats.views, 'человек', 'человека', 'человек')}
                {stats.views > 0 && (
                  <span className="stats-sub">
                    из них подписчики — {stats.fromFollowers} ({percent(stats.fromFollowers / stats.views)})
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Отметки</dt>
              <dd>{stats.likes}</dd>
            </div>
            <div>
              <dt>Ответы</dt>
              <dd>{stats.comments}</dd>
            </div>
            <div>
              <dt>Репосты</dt>
              <dd>{stats.reposts}</dd>
            </div>
            <div>
              <dt>Цитаты</dt>
              <dd>{stats.quotes}</dd>
            </div>
            <div>
              <dt>Закладки</dt>
              <dd>{stats.bookmarks}</dd>
            </div>
            <div>
              <dt>Отозвались</dt>
              <dd>{stats.engagement == null ? '—' : percent(stats.engagement)}</dd>
            </div>
          </dl>

          <h3 className="stats-days-title">Просмотры по дням</h3>
          <ol className="stats-days">
            {stats.byDay.map((d) => (
              <li key={d.day} aria-label={`${dayLabel(d.day)}: ${d.views} ${plural(d.views, 'просмотр', 'просмотра', 'просмотров')}`}>
                <span className="stats-bar" style={{ height: `${Math.max(4, (d.views / peak) * 100)}%` }} data-empty={d.views === 0 || undefined} />
                <span className="stats-day" aria-hidden="true">
                  {dayLabel(d.day)}
                </span>
              </li>
            ))}
          </ol>
          <p className="settings-note">Просмотры, засчитанные до появления статистики, есть в общем числе, но не по дням.</p>
        </>
      )}
      <div className="sheet-foot">
        <button className="btn ghost" type="button" onClick={() => ref.current?.close()}>
          Закрыть
        </button>
      </div>
    </dialog>
  );
}

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Post } from '../api';
import { PostRow } from '../components/PostRow';
import { useSession } from '../session';
import { usePostStream } from '../usePostStream';

/**
 * Свои закладки. Список листается по времени сохранения, а не по времени
 * записи: сохранил старую запись — она обязана оказаться сверху. Курсором
 * здесь служит id закладки, но знать об этом странице не нужно — `usePostStream`
 * возвращает серверу тот же курсор, что получил.
 */
export function Bookmarks() {
  const { user } = useSession();
  const stream = usePostStream({ source: 'bookmarks' });
  // Снятая закладка убирается из списка на месте: перезагружать страницу ради
  // одной исчезнувшей строки незачем. Множество, а не фильтрация состояния,
  // потому что откат неудачного запроса обязан вернуть строку на место.
  const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set());

  const patch = useCallback((id: number, changes: Partial<Post>) => {
    stream.patch(id, changes);
    if (changes.bookmarkedByMe === undefined) return;
    setDropped((prev) => {
      const next = new Set(prev);
      if (changes.bookmarkedByMe) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [stream.patch]);

  const visible = stream.posts.filter((post) => !dropped.has(post.id));

  return (
    <>
      <div className="events-top">
        <h1 className="page-title">Закладки</h1>
        <Link className="btn ghost small" to="/">
          Вернуться в ленту
        </Link>
      </div>

      {visible.length > 0 && (
        <p className="page-lede">
          Список личный: автор не узнаёт, что вы сохранили его запись. Последнее
          сохранённое — сверху.
        </p>
      )}

      <div className="rail">
        {stream.error && <p className="error">{stream.error}</p>}

        {stream.loading ? (
          <p className="empty">Загружаю…</p>
        ) : visible.length === 0 ? (
          <p className="empty">
            <strong>Сохранённых записей пока нет.</strong>
            Флажок под записью откладывает её сюда — список личный, и автор о нём не узнает.
          </p>
        ) : (
          visible.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              canDelete={post.author.id === user?.id}
              onDelete={stream.remove}
              onPatch={patch}
            />
          ))
        )}
      </div>

      {stream.hasMore && (
        <div className="more">
          <button className="btn ghost" type="button" onClick={stream.loadMore} disabled={stream.loadingMore}>
            {stream.loadingMore ? 'Загружаю…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </>
  );
}

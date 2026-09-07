import { Composer } from '../components/Composer';
import { PostRow } from '../components/PostRow';
import { useSession } from '../session';
import { usePostStream } from '../usePostStream';

export function Feed() {
  const { user } = useSession();
  const stream = usePostStream();

  return (
    <>
      <h1 className="page-title">Общая лента</h1>

      <div className="rail">
        <Composer onPublished={stream.prepend} />

        {stream.error && <p className="error">{stream.error}</p>}

        {stream.loading ? (
          <p className="empty">Загружаю…</p>
        ) : stream.posts.length === 0 ? (
          <p className="empty">
            <strong>Здесь пока пусто.</strong>
            Напишите первый пост — он откроет хронику.
          </p>
        ) : (
          stream.posts.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              fresh={post.id === stream.freshId}
              canDelete={post.author.id === user?.id}
              onDelete={stream.remove}
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

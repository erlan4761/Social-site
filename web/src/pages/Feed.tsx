import { Fragment, useCallback, useState } from 'react';
import { Composer } from '../components/Composer';
import { PostRow } from '../components/PostRow';
import { SuggestedPeople } from '../components/SuggestedPeople';
import { ScheduledPostsBar } from '../components/ScheduledPosts';
import { FollowedTags } from '../components/FollowedTags';
import { useSession } from '../session';
import { usePostStream } from '../usePostStream';

type Tab = 'all' | 'following';

export function Feed() {
  const { user } = useSession();
  const [tab, setTab] = useState<Tab>('all');
  // Отложенная запись вышла по расписанию — ленту просим заново тем же запросом.
  const [reloadKey, setReloadKey] = useState(0);
  const [queueVersion, setQueueVersion] = useState(0);
  const stream = usePostStream(tab === 'following' ? { feed: 'following', reloadKey } : { reloadKey });
  const onDue = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <>
      <div className="feed-tabs" role="tablist" aria-label="Лента">
        <button
          className="feed-tab"
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          onClick={() => setTab('all')}
        >
          Все
        </button>
        <button
          className="feed-tab"
          type="button"
          role="tab"
          aria-selected={tab === 'following'}
          onClick={() => setTab('following')}
        >
          Подписки
        </button>
      </div>

      <div className="rail">
        <Composer onPublished={stream.prepend} onScheduled={() => setQueueVersion((v) => v + 1)} />
        <ScheduledPostsBar version={queueVersion} onPublished={stream.prepend} onDue={onDue} />
        {tab === 'following' && <FollowedTags />}

        {stream.error && <p className="error">{stream.error}</p>}

        {stream.loading ? (
          <p className="empty">Загружаю…</p>
        ) : stream.posts.length === 0 ? (
          <p className="empty">
            {tab === 'following' ? (
              <>
                <strong>В подписках пока пусто.</strong>
                Загляните во «Все» или начните с тех, кого предлагаем ниже.
              </>
            ) : (
              <>
                <strong>Здесь пока пусто.</strong>
                Напишите первый пост — с него всё начнётся.
              </>
            )}
          </p>
        ) : (
          // «Кого почитать» — после третьей записи общей ленты: сверху он мешал
          // бы читать, а в самом конце его никто не увидит.
          stream.posts.map((post, i) => (
            <Fragment key={post.id}>
              <PostRow
                post={post}
                fresh={post.id === stream.freshId}
                canDelete={post.author.id === user?.id}
                onDelete={stream.remove}
                onPatch={stream.patch}
                onCreated={stream.prepend}
              />
              {tab === 'all' && i === Math.min(2, stream.posts.length - 1) && <SuggestedPeople />}
            </Fragment>
          ))
        )}
        {!stream.loading && stream.posts.length === 0 && tab === 'following' && <SuggestedPeople />}
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

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type TagStat } from '../api';
import { PostRow } from '../components/PostRow';
import { TrendingTags } from '../components/TrendingTags';
import { tagFromParam } from '../hashtags';
import { useSession } from '../session';
import { plural } from '../time';
import { usePostStream } from '../usePostStream';

/** Лента одного тега: `/tag/плёнка`. «#Плёнка» и «пленка» в адресе — одна и та же страница. */
export function TagPage() {
  const { tag: raw = '' } = useParams();
  const tag = tagFromParam(raw);
  return tag ? <TagFeed key={tag} tag={tag} raw={raw} /> : <BadTag />;
}

function BadTag() {
  return (
    <>
      <div className="events-top">
        <h1 className="page-title">Такого тега нет</h1>
        <Link className="btn ghost small" to="/">
          Вернуться в ленту
        </Link>
      </div>
      <p className="empty">
        <strong>Тег — это слово после «#».</strong>
        Буквы, цифры и подчёркивание, от двух знаков и хотя бы одна буква: #плёнка, #ночная_съёмка.
      </p>
    </>
  );
}

function TagFeed({ tag, raw }: { tag: string; raw: string }) {
  const { user } = useSession();
  const stream = usePostStream({ tag });
  const [info, setInfo] = useState<TagStat | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .tagInfo(tag)
      .then((res) => {
        if (!cancelled) setInfo(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tag]);

  const label = info?.label ?? raw.replace(/^#/, '').toLowerCase();

  return (
    <>
      <div className="events-top">
        <h1 className="page-title tag-title">#{label}</h1>
        <Link className="btn ghost small" to="/">
          Вернуться в ленту
        </Link>
      </div>

      {info && info.count > 0 && (
        <p className="page-lede">
          {info.count} {plural(info.count, 'запись', 'записи', 'записей')} с этим тегом. Свежие — сверху.
        </p>
      )}

      <div className="rail">
        {stream.error && <p className="error">{stream.error}</p>}

        {stream.loading ? (
          <p className="empty">Загружаю…</p>
        ) : stream.posts.length === 0 ? (
          <p className="empty">
            <strong>С этим тегом пока ничего нет.</strong>
            Напишите запись с #{label} — она откроет эту страницу.
          </p>
        ) : (
          stream.posts.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              canDelete={post.author.id === user?.id}
              onDelete={stream.remove}
              onPatch={stream.patch}
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

      <TrendingTags skip={tag} title="Ещё популярное" />
    </>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Post } from '../api';
import { useSession } from '../session';
import { fullDate, plural, timeAgo } from '../time';
import { CommentThread } from './CommentThread';
import { Monogram } from './Monogram';

type Props = {
  post: Post;
  fresh?: boolean;
  canDelete: boolean;
  onDelete: (id: number) => void;
  onPatch: (id: number, changes: Partial<Post>) => void;
};

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M8 14S1.5 10.2 1.5 5.9A3.4 3.4 0 0 1 8 4.3a3.4 3.4 0 0 1 6.5 1.6C14.5 10.2 8 14 8 14Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PostMedia({ media }: { media: NonNullable<Post['media']> }) {
  if (media.type === 'image') {
    // object-fit: contain, не cover — в дневнике важно видеть кадр целиком,
    // а не обрезанный до квадрата фрагмент.
    return (
      <figure className="post-media">
        <img src={media.url} alt={media.name ?? ''} loading="lazy" />
      </figure>
    );
  }

  if (media.type === 'video') {
    return (
      <figure className="post-media">
        {/* preload=metadata: лента не тянет гигабайты при прокрутке */}
        <video src={media.url} controls preload="metadata" />
      </figure>
    );
  }

  return (
    <figure className="post-media audio">
      {media.name && <figcaption>{media.name}</figcaption>}
      <audio src={media.url} controls preload="metadata" />
    </figure>
  );
}

export function PostRow({ post, fresh, canDelete, onDelete, onPatch }: Props) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [likeError, setLikeError] = useState<string | null>(null);
  const { author } = post;
  const profile = `/u/${author.username}`;

  async function toggleLike() {
    if (!user) return;
    const next = !post.likedByMe;

    // Optimistic: the heart answers the click, then the server confirms.
    onPatch(post.id, {
      likedByMe: next,
      likeCount: post.likeCount + (next ? 1 : -1),
    });
    setLikeError(null);

    try {
      const res = await api.setLike(post.id, next);
      onPatch(post.id, { likedByMe: res.likedByMe, likeCount: res.likeCount });
    } catch (err) {
      onPatch(post.id, { likedByMe: post.likedByMe, likeCount: post.likeCount });
      setLikeError(err instanceof ApiError ? err.message : 'Не удалось изменить лайк');
    }
  }

  return (
    <article className={fresh ? 'rail-row fresh' : 'rail-row'}>
      <Link className="avatar-link" to={profile} aria-label={`Профиль ${author.displayName}`}>
        <Monogram username={author.username} displayName={author.displayName} avatarUrl={author.avatarUrl} />
      </Link>

      <div>
        <header className="post-head">
          <Link className="post-name" to={profile}>
            {author.displayName}
          </Link>
          <span className="post-handle">@{author.username}</span>
          <time className="post-time" dateTime={post.createdAt} title={fullDate(post.createdAt)}>
            {timeAgo(post.createdAt)}
          </time>
        </header>

        {post.body && <p className="post-body">{post.body}</p>}

        {post.media && <PostMedia media={post.media} />}

        <div className="post-actions">
          <button
            className={post.likedByMe ? 'act liked' : 'act'}
            type="button"
            onClick={() => void toggleLike()}
            disabled={!user}
            aria-pressed={post.likedByMe}
            title={user ? undefined : 'Войдите, чтобы отмечать записи'}
          >
            <Heart filled={post.likedByMe} />
            {post.likeCount > 0 && <span>{post.likeCount}</span>}
            <span className="sr-only">
              {post.likedByMe ? 'Снять отметку' : 'Отметить запись'}
            </span>
          </button>

          <button className={open ? 'act open' : 'act'} type="button" onClick={() => setOpen(!open)}>
            {post.commentCount === 0
              ? 'Ответить'
              : `${post.commentCount} ${plural(post.commentCount, 'ответ', 'ответа', 'ответов')}`}
          </button>

          {canDelete && (
            <button className="post-delete" type="button" onClick={() => onDelete(post.id)}>
              Удалить
            </button>
          )}
        </div>

        {likeError && <p className="error">{likeError}</p>}

        {open && (
          <CommentThread
            postId={post.id}
            postAuthorId={author.id}
            onCountChange={(delta) => onPatch(post.id, { commentCount: post.commentCount + delta })}
          />
        )}
      </div>
    </article>
  );
}

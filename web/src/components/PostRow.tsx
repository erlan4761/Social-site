import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Post } from '../api';
import { useSession } from '../session';
import { highlight as markTerms } from '../highlight';
import { fullDate, plural, timeAgo } from '../time';
import { CommentThread } from './CommentThread';
import { PostText } from './PostText';
import { Monogram } from './Monogram';
import { ReportDialog } from './ReportDialog';

/** Править запись можно двое суток — как и сообщение. */
export const POST_EDIT_WINDOW_MS = 48 * 60 * 60_000;
const POST_LIMIT = 500;

type Props = {
  post: Post;
  fresh?: boolean;
  canDelete: boolean;
  /** Страница отдельного поста открывает ветку сразу: за ней туда и приходят. */
  openThread?: boolean;
  /** Термы поиска для подсветки тела записи. Задаёт только экран поиска —
   *  в остальных лентах проп не передаётся и текст рисуется как раньше. */
  highlight?: string[];
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

/** Флажок закладки: та же манера, что у сердца — контур, заливка при включении. */
function Flag({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M4 2.7h8v10.9l-4-2.9-4 2.9V2.7Z"
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

export function PostRow({ post, fresh, canDelete, openThread = false, highlight, onDelete, onPatch }: Props) {
  const { user } = useSession();
  const [open, setOpen] = useState(openThread);
  const [likeError, setLikeError] = useState<string | null>(null);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  /** Текст правки, пока запись редактируется; null — не редактируется. */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const { author } = post;
  const canEdit = user?.id === author.id && Date.now() - Date.parse(post.createdAt) <= POST_EDIT_WINDOW_MS;
  const profile = `/u/${author.username}`;
  // На свою запись жаловаться некому: сервер такую жалобу и не примет.
  const canReport = Boolean(user) && user?.id !== author.id;

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

  /**
   * Закладка приватна: уведомления о ней нет и не будет, автор о сохранении не
   * узнаёт. Поэтому счётчика рядом с флажком тоже нет — считать нечего.
   */
  async function toggleBookmark() {
    if (!user) return;
    const next = !post.bookmarkedByMe;

    onPatch(post.id, { bookmarkedByMe: next });
    setBookmarkError(null);

    try {
      const res = await api.setBookmark(post.id, next);
      onPatch(post.id, { bookmarkedByMe: res.bookmarkedByMe });
    } catch (err) {
      onPatch(post.id, { bookmarkedByMe: post.bookmarkedByMe });
      setBookmarkError(err instanceof ApiError ? err.message : 'Не удалось изменить закладку');
    }
  }

  async function saveEdit() {
    if (draft == null || saving) return;
    const text = draft.trim();
    if ((!text && !post.media) || text.length > POST_LIMIT) return;
    setSaving(true);
    setEditError(null);
    try {
      const res = await api.updatePost(post.id, text);
      onPatch(post.id, { body: res.post.body, editedAt: res.post.editedAt ?? null });
      setDraft(null);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
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
          {post.editedAt && (
            <span className="post-edited" title={`Изменено ${fullDate(post.editedAt)}`}>
              изменено
            </span>
          )}
        </header>

        {draft != null ? (
          <form
            className="post-edit"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
          >
            <label className="sr-only" htmlFor={`edit-${post.id}`}>
              Текст записи
            </label>
            <textarea
              id={`edit-${post.id}`}
              value={draft}
              rows={3}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void saveEdit();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraft(null);
                }
              }}
            />
            <div className="post-edit-foot">
              {POST_LIMIT - draft.length <= 60 && (
                <span className={draft.length > POST_LIMIT ? 'counter over' : 'counter'}>{POST_LIMIT - draft.length}</span>
              )}
              <button className="btn ghost small" type="button" disabled={saving} onClick={() => setDraft(null)}>
                Отмена
              </button>
              <button
                className="btn small"
                type="submit"
                disabled={saving || draft.length > POST_LIMIT || (!draft.trim() && !post.media)}
              >
                {saving ? 'Сохраняю…' : 'Сохранить'}
              </button>
            </div>
            {editError && <p className="error">{editError}</p>}
          </form>
        ) : (
          post.body && (
            <p className="post-body">
              {highlight?.length ? markTerms(post.body, highlight) : <PostText text={post.body} />}
            </p>
          )
        )}

        {post.media && <PostMedia media={post.media} />}

        {/* Пока запись правится, ряд действий убран: «Сохранить» правку не должно
            соседствовать с «Сохранить» закладки. */}
        {draft == null && (
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

            <button
              className={post.bookmarkedByMe ? 'act saved' : 'act'}
              type="button"
              onClick={() => void toggleBookmark()}
              disabled={!user}
              aria-pressed={post.bookmarkedByMe}
              title={user ? undefined : 'Войдите, чтобы сохранять записи'}
            >
              <Flag filled={post.bookmarkedByMe} />
              <span>{post.bookmarkedByMe ? 'Сохранено' : 'Сохранить'}</span>
            </button>

            {canEdit && (
              <button
                className="post-delete"
                type="button"
                title="Править можно двое суток после публикации"
                onClick={() => {
                  setEditError(null);
                  setDraft(post.body);
                }}
              >
                Изменить
              </button>
            )}

            {canDelete && (
              <button className="post-delete" type="button" onClick={() => onDelete(post.id)}>
                Удалить
              </button>
            )}

            {canReport && (
              <button className="act-danger" type="button" onClick={() => setReporting(true)}>
                Пожаловаться
              </button>
            )}
          </div>
        )}

        {reporting && (
          <ReportDialog
            targetType="post"
            targetId={post.id}
            subject={`Запись @${author.username}`}
            onClose={() => setReporting(false)}
          />
        )}

        {likeError && <p className="error">{likeError}</p>}
        {bookmarkError && <p className="error">{bookmarkError}</p>}

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

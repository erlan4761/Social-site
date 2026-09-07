import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Comment } from '../api';
import { useSession } from '../session';
import { timeAgo, fullDate } from '../time';
import { Monogram } from './Monogram';

const LIMIT = 300;

type Props = {
  postId: number;
  postAuthorId: number;
  /** Keeps the post's own counter in step with what the thread holds. */
  onCountChange: (delta: number) => void;
};

export function CommentThread({ postId, postAuthorId, onCountChange }: Props) {
  const { user } = useSession();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .comments(postId)
      .then((res) => !cancelled && setComments(res.comments))
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить ответы');
      });
    return () => {
      cancelled = true;
    };
  }, [postId]);

  const left = LIMIT - text.length;
  const canSend = text.trim().length > 0 && left >= 0 && !sending;

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const { comment } = await api.addComment(postId, text.trim());
      setComments((prev) => [...(prev ?? []), comment]);
      setText('');
      onCountChange(1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить');
    } finally {
      setSending(false);
    }
  }

  async function remove(id: number) {
    const snapshot = comments;
    setComments((prev) => prev?.filter((c) => c.id !== id) ?? null);
    onCountChange(-1);
    try {
      await api.deleteComment(id);
    } catch (err) {
      setComments(snapshot); // вернуть на место: удаление не прошло
      onCountChange(1);
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить');
    }
  }

  return (
    <div className="thread">
      {error && <p className="error">{error}</p>}

      {comments === null ? (
        <p className="thread-empty">Загружаю ответы…</p>
      ) : comments.length === 0 ? (
        <p className="thread-empty">Ответов пока нет. Напишите первый.</p>
      ) : (
        comments.map((c) => (
          <article className="comment" key={c.id}>
            <Link className="avatar-link" to={`/u/${c.author.username}`} aria-label={`Профиль ${c.author.displayName}`}>
              <Monogram username={c.author.username} displayName={c.author.displayName} avatarUrl={c.author.avatarUrl} size="sm" />
            </Link>

            <div>
              <header className="comment-head">
                <Link className="comment-name" to={`/u/${c.author.username}`}>
                  {c.author.displayName}
                </Link>
                <time className="comment-time" dateTime={c.createdAt} title={fullDate(c.createdAt)}>
                  {timeAgo(c.createdAt)}
                </time>
              </header>

              <p className="comment-body">{c.body}</p>

              {user && (user.id === c.author.id || user.id === postAuthorId) && (
                <button className="post-delete" type="button" onClick={() => void remove(c.id)}>
                  Удалить
                </button>
              )}
            </div>
          </article>
        ))
      )}

      {user && (
        <form className="comment-form" onSubmit={send}>
          <Monogram username={user.username} displayName={user.displayName} avatarUrl={user.avatarUrl} size="sm" />
          <div>
            <label className="sr-only" htmlFor={`reply-${postId}`}>
              Ответить на пост
            </label>
            <textarea
              id={`reply-${postId}`}
              rows={1}
              value={text}
              placeholder="Ответить…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="comment-form-foot">
              {left <= 60 && <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>}
              <button className="btn small" type="submit" disabled={!canSend}>
                {sending ? 'Отправляю…' : 'Ответить'}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

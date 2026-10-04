import { Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Comment } from '../api';
import { useSession } from '../session';
import { timeAgo, fullDate } from '../time';
import { Monogram } from './Monogram';
import { ReportDialog } from './ReportDialog';

const LIMIT = 300;

/**
 * Ветки в два уровня, как во ВКонтакте и Телеграме: корень — комментарий к
 * самой записи, под ним по порядку все ответы его ветки, в том числе ответы
 * на ответы. Корень ищется по цепочке replyTo среди загруженных; исходный
 * удалили или он не виден (блокировка) — ответ становится корнем сам.
 */
export function threadsOf(comments: Comment[]) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c: Comment) => {
    let cur = c;
    for (let depth = 0; depth < 50 && cur.replyTo && byId.has(cur.replyTo.id); depth++) cur = byId.get(cur.replyTo.id)!;
    return cur;
  };
  const threads = new Map<number, { root: Comment; replies: Comment[] }>();
  for (const c of [...comments].sort((a, b) => a.id - b.id)) {
    const root = rootOf(c);
    if (!threads.has(root.id)) threads.set(root.id, { root, replies: [] });
    if (root.id !== c.id) threads.get(root.id)!.replies.push(c);
  }
  return [...threads.values()];
}

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
  // Жалоба открыта не более чем на один ответ разом — храним id, а не флаг.
  const [reporting, setReporting] = useState<Comment | null>(null);
  /** На какой комментарий отвечаем — полоса «Ответ Нине» над полем. */
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

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
      const { comment } = await api.addComment(postId, text.trim(), replyTo?.id);
      setComments((prev) => [...(prev ?? []), comment]);
      setText('');
      setReplyTo(null);
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

  const renderComment = (c: Comment, root: Comment | null) => (
    <article className={root ? 'comment reply' : 'comment'} key={c.id}>
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

        {/* «в ответ: Нина» — у ответа не корню ветки: иначе было бы непонятно, кому.
          Имя с двоеточием, а не «Нине»: склонять имена из профиля нечем. */}
        {c.replyTo && c.replyTo.id !== root?.id && (
          <p className="comment-reply-to">в ответ: {c.replyTo.author.displayName}</p>
        )}
        <p className="comment-body">{c.body}</p>

        {user && (
          <div className="comment-actions">
            <button
              className="post-delete"
              type="button"
              onClick={() => {
                setReplyTo(c);
                field.current?.focus();
              }}
            >
              Ответить
            </button>
            {(user.id === c.author.id || user.id === postAuthorId) && (
              <button className="post-delete" type="button" onClick={() => void remove(c.id)}>
                Удалить
              </button>
            )}

            {user.id !== c.author.id && (
              <button className="act-danger" type="button" onClick={() => setReporting(c)}>
                Пожаловаться
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );

  return (
    <div className="thread">
      {error && <p className="error">{error}</p>}

      {reporting && (
        <ReportDialog
          targetType="comment"
          targetId={reporting.id}
          subject={`Ответ @${reporting.author.username}`}
          onClose={() => setReporting(null)}
        />
      )}

      {comments === null ? (
        <p className="thread-empty">Загружаю ответы…</p>
      ) : comments.length === 0 ? (
        <p className="thread-empty">Ответов пока нет. Напишите первый.</p>
      ) : (
        threadsOf(comments).map(({ root, replies }) => (
          <Fragment key={root.id}>
            {renderComment(root, null)}
            {replies.length > 0 && <div className="comment-replies">{replies.map((r) => renderComment(r, root))}</div>}
          </Fragment>
        ))
      )}

      {user && (
        <form className="comment-form" onSubmit={send}>
          <Monogram username={user.username} displayName={user.displayName} avatarUrl={user.avatarUrl} size="sm" />
          <div>
            {replyTo && (
              <p className="comment-replying">
                <span>
                  Отвечаете: <strong>{replyTo.author.displayName}</strong>
                </span>
                <button className="icon-btn" type="button" aria-label="Отменить ответ" onClick={() => setReplyTo(null)}>
                  ×
                </button>
              </p>
            )}
            <label className="sr-only" htmlFor={`reply-${postId}`}>
              {replyTo ? `Ответ на комментарий: ${replyTo.author.displayName}` : 'Ответить на пост'}
            </label>
            <textarea
              id={`reply-${postId}`}
              ref={field}
              rows={1}
              value={text}
              placeholder={replyTo ? 'Ваш ответ…' : 'Ответить…'}
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

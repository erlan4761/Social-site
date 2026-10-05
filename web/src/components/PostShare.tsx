import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Post } from '../api';
import { timeAgo } from '../time';

const QUOTE_LIMIT = 500;

/** Две стрелки по кругу — знак репоста. Та же манера, что у сердца и флажка. */
export function Repeat() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M3 6.5V5.2A1.7 1.7 0 0 1 4.7 3.5H12m-2-2 2 2-2 2M13 9.5v1.3a1.7 1.7 0 0 1-1.7 1.7H4m2 2-2-2 2-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type MenuProps = {
  at: { x: number; y: number };
  reposted: boolean;
  onRepost: () => void;
  onQuote: () => void;
  onClose: () => void;
};

/** Меню под кнопкой репоста: сделать (или отменить) репост и процитировать. */
export function RepostMenu({ at, reposted, onRepost, onQuote, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
      top: at.y + height > window.innerHeight - 8 ? Math.max(8, at.y - height - 32) : at.y,
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [at.x, at.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="msg-menu" ref={ref} role="menu" aria-label="Поделиться записью" style={{ left: pos.left, top: pos.top }}>
      <div className="msg-menu-list">
        <button className="msg-menu-item" type="button" role="menuitem" onClick={onRepost}>
          <Repeat />
          {reposted ? 'Отменить репост' : 'Сделать репост'}
        </button>
        <button className="msg-menu-item" type="button" role="menuitem" onClick={onQuote}>
          <span className="quote-mark" aria-hidden="true">«»</span>
          Цитировать
        </button>
      </div>
    </div>
  );
}

/**
 * Процитированная запись внутри своей: автор, начало текста, первый снимок.
 * Целиком — ссылка на оригинал. Удалённая или скрытая — честная заглушка,
 * а не пустое место: цитата без предмета иначе читалась бы как бессмыслица.
 */
export function QuoteCard({ post, link = true }: { post: Post | null; link?: boolean }) {
  if (!post) {
    return <p className="post-quote gone">Запись недоступна: её удалили или она скрыта от вас.</p>;
  }
  const pictures = (post.gallery?.length ? post.gallery : post.media ? [post.media] : []).filter((m) => m.type !== 'audio');
  const cover = pictures[0];
  const inner = (
    <>
      <span className="post-quote-head">
        <span className="post-quote-name">{post.author.displayName}</span>
        <span className="post-handle">@{post.author.username}</span>
        <time className="post-time" dateTime={post.createdAt}>
          {timeAgo(post.createdAt)}
        </time>
      </span>
      {post.body && <span className="post-quote-body">{post.body}</span>}
      {cover && (
        <span className="post-quote-media">
          {cover.type === 'video' ? <video src={cover.url} muted preload="metadata" /> : <img src={cover.url} alt="" loading="lazy" />}
          {pictures.length > 1 && <span className="post-quote-more">+{pictures.length - 1}</span>}
        </span>
      )}
      {post.media?.type === 'audio' && <span className="post-quote-note">Аудио: {post.media.name ?? 'запись'}</span>}
      {post.shared?.kind === 'quote' && <span className="post-quote-note">Цитирует другую запись</span>}
    </>
  );
  return link ? (
    <Link className="post-quote" to={`/p/${post.id}`}>
      {inner}
    </Link>
  ) : (
    <div className="post-quote">{inner}</div>
  );
}

/** «Цитировать»: свой текст над чужой записью. Без текста цитата — это репост, для него есть своя кнопка. */
export function QuoteDialog({ post, onClose, onPublished }: { post: Post; onClose: () => void; onPublished: (quote: Post) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const left = QUOTE_LIMIT - text.length;
  const titleId = `quote-${post.id}-title`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.showModal();
    const onNativeClose = () => close.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  async function submit() {
    const body = text.trim();
    if (!body || left < 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createPost(body, null, post.id);
      onPublished(res.post);
      ref.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось опубликовать');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      className="sheet quote-sheet"
      ref={ref}
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === ref.current) ref.current.close();
      }}
    >
      <h2 className="sheet-title" id={titleId}>
        Цитировать запись
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor={`quote-${post.id}`}>
          Ваш текст к цитате
        </label>
        <textarea
          id={`quote-${post.id}`}
          rows={3}
          autoFocus
          value={text}
          placeholder="Что вы об этом думаете?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <QuoteCard post={post} link={false} />
        {error && <p className="error">{error}</p>}
        <div className="sheet-foot">
          {left <= 60 && <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>}
          <button className="btn ghost" type="button" disabled={busy} onClick={() => ref.current?.close()}>
            Отмена
          </button>
          <button className="btn" type="submit" disabled={busy || !text.trim() || left < 0}>
            {busy ? 'Публикую…' : 'Опубликовать'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

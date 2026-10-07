import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Post } from '../api';
import { QuoteCard } from './PostShare';

const LIMIT = 500;

/**
 * «Продолжить» — следующая запись своей ветки. Над полем — то, что
 * продолжаем, чтобы мысль не оборвалась на полуслове. Только текст: ветка —
 * это рассказ частями, снимки к нему — в обычной записи.
 */
export function ContinueDialog({ post, onClose, onPublished }: { post: Post; onClose: () => void; onPublished: (next: Post) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const left = LIMIT - text.length;
  const titleId = `continue-${post.id}-title`;

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
      const res = await api.createPost(body, null, null, post.id);
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
        Продолжить ветку
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <QuoteCard post={post} link={false} />
        <label className="sr-only" htmlFor={`continue-${post.id}`}>
          Следующая запись ветки
        </label>
        <textarea
          id={`continue-${post.id}`}
          rows={3}
          autoFocus
          value={text}
          placeholder="Что дальше?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
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

import { useState } from 'react';
import { api, ApiError, type Post } from '../api';
import { useSession } from '../session';
import { Monogram } from './Monogram';

const LIMIT = 500;

export function Composer({ onPublished }: { onPublished: (post: Post) => void }) {
  const { user } = useSession();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!user) return null;

  const left = LIMIT - text.length;
  const canSend = text.trim().length > 0 && left >= 0 && !sending;

  async function publish() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const { post } = await api.createPost(text.trim());
      setText('');
      onPublished(post);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось опубликовать');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rail-row composer">
      <Monogram username={user.username} displayName={user.displayName} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void publish();
        }}
      >
        <label className="sr-only" htmlFor="composer">
          Новый пост
        </label>
        <textarea
          id="composer"
          rows={2}
          value={text}
          placeholder="Что вы хотите записать?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void publish();
            }
          }}
        />
        {error && <p className="error" style={{ marginTop: '0.75rem' }}>{error}</p>}
        <div className="composer-foot">
          {left <= 100 && (
            <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>
          )}
          <button className="btn" type="submit" disabled={!canSend}>
            {sending ? 'Публикую…' : 'Опубликовать'}
          </button>
        </div>
      </form>
    </div>
  );
}

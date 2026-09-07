import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type MediaKind, type Post } from '../api';
import { useSession } from '../session';
import { Monogram } from './Monogram';

const LIMIT = 500;
const MAX_BYTES = 40 * 1024 * 1024;

const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,audio/mpeg,audio/ogg,audio/wav';

function kindOf(file: File): MediaKind | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

function Clip() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M10.5 4.5 5.7 9.3a1.7 1.7 0 0 0 2.4 2.4l5-5a3.2 3.2 0 0 0-4.5-4.5l-5 5a4.7 4.7 0 0 0 6.6 6.6l4.3-4.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Composer({ onPublished }: { onPublished: (post: Post) => void }) {
  const { user } = useSession();
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The object URL is a live handle to the file; letting it pile up leaks memory.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (!user) return null;

  const left = LIMIT - text.length;
  const kind = file ? kindOf(file) : null;
  // A post needs text or a file — not necessarily both.
  const canSend = (text.trim().length > 0 || Boolean(file)) && left >= 0 && !sending;

  function pick(selected: File | null) {
    setError(null);
    if (!selected) return;

    if (!kindOf(selected)) {
      setError('Такой формат не поддерживается. Можно jpg, png, gif, webp, mp4, webm, mp3, ogg, wav.');
      return;
    }
    if (selected.size > MAX_BYTES) {
      setError(`Файл ${mb(selected.size)} — это больше предела в ${mb(MAX_BYTES)}.`);
      return;
    }
    setFile(selected);
  }

  function clearFile() {
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function publish() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const { post } = await api.createPost(text.trim(), file);
      setText('');
      clearFile();
      onPublished(post);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось опубликовать');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rail-row composer">
      <Monogram username={user.username} displayName={user.displayName} avatarUrl={user.avatarUrl} />
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

        {file && previewUrl && (
          <div className="attach-preview">
            {kind === 'image' && <img src={previewUrl} alt="" />}
            {kind === 'video' && <video src={previewUrl} controls preload="metadata" />}
            {kind === 'audio' && <audio src={previewUrl} controls preload="metadata" />}

            <div className="attach-info">
              <span className="attach-name">{file.name}</span>
              <span className="attach-size">{mb(file.size)}</span>
              <button className="post-delete" type="button" onClick={clearFile}>
                Убрать
              </button>
            </div>
          </div>
        )}

        {error && <p className="error" style={{ marginTop: '0.75rem' }}>{error}</p>}

        <div className="composer-foot">
          <input
            ref={fileInput}
            className="sr-only"
            id="composer-file"
            type="file"
            accept={ACCEPT}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
          <button
            className="act attach-btn"
            type="button"
            onClick={() => fileInput.current?.click()}
            title="Фото, видео или аудио"
          >
            <Clip />
            <span className="sr-only">Прикрепить файл</span>
          </button>

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

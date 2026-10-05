import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type MediaKind, type Post } from '../api';
import { useSession } from '../session';
import { Monogram } from './Monogram';

const LIMIT = 500;
const MAX_BYTES = 40 * 1024 * 1024;
/** Фото и видео в записи — до десяти; аудио — одно и отдельно. */
const FILES_MAX = 10;

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
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The object URL is a live handle to the file; letting it pile up leaks memory.
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  if (!user) return null;

  const left = LIMIT - text.length;
  // A post needs text or a file — not necessarily both.
  const canSend = (text.trim().length > 0 || files.length > 0) && left >= 0 && !sending;

  /** Добавить файлы: до десяти фото и видео — галереей; аудио — только одно и само по себе. */
  function pick(selected: FileList | null) {
    setError(null);
    const list = [...(selected ?? [])];
    if (list.length === 0) return;
    const bad = list.find((f) => !kindOf(f));
    if (bad) {
      setError('Такой формат не поддерживается. Можно jpg, png, gif, webp, mp4, webm, mp3, ogg, wav.');
      return;
    }
    const big = list.find((f) => f.size > MAX_BYTES);
    if (big) {
      setError(`Файл ${mb(big.size)} — это больше предела в ${mb(MAX_BYTES)}.`);
      return;
    }
    const next = [...files, ...list];
    if (next.length > 1 && next.some((f) => kindOf(f) === 'audio')) {
      setError('Аудио публикуется отдельно — одно, без фото и видео.');
      return;
    }
    if (next.length > FILES_MAX) setError(`В записи не больше ${FILES_MAX} фото и видео — лишние не добавлены.`);
    setFiles(next.slice(0, FILES_MAX));
    if (fileInput.current) fileInput.current.value = '';
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function clearFile() {
    setFiles([]);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function publish() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const { post } = await api.createPost(text.trim(), files);
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

        {files.length === 1 && previews[0] && (
          <div className="attach-preview">
            {kindOf(files[0]) === 'image' && <img src={previews[0]} alt="" />}
            {kindOf(files[0]) === 'video' && <video src={previews[0]} controls preload="metadata" />}
            {kindOf(files[0]) === 'audio' && <audio src={previews[0]} controls preload="metadata" />}

            <div className="attach-info">
              <span className="attach-name">{files[0].name}</span>
              <span className="attach-size">{mb(files[0].size)}</span>
              <button className="post-delete" type="button" onClick={clearFile}>
                Убрать
              </button>
            </div>
          </div>
        )}
        {files.length > 1 && (
          <div className="attach-preview">
            <ul className="attach-grid">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  {kindOf(f) === 'video' ? <video src={previews[i]} muted preload="metadata" /> : <img src={previews[i]} alt="" />}
                  <button className="attach-remove" type="button" aria-label={`Убрать ${f.name}`} onClick={() => removeFile(i)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="attach-info">
              <span className="attach-name">
                Галерея: {files.length} из {FILES_MAX}
              </span>
              <button className="post-delete" type="button" onClick={clearFile}>
                Убрать все
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
            multiple
            onChange={(e) => pick(e.target.files)}
          />
          <button
            className="act attach-btn"
            type="button"
            onClick={() => fileInput.current?.click()}
            title="Фото и видео (до десяти) или аудио"
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

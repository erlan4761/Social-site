import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { type Media } from '../api';
import { plural } from '../time';

/**
 * Несколько снимков записи — сеткой, как альбом в Телеграме: два — пополам,
 * три — один большой и два малых, четыре — квадратом, больше — в три колонки.
 * Нажатие открывает просмотр с листанием: стрелки, ← → и свайп.
 */
export function PostGallery({ items }: { items: Media[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const n = items.length;
  const layout = n <= 4 ? `n${n}` : 'many';
  return (
    <>
      <div className={`post-gallery ${layout}`} role="group" aria-label={`${n} ${plural(n, 'снимок', 'снимка', 'снимков')}`}>
        {items.map((m, i) => (
          <button
            key={m.url}
            className="post-gallery-cell"
            type="button"
            aria-label={`Открыть ${i + 1} из ${n}${m.type === 'video' ? ', видео' : ''}`}
            onClick={() => setOpen(i)}
          >
            {m.type === 'video' ? (
              <>
                <video src={m.url} preload="metadata" muted playsInline />
                <span className="post-gallery-play" aria-hidden="true" />
              </>
            ) : (
              <img src={m.url} alt={m.name ?? ''} loading="lazy" />
            )}
          </button>
        ))}
      </div>
      {open != null && <GalleryViewer items={items} start={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Просмотр во весь экран с листанием. Щелчок мимо снимка или Esc — закрыть. */
export function GalleryViewer({ items, start, onClose }: { items: Media[]; start: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [at, setAt] = useState(start);
  const swipe = useRef<number | null>(null);
  // Свайп, кончившийся мимо снимка, браузер считает щелчком по фону — не закрываем.
  const swiped = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const n = items.length;
  const go = (step: number) => setAt((i) => (i + step + n) % n);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.showModal();
    const onNativeClose = () => close.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  const item = items[at];
  return (
    <dialog
      className="viewer gallery-viewer"
      ref={ref}
      aria-label={`Снимок ${at + 1} из ${n}`}
      onClick={(e) => {
        if (swiped.current) swiped.current = false;
        else if (e.target === ref.current) ref.current.close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') go(1);
        if (e.key === 'ArrowLeft') go(-1);
      }}
      onPointerDown={(e: ReactPointerEvent) => {
        swipe.current = e.clientX;
      }}
      onPointerUp={(e: ReactPointerEvent) => {
        const from = swipe.current;
        swipe.current = null;
        if (from == null) return;
        const dx = e.clientX - from;
        swiped.current = Math.abs(dx) > 50;
        if (swiped.current) go(dx < 0 ? 1 : -1);
      }}
    >
      {item.type === 'video' ? (
        <video key={item.url} src={item.url} controls autoPlay playsInline />
      ) : (
        <img key={item.url} src={item.url} alt={item.name ?? ''} />
      )}
      <a className="viewer-open" href={item.url} target="_blank" rel="noreferrer">
        Открыть оригинал
      </a>
      {n > 1 && (
        <>
          <button className="viewer-nav prev" type="button" aria-label="Предыдущий снимок" onClick={() => go(-1)}>
            ‹
          </button>
          <button className="viewer-nav next" type="button" aria-label="Следующий снимок" onClick={() => go(1)}>
            ›
          </button>
          <p className="viewer-count" aria-live="polite">
            {at + 1} из {n}
          </p>
        </>
      )}
    </dialog>
  );
}

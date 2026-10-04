import { useEffect, useRef, useState } from 'react';
import { type Attachment } from '../../api';
import { VIDEO_NOTE_MAX_S, mmss } from '../../voice';
import { rateLabel, useVoiceRate } from '../../voiceRate';
import { Icon } from '../Icon';
import { fileSize } from './format';

/* ─ Вложения в ленте ────────────────────────────────────────────────────
   Фото, видео, голосовые, «кружки», файлы — и просмотр фото во весь экран. */

/** Кнопка скорости «1× → 1,5× → 2×» — у голосового и у «кружка» со звуком. */
function RateButton({ rate, onNext, className }: { rate: number; onNext: () => void; className: string }) {
  return (
    <button
      className={className}
      type="button"
      title="Скорость воспроизведения"
      aria-label={`Скорость ${rateLabel(rate)} — сменить`}
      onClick={(e) => {
        // Внутри «кружка» нажатие не должно ставить его на паузу.
        e.stopPropagation();
        onNext();
      }}
    >
      {rateLabel(rate)}
    </button>
  );
}

/** Скорость на элементе: `defaultPlaybackRate` — чтобы загрузка файла её не сбросила. */
function applyRate(el: HTMLMediaElement | null, rate: number) {
  if (!el) return;
  el.defaultPlaybackRate = rate;
  el.playbackRate = rate;
}

/**
 * Плеер голосового: кнопка, «волна» и время — как в Телеграме. Сыгранная
 * часть волны закрашена; по волне можно щёлкнуть и перемотать. Пока слушают —
 * рядом со временем кнопка скорости; голос при ускорении не «пищит»: браузер
 * сохраняет высоту тона (preservesPitch по умолчанию).
 */
function VoicePlayer({ a }: { a: Attachment }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, nextRate] = useVoiceRate();
  useEffect(() => applyRate(audio.current, rate), [rate]);
  const [at, setAt] = useState(0);
  const total = a.duration ?? 0;
  const bars = (a.wave ?? '').split('').map(Number);
  const shown = bars.length > 0 ? bars : Array<number>(32).fill(2);
  const progress = total > 0 ? Math.min(1, at / total) : 0;

  function toggle() {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }

  return (
    <div className="voice">
      <button className="voice-play" type="button" onClick={toggle} aria-label={playing ? 'Пауза' : 'Слушать голосовое'}>
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.4v11.2a.8.8 0 0 0 1.2.7l9.3-5.6a.8.8 0 0 0 0-1.4L5.2 1.7A.8.8 0 0 0 4 2.4z" fill="currentColor" /></svg>
        )}
      </button>
      <span className="voice-body">
        <span
          className="voice-wave"
          role="slider"
          aria-label="Перемотка"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={Math.round(at)}
          tabIndex={0}
          onClick={(e) => {
            const el = audio.current;
            if (!el || !total) return;
            const r = e.currentTarget.getBoundingClientRect();
            el.currentTime = ((e.clientX - r.left) / r.width) * total;
          }}
          onKeyDown={(e) => {
            const el = audio.current;
            if (!el) return;
            if (e.key === 'ArrowRight') el.currentTime = Math.min(total, el.currentTime + 5);
            if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5);
          }}
        >
          {shown.map((h, i) => (
            <span
              key={i}
              className={i / shown.length < progress ? 'played' : undefined}
              style={{ height: `${3 + h * 2}px` }}
            />
          ))}
        </span>
        <span className="voice-foot">
          <span className="voice-time">{mmss(playing || at > 0 ? at : total)}</span>
          {(playing || at > 0) && <RateButton className="voice-rate" rate={rate} onNext={nextRate} />}
        </span>
      </span>
      <audio
        ref={audio}
        src={a.url}
        preload="none"
        onPlay={(e) => {
          applyRate(e.currentTarget, rate);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
    </div>
  );
}

/** Кольцо прогресса вокруг «кружка»: у записи — сколько из минуты, у плеера — сколько проиграно. */
function Ring({ progress }: { progress: number }) {
  const r = 48;
  const length = 2 * Math.PI * r;
  return (
    <svg className="note-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r={r} className="note-ring-track" />
      <circle
        cx="50"
        cy="50"
        r={r}
        className="note-ring-bar"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - Math.min(1, Math.max(0, progress)))}
      />
    </svg>
  );
}

/** Живой предпросмотр записи — зеркально, как в зеркале, и с кольцом прогресса. */
export function VideoNotePreview({ stream, elapsed }: { stream: MediaStream; elapsed: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="note-preview" aria-hidden="true">
      <div className="note-circle">
        <video ref={ref} autoPlay muted playsInline />
        <Ring progress={elapsed / VIDEO_NOTE_MAX_S} />
      </div>
    </div>
  );
}

/**
 * «Кружок» в ленте. Пока его видно, он беззвучно крутится по кругу, как в
 * Телеграме; нажатие — сначала и со звуком, кольцо показывает, сколько
 * проиграно; ещё нажатие — пауза. Ушёл с экрана — останавливается.
 */
function VideoNote({ a, onMediaLoad }: { a: Attachment; onMediaLoad: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [loud, setLoud] = useState(false);
  const [rate, nextRate] = useVoiceRate();
  // Беззвучный круг крутится как есть; скорость — только когда смотрят со звуком.
  useEffect(() => applyRate(ref.current, loud ? rate : 1), [loud, rate]);
  const [progress, setProgress] = useState(0);
  const [at, setAt] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void el.play().catch(() => undefined);
      else el.pause();
    }, { threshold: 0.5 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function toggle() {
    const el = ref.current;
    if (!el) return;
    if (!loud) {
      el.muted = false;
      el.loop = false;
      el.currentTime = 0;
      applyRate(el, rate);
      void el.play().catch(() => undefined);
      setLoud(true);
    } else if (el.paused) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }

  return (
    <span className="note-wrap">
    <button
      className={loud ? 'note-circle note-bubble loud' : 'note-circle note-bubble'}
      type="button"
      onClick={toggle}
      aria-label={loud ? 'Пауза или продолжить видеосообщение' : 'Смотреть видеосообщение со звуком'}
    >
      <video
        ref={ref}
        src={a.url}
        muted
        loop
        playsInline
        preload="metadata"
        onLoadedMetadata={onMediaLoad}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setAt(el.currentTime);
          if (!el.muted) setProgress(el.duration ? el.currentTime / el.duration : 0);
        }}
        onEnded={(e) => {
          // Досмотрели со звуком — обратно в беззвучный круг, как было.
          const el = e.currentTarget;
          el.muted = true;
          el.loop = true;
          applyRate(el, 1);
          setLoud(false);
          setProgress(0);
          void el.play().catch(() => undefined);
        }}
      />
      {loud && <Ring progress={progress} />}
      <span className="note-time">{mmss(loud ? at : a.duration ?? 0)}</span>
      {!loud && (
        <span className="note-muted" aria-hidden="true">
          <Icon name="volume-off" size={12} />
        </span>
      )}
    </button>
    {loud && <RateButton className="note-rate" rate={rate} onNext={nextRate} />}
    </span>
  );
}

type ViewProps = { a: Attachment; onMediaLoad: () => void; onOpenImage: (url: string, alt: string) => void };

export function AttachmentView({ a, onMediaLoad, onOpenImage }: ViewProps) {
  switch (a.kind) {
    case 'image':
      return (
        <button className="att-image" type="button" onClick={() => onOpenImage(a.url, a.name ?? 'Фото')} aria-label="Открыть фото">
          <img src={a.url} alt={a.name ?? 'Фото'} loading="lazy" onLoad={onMediaLoad} />
        </button>
      );
    case 'video':
      return <video className="att-video" src={a.url} controls preload="metadata" playsInline onLoadedMetadata={onMediaLoad} />;
    case 'voice':
      return <VoicePlayer a={a} />;
    case 'videonote':
      return <VideoNote a={a} onMediaLoad={onMediaLoad} />;
    case 'audio':
      return (
        <div className="att-audio">
          <span className="att-audio-name">
            <Icon name="music" size={18} />
            {a.name ?? 'Аудио'}
          </span>
          <audio src={a.url} controls preload="none" />
        </div>
      );
    case 'file':
      return (
        <a className="att-file" href={a.url} download={a.name ?? undefined}>
          <span className="att-file-icon">
            <Icon name="file" size={22} />
          </span>
          <span className="att-file-text">
            <span className="att-file-name">{a.name ?? 'Файл'}</span>
            <span className="att-file-size">{fileSize(a.size)}</span>
          </span>
        </a>
      );
  }
}

/** Фото во весь экран. Нативный `<dialog>`: Esc и возврат фокуса — от
 *  платформы. Щелчок куда угодно закрывает, как в Телеграме. */
export function ImageViewer({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.showModal();
    const onNativeClose = () => close.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  return (
    <dialog className="viewer" ref={ref} onClick={() => ref.current?.close()} aria-label={alt}>
      <img src={url} alt={alt} />
      <a className="viewer-open" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        Открыть оригинал
      </a>
    </dialog>
  );
}

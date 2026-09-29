import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  REACTIONS, type Attachment, type AttachmentInput, type Author, type ConversationHit, type ForwardedFrom,
  type PinnedPreview, type Poll, type Quote,
  type Reaction,
} from '../api';
import { clockTime, dayKey, dayLabel, fullDate, isOnline, plural } from '../time';
import { highlight, searchTerms } from '../highlight';
import { VIDEO_NOTE_MAX_S, canRecord, mmss, useRecorder } from '../voice';
import { Icon } from './Icon';
import { Monogram } from './Monogram';
import { useSession } from '../session';
import { ScheduleDialog } from './Scheduled';

/* ─ Вложения ───────────────────────────────────────────────────────────── */

/** Подпись вложения там, где его самого не видно: список чатов, полоса ответа. */
export function attachmentLabel(a: Pick<Attachment, 'kind' | 'name'> | null | undefined) {
  if (!a) return '';
  switch (a.kind) {
    case 'image': return 'Фото';
    case 'video': return 'Видео';
    case 'voice': return 'Голосовое сообщение';
    case 'videonote': return 'Видеосообщение';
    case 'audio': return a.name || 'Аудио';
    case 'file': return a.name || 'Файл';
  }
}

/** Превью сообщения в одну строку: текст, а без него — что приложено. */
export const previewText = (body: string, a: Attachment | null) =>
  body ? oneLine(body) : attachmentLabel(a);

/** `1536` → `1,5 КБ`. */
export function fileSize(bytes: number | null) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

/**
 * Плеер голосового: кнопка, «волна» и время — как в Телеграме. Сыгранная
 * часть волны закрашена; по волне можно щёлкнуть и перемотать.
 */
function VoicePlayer({ a }: { a: Attachment }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
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
        <span className="voice-time">{mmss(playing || at > 0 ? at : total)}</span>
      </span>
      <audio
        ref={audio}
        src={a.url}
        preload="none"
        onPlay={() => setPlaying(true)}
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
function VideoNotePreview({ stream, elapsed }: { stream: MediaStream; elapsed: number }) {
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
      void el.play().catch(() => undefined);
      setLoud(true);
    } else if (el.paused) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }

  return (
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
  );
}

type ViewProps = { a: Attachment; onMediaLoad: () => void; onOpenImage: (url: string, alt: string) => void };

function AttachmentView({ a, onMediaLoad, onOpenImage }: ViewProps) {
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

/**
 * Детали мессенджера, общие для личной переписки и группового чата: у них
 * разные API и разные шапки, но лента сообщений, пузырь, меню действий и поле
 * ввода одни.
 */

/* ─ Аватар с отметкой «в сети» ─────────────────────────────────────────── */

type PresenceProps = {
  person: Author & { lastSeenAt?: string | null };
  size?: 'sm' | 'md';
};

/** Точка — только украшение: словами «в сети» говорит шапка переписки, а в
 *  списке чатов — скрытая подпись рядом с именем. */
export function PresenceAvatar({ person, size = 'md' }: PresenceProps) {
  return (
    <span className={size === 'sm' ? 'presence sm' : 'presence'}>
      <Monogram
        username={person.username}
        displayName={person.displayName}
        avatarUrl={person.avatarUrl}
        size={size === 'sm' ? 'sm' : undefined}
      />
      {isOnline(person.lastSeenAt) && <span className="presence-dot" aria-hidden="true" />}
    </span>
  );
}

/* ─ Галочки ───────────────────────────────────────────────────────────── */

export type Delivery = 'sent' | 'read';

/** Одна галочка — сообщение на сервере, две — его прочитали. Рисуются своим
 *  svg, а не парой иконок `check`: вторая галочка должна заходить на первую. */
export function Ticks({ status }: { status: Delivery }) {
  return (
    <span className={status === 'read' ? 'ticks read' : 'ticks'}>
      <svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {status === 'read' ? (
          <>
            <path d="m1.2 5.8 3.1 3.1L10.6 2" />
            <path d="m7.6 8.1.8.8L14.8 2" />
          </>
        ) : (
          <path d="m3.6 5.8 3.1 3.1L13 2" />
        )}
      </svg>
      <span className="sr-only">{status === 'read' ? 'прочитано' : 'отправлено'}</span>
    </span>
  );
}

/* ─ «Печатает…» ───────────────────────────────────────────────────────── */

/** Три точки, которые дышат по очереди. Под reduced-motion замирают — текст
 *  «печатает» рядом говорит то же самое без движения. */
export function TypingDots() {
  return (
    <span className="typing-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/** Подпись для группы: «Мия печатает», «Мия и Лев печатают», «3 человека печатают». */
export function typingLabel(names: string[]) {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} печатает`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают`;
  return `${names.length} человека печатают`;
}

/* ─ Лента сообщений ────────────────────────────────────────────────────── */

export type BubbleItem = {
  id: number;
  body: string;
  createdAt: string;
  mine: boolean;
  /** Автор — только в групповом чате: в личной переписке он и так понятен. */
  author?: Author;
  /** Только у своих сообщений. */
  status?: Delivery;
  editedAt: string | null;
  forwardedFrom: ForwardedFrom | null;
  replyTo: Quote | null;
  reactions: Reaction[];
  attachment: Attachment | null;
  canEdit: boolean;
  canDelete: boolean;
  /** Только у публикаций канала: сколько людей видели. */
  views?: number;
  /** Публикация канала: куда ведёт строка «N комментариев». */
  commentsTo?: string;
  commentCount?: number;
  /** Опрос: вопрос — `body`, варианты и голоса — здесь. */
  poll?: Poll | null;
};

/** Какие действия есть в меню. У публикации канала нет «Ответить», у
 *  комментария — ни реакций, ни пересылки. */
export type ListActions = { reply?: boolean; react?: boolean; forward?: boolean; pin?: boolean };
/** Закреплять вправе не все (в группе и канале — владелец), поэтому «pin»
 *  включается явно, а остальное есть по умолчанию. */
const ALL_ACTIONS: Required<ListActions> = { reply: true, react: true, forward: true, pin: false };

export type MessageAction =
  | { type: 'reply' }
  | { type: 'edit' }
  | { type: 'delete' }
  | { type: 'forward' }
  | { type: 'copy' }
  | { type: 'pin' }
  | { type: 'react'; emoji: string | null }
  | { type: 'vote'; options: number[] }
  | { type: 'closePoll' };

/** Реплики одного человека подряд и без долгой паузы собираются в серию:
 *  внутри неё пузыри жмутся друг к другу, а имя автора стоит один раз. */
const RUN_GAP_MS = 5 * 60_000;

function sameRun(a: BubbleItem | undefined, b: BubbleItem | undefined) {
  if (!a || !b) return false;
  return (
    a.mine === b.mine &&
    a.author?.id === b.author?.id &&
    dayKey(a.createdAt) === dayKey(b.createdAt) &&
    Math.abs(Date.parse(b.createdAt) - Date.parse(a.createdAt)) < RUN_GAP_MS
  );
}

/**
 * Свежая страница опроса поверх уже загруженного. Страница — последние N
 * сообщений подряд, поэтому всё, что в состоянии не старше её первого id,
 * заменяется ею целиком: так приходят не только новые сообщения, но и правки,
 * реакции, галочки, а удалённые — исчезают. Что старше окна, остаётся как было
 * до следующего открытия переписки: правка сообщения недельной давности не
 * стоит того, чтобы опрашивать всю историю.
 */
export function mergeLatest<T extends { id: number }>(prev: T[], page: T[]): T[] {
  // Пустая страница — в переписке не осталось ни одного сообщения.
  if (page.length === 0) return [];
  const first = page[0].id;
  return [...prev.filter((m) => m.id < first), ...page];
}

/** Насколько близко к низу считается «внизу»: чуть прокрученный вверх
 *  человек всё ещё ждёт, что новый ответ появится у него перед глазами. */
const BOTTOM_SLACK = 96;
/** За сколько пикселей до верха подгружать более старые. */
const TOP_PRELOAD = 160;
/** Долгое нажатие на сенсорном экране — как в мобильном Телеграме. */
const LONG_PRESS_MS = 450;

type ListProps = {
  items: BubbleItem[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
  empty: ReactNode;
  onAction: (action: MessageAction, item: BubbleItem) => void;
  /** Отвечать и реагировать нельзя — например, при блокировке. */
  readOnly?: boolean;
  actions?: ListActions;
  /** Канал: публикации шире и без хвостов «своё/чужое». */
  variant?: 'chat' | 'channel';
  /** Какое сообщение закреплено — в меню у него «Открепить». */
  pinnedId?: number | null;
  /** Команда страницы «покажи это сообщение»: новое seq — новый переход. */
  jump?: { id: number; seq: number } | null;
};

type MenuState = { item: BubbleItem; x: number; y: number } | null;

/**
 * Лента со своей прокруткой. Родитель обязан пересоздавать её для каждой
 * переписки (`key`), иначе смена чата выглядела бы как «пришло 30 новых
 * сообщений» и прокрутка вела бы себя по правилам дозагрузки.
 */
/* ─ Опрос ──────────────────────────────────────────────────────────────
   Как в Телеграме: пока не проголосовал — варианты кнопками (при нескольких
   ответах — флажки и «Голосовать»), после — проценты полосами, свой выбор
   отмечен галочкой. Решает сервер: votes === null значит «результаты скрыты». */

type PollCardProps = {
  question: string;
  poll: Poll;
  readOnly: boolean;
  onVote: (options: number[]) => void;
  onClose: () => void;
};

function PollCard({ question, poll, readOnly, onVote, onClose }: PollCardProps) {
  const [picked, setPicked] = useState<number[]>([]);
  // Автору итоги видны и без голоса, но голосует он, как все: итоги — по кнопке.
  const [peek, setPeek] = useState(false);
  const voted = poll.myVotes.length > 0;
  const resultsOpen = poll.options.some((o) => o.votes != null);
  const canVote = !poll.closed && !voted && !readOnly;
  const showResults = !canVote || peek;
  const kind = poll.closed
    ? 'Опрос завершён'
    : [poll.anonymous ? 'Анонимный опрос' : 'Открытый опрос', poll.multiple ? 'несколько ответов' : null]
      .filter(Boolean)
      .join(', ');
  const top = Math.max(0, ...poll.options.map((o) => o.votes ?? 0));

  return (
    <div className="poll" role="group" aria-label={`Опрос: ${question}`}>
      <p className="poll-question">{question}</p>
      <p className="poll-kind">{kind}</p>

      {!showResults ? (
        <ul className="poll-options">
          {poll.options.map((o) => (
            <li key={o.id}>
              {poll.multiple ? (
                <label className="poll-choice">
                  <input
                    type="checkbox"
                    checked={picked.includes(o.id)}
                    onChange={(e) =>
                      setPicked((prev) => (e.target.checked ? [...prev, o.id] : prev.filter((x) => x !== o.id)))
                    }
                  />
                  {o.text}
                </label>
              ) : (
                <button className="poll-choice" type="button" onClick={() => onVote([o.id])}>
                  <span className="poll-radio" aria-hidden="true" />
                  {o.text}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="poll-results">
          {poll.options.map((o) => {
            const votes = o.votes ?? 0;
            const share = poll.total > 0 ? Math.round((votes / poll.total) * 100) : 0;
            const mine = poll.myVotes.includes(o.id);
            return (
              <li key={o.id} className={votes === top && votes > 0 && poll.closed ? 'poll-row lead' : 'poll-row'}>
                <span className="poll-row-head">
                  <span className="poll-share">{o.votes == null ? '' : `${share}%`}</span>
                  <span className="poll-text">
                    {o.text}
                    {mine && (
                      <span className="poll-mine" title="Ваш выбор">
                        <Icon name="check" size={14} />
                        <span className="sr-only"> — ваш выбор</span>
                      </span>
                    )}
                  </span>
                  {o.voters.length > 0 && (
                    <span className="poll-voters" title={o.voters.map((v) => v.displayName).join(', ')}>
                      {o.voters.slice(0, 3).map((v) => (
                        <Monogram key={v.id} username={v.username} displayName={v.displayName} avatarUrl={v.avatarUrl} size="sm" />
                      ))}
                    </span>
                  )}
                </span>
                <span className="poll-bar" aria-hidden="true">
                  <span style={{ width: `${o.votes == null ? 0 : share}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="poll-foot">
        <span className="poll-total">
          {poll.total === 0 ? 'Пока никто не голосовал' : `${poll.total} ${plural(poll.total, 'голос', 'голоса', 'голосов')}`}
        </span>
        {canVote && poll.multiple && !showResults && (
          <button className="btn small" type="button" disabled={picked.length === 0} onClick={() => onVote(picked)}>
            Голосовать
          </button>
        )}
        {canVote && resultsOpen && (
          <button className="btn link" type="button" aria-pressed={peek} onClick={() => setPeek((v) => !v)}>
            {peek ? 'К голосованию' : 'Результаты'}
          </button>
        )}
        {voted && !poll.closed && !readOnly && (
          <button className="btn link" type="button" onClick={() => onVote([])}>
            Отменить голос
          </button>
        )}
        {poll.canClose && !readOnly && (
          <button className="btn link" type="button" onClick={onClose}>
            Завершить опрос
          </button>
        )}
      </div>
    </div>
  );
}

/* ─ Упоминания ─────────────────────────────────────────────────────── */

// То же правило, что в mentions.js на сервере: перед «@» — не буква и не
// цифра, так что адрес почты упоминанием не становится.
const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/giu;

/** Текст сообщения, где `@логин` — ссылка на профиль; своё имя — с подсветкой. */
export function MessageText({ text, me }: { text: string; me?: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index + match[1].length;
    const name = match[2];
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <Link
        key={start}
        className={name.toLowerCase() === me ? 'mention me' : 'mention'}
        to={`/u/${name.toLowerCase()}`}
      >
        @{name}
      </Link>,
    );
    last = start + 1 + name.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const fold = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');

/** Что набрано после «@» прямо перед кареткой — или null, если не упоминание. */
function mentionQuery(text: string, caret: number) {
  // После «@» — и кириллица: «@ни» находит Нину по имени, а вставится её логин.
  const match = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]{0,20})$/u.exec(text.slice(0, caret));
  return match ? { q: fold(match[2]), start: caret - match[2].length - 1 } : null;
}

export function MessageList({
  items,
  loading,
  hasMore,
  loadingMore,
  onLoadOlder,
  empty,
  onAction,
  readOnly = false,
  actions,
  variant = 'chat',
  pinnedId = null,
  jump = null,
}: ListProps) {
  const can = { ...ALL_ACTIONS, ...actions };
  const me = useSession().user?.username;
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prev = useRef<{ first?: number; last?: number; height: number }>({ height: 0 });
  const [menu, setMenu] = useState<MenuState>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [viewer, setViewer] = useState<{ url: string; alt: string } | null>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);

  /** Фото догрузилось и выросло — если человек был внизу, он и остаётся внизу. */
  function onMediaLoad() {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }

  // Прокрутка решается до отрисовки кадра, иначе на миг был бы виден скачок.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = items[0]?.id;
    const last = items.at(-1)?.id;
    const was = prev.current;

    if (was.last === undefined) {
      // Первая порция — сразу к последнему сообщению, как открывается любой мессенджер.
      el.scrollTop = el.scrollHeight;
    } else if (first !== was.first && last === was.last) {
      // Подгрузили старые сверху — держим на месте то, что человек читал.
      el.scrollTop += el.scrollHeight - was.height;
    } else if (last !== was.last && (atBottom.current || items.at(-1)?.mine)) {
      // Новое снизу: едем к нему, только если человек и так внизу или это его
      // собственное сообщение. Читающего историю не дёргаем.
      el.scrollTop = el.scrollHeight;
    }

    prev.current = { first, last, height: el.scrollHeight };
  }, [items]);

  // Меню, открытое на сообщении, которое тем временем удалили, закрывается само.
  useEffect(() => {
    if (menu && !items.some((m) => m.id === menu.item.id)) setMenu(null);
  }, [items, menu]);

  function onScroll() {
    const el = box.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (el.scrollTop < TOP_PRELOAD && hasMore && !loadingMore) onLoadOlder();
    if (menu) setMenu(null);
  }

  /** Переход к цитируемому сообщению: оно подсвечивается на мгновение, чтобы
   *  глаз нашёл его среди соседних. Если оно ещё не подгружено — ничего. */
  function jumpTo(id: number) {
    const el = box.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(id);
    window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1400);
  }

  // Переход по команде страницы — к закреплённому или найденному сообщению.
  // Страница сама догружает старые, пока сообщение не окажется в ленте.
  const jumpSeq = jump?.seq;
  useEffect(() => {
    if (jump) jumpTo(jump.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSeq]);

  function openAt(item: BubbleItem, x: number, y: number) {
    setMenu({ item, x, y });
  }

  function startPress(e: ReactPointerEvent, item: BubbleItem) {
    if (e.pointerType !== 'touch') return;
    const { clientX: x, clientY: y } = e;
    press.current = { x, y, timer: window.setTimeout(() => openAt(item, x, y), LONG_PRESS_MS) };
  }

  function movePress(e: ReactPointerEvent) {
    const p = press.current;
    // Палец поехал — это прокрутка, а не долгое нажатие.
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
  }

  function cancelPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  return (
    <div className={variant === 'channel' ? 'msgs channel' : 'msgs'} ref={box} onScroll={onScroll}>
      <div className="msgs-inner">
        {loading ? (
          <p className="msgs-note">Загружаю…</p>
        ) : items.length === 0 ? (
          <div className="msgs-empty">{empty}</div>
        ) : (
          <>
            {hasMore && (
              <div className="msgs-more">
                <button className="btn ghost small" type="button" onClick={onLoadOlder} disabled={loadingMore}>
                  {loadingMore ? 'Загружаю…' : 'Показать более старые'}
                </button>
              </div>
            )}

            {items.map((m, i) => {
              const before = items[i - 1];
              const after = items[i + 1];
              const newDay = !before || dayKey(before.createdAt) !== dayKey(m.createdAt);
              const starts = !sameRun(before, m);
              const ends = !sameRun(m, after);

              const cls = ['bubble'];
              if (m.mine) cls.push('mine');
              if (starts) cls.push('run-start');
              if (ends) cls.push('run-end');
              if (flash === m.id) cls.push('flash');
              if (menu?.item.id === m.id) cls.push('menu-open');
              // «Кружок» без подписи — без пузыря, как в Телеграме: только круг и время.
              if (m.attachment?.kind === 'videonote' && !m.body) cls.push('has-note');

              const meta = (
                <>
                  {m.views != null && (
                    <span className="bubble-views" title="Просмотры">
                      <Icon name="eye" size={14} />
                      {m.views}
                      <span className="sr-only"> просмотров</span>
                    </span>
                  )}
                  {m.editedAt && <span className="bubble-edited" title={fullDate(m.editedAt)}>изменено</span>}
                  <time dateTime={m.createdAt} title={fullDate(m.createdAt)}>
                    {clockTime(m.createdAt)}
                  </time>
                  {m.mine && m.status && <Ticks status={m.status} />}
                </>
              );

              return (
                <div key={m.id} className="bubble-row" data-mid={m.id}>
                  {newDay && (
                    <div className="day-sep" role="separator">
                      <span>{dayLabel(m.createdAt)}</span>
                    </div>
                  )}
                  <div
                    className={cls.join(' ')}
                    onContextMenu={(e) => {
                      // Выделенный текст — значит, человек хочет копировать
                      // сам: системное меню ему нужнее нашего.
                      if (window.getSelection()?.toString()) return;
                      e.preventDefault();
                      openAt(m, e.clientX, e.clientY);
                    }}
                    onPointerDown={(e) => startPress(e, m)}
                    onPointerMove={movePress}
                    onPointerUp={cancelPress}
                    onPointerCancel={cancelPress}
                  >
                    {!m.mine && m.author && starts && (
                      <Link className="bubble-author" to={`/u/${m.author.username}`}>
                        {m.author.displayName}
                      </Link>
                    )}

                    {m.forwardedFrom && (
                      <span className="bubble-forwarded">
                        {m.forwardedFrom.kind === 'channel' ? (
                          <>
                            Переслано из канала{' '}
                            <Link to={`/messages/ch/${m.forwardedFrom.handle}`}>{m.forwardedFrom.title}</Link>
                          </>
                        ) : (
                          <>
                            Переслано от{' '}
                            <Link to={`/u/${m.forwardedFrom.username}`}>{m.forwardedFrom.displayName}</Link>
                          </>
                        )}
                      </span>
                    )}

                    {m.replyTo && (
                      <button
                        className={m.replyTo.deleted ? 'bubble-quote gone' : 'bubble-quote'}
                        type="button"
                        disabled={m.replyTo.deleted}
                        onClick={() => jumpTo(m.replyTo!.id)}
                      >
                        {m.replyTo.deleted ? (
                          <span className="bubble-quote-text">Сообщение удалено</span>
                        ) : (
                          <>
                            <span className="bubble-quote-who">{m.replyTo.author.displayName}</span>
                            <span className="bubble-quote-text">{m.replyTo.body}</span>
                          </>
                        )}
                      </button>
                    )}

                    {m.attachment && (
                      <AttachmentView
                        a={m.attachment}
                        onMediaLoad={onMediaLoad}
                        onOpenImage={(url, alt) => setViewer({ url, alt })}
                      />
                    )}

                    {/* Невидимая копия подписи в конце текста резервирует ей место
                        в последней строке: время встаёт справа внизу, как в
                        Телеграме, и никогда не наезжает на слова. Без текста
                        (фото, голосовое) подпись идёт отдельной строкой. */}
                    {m.poll ? (
                      <>
                        <PollCard
                          question={m.body}
                          poll={m.poll}
                          readOnly={readOnly}
                          onVote={(options) => onAction({ type: 'vote', options }, m)}
                          onClose={() => onAction({ type: 'closePoll' }, m)}
                        />
                        {m.reactions.length === 0 && <span className="bubble-foot" aria-hidden="true" />}
                      </>
                    ) : m.body ? (
                      <p className="bubble-text">
                        <MessageText text={m.body} me={me} />
                        <span className="bubble-meta-space" aria-hidden="true">
                          {meta}
                        </span>
                      </p>
                    ) : (
                      m.reactions.length === 0 && <span className="bubble-foot" aria-hidden="true" />
                    )}

                    {m.reactions.length > 0 && (
                      <div className="reactions">
                        {m.reactions.map((r) => (
                          <button
                            key={r.emoji}
                            className={r.mine ? 'reaction mine' : 'reaction'}
                            type="button"
                            aria-pressed={r.mine}
                            aria-label={`${r.emoji} ${r.count}${r.mine ? ', ваша реакция' : ''}`}
                            disabled={readOnly || !can.react}
                            onClick={() => onAction({ type: 'react', emoji: r.mine ? null : r.emoji }, m)}
                          >
                            <span className="reaction-emoji">{r.emoji}</span>
                            <span className="reaction-count">{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    <span className="bubble-meta">{meta}</span>

                    {/* Комментарии под публикацией канала — отдельной строкой
                        во всю ширину пузыря, как в Телеграме. */}
                    {m.commentsTo && (
                      <Link className="bubble-comments" to={m.commentsTo}>
                        <Icon name="comment" size={18} />
                        {m.commentCount
                          ? `${m.commentCount} ${plural(m.commentCount, 'комментарий', 'комментария', 'комментариев')}`
                          : 'Прокомментировать'}
                        <Icon name="chevron-right" size={16} />
                      </Link>
                    )}

                    {/* Меню с клавиатуры и мышью без правой кнопки. На сенсорных
                        экранах кнопки нет — там долгое нажатие. */}
                    <button
                      className="bubble-more"
                      type="button"
                      aria-label="Действия с сообщением"
                      aria-haspopup="menu"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        openAt(m, m.mine ? r.left : r.right, r.bottom);
                      }}
                    >
                      <Icon name="chevron-down" size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {viewer && <ImageViewer url={viewer.url} alt={viewer.alt} onClose={() => setViewer(null)} />}

      {menu && (
        <MessageMenu
          state={menu}
          readOnly={readOnly}
          can={can}
          pinned={menu.item.id === pinnedId}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            const item = menu.item;
            setMenu(null);
            onAction(action, item);
          }}
        />
      )}
    </div>
  );
}

/* ─ Просмотр фото ──────────────────────────────────────────────────────── */

/** Фото во весь экран. Нативный `<dialog>`: Esc и возврат фокуса — от
 *  платформы. Щелчок куда угодно закрывает, как в Телеграме. */
function ImageViewer({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
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

/* ─ Меню сообщения ─────────────────────────────────────────────────────── */

type MenuProps = {
  state: NonNullable<MenuState>;
  readOnly: boolean;
  can: Required<ListActions>;
  /** Это сообщение закреплено — пункт меню «Открепить». */
  pinned: boolean;
  onClose: () => void;
  onAction: (action: MessageAction) => void;
};

/**
 * Реакции сверху, действия списком — как контекстное меню Телеграма. Встаёт
 * там, где щёлкнули, и отодвигается от краёв окна. Esc и щелчок мимо —
 * закрыть; стрелки ходят по пунктам.
 */
function MessageMenu({ state, readOnly, can, pinned, onClose, onAction }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });
  const { item } = state;
  const mineReaction = item.reactions.find((r) => r.mine)?.emoji ?? null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let left = state.x;
    let top = state.y;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, state.x - width);
    if (top + height > window.innerHeight - pad) top = Math.max(pad, state.y - height);
    setPos({ left, top });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [state.x, state.y]);

  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    all[(at + step + all.length) % all.length]?.focus();
  }

  return (
    <div
      className="msg-menu"
      ref={ref}
      role="menu"
      aria-label="Действия с сообщением"
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
    >
      {!readOnly && can.react && (
        <div className="msg-menu-reactions">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              className={emoji === mineReaction ? 'on' : undefined}
              aria-label={emoji === mineReaction ? `Убрать реакцию ${emoji}` : `Реакция ${emoji}`}
              onClick={() => onAction({ type: 'react', emoji: emoji === mineReaction ? null : emoji })}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      <div className="msg-menu-list">
        {!readOnly && can.reply && (
          <MenuItem icon="reply" onClick={() => onAction({ type: 'reply' })}>
            Ответить
          </MenuItem>
        )}
        {item.body && (
          <MenuItem icon="copy" onClick={() => onAction({ type: 'copy' })}>
            Копировать текст
          </MenuItem>
        )}
        {can.forward && !item.poll && (
          <MenuItem icon="forward" onClick={() => onAction({ type: 'forward' })}>
            Переслать
          </MenuItem>
        )}
        {can.pin && !readOnly && (
          <MenuItem icon="pin" onClick={() => onAction({ type: 'pin' })}>
            {pinned ? 'Открепить' : 'Закрепить'}
          </MenuItem>
        )}
        {item.canEdit && !readOnly && (
          <MenuItem icon="edit" onClick={() => onAction({ type: 'edit' })}>
            Изменить
          </MenuItem>
        )}
        {item.canDelete && (
          <MenuItem icon="trash" danger onClick={() => onAction({ type: 'delete' })}>
            Удалить
          </MenuItem>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  danger = false,
  onClick,
  children,
}: {
  icon: 'reply' | 'copy' | 'forward' | 'edit' | 'trash' | 'pin';
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" className={danger ? 'msg-menu-item danger' : 'msg-menu-item'} onClick={onClick}>
      <Icon name={icon} size={18} />
      {children}
    </button>
  );
}

/* ─ Поле ввода ─────────────────────────────────────────────────────────── */

const LIMIT = 1000;
/** Счётчик символов появляется, только когда до потолка осталось немного. */
const COUNTER_FROM = 120;
/** «Печатает…» уходит на сервер не чаще, чем раз в столько: сервер держит
 *  отметку шесть секунд, и трёх хватает, чтобы она не мигала. */
const TYPING_EVERY_MS = 3_000;

/** На сенсорных экранах Enter — перевод строки, как в мобильном Телеграме:
 *  отправка там — кнопкой, а случайная отправка недописанного обидна. */
const touch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/** Над полем — полоса «ответ на …» или «редактирование». */
export type ComposerMode =
  | { kind: 'reply'; id: number; who: string; body: string }
  | { kind: 'edit'; id: number; body: string }
  | null;

/** Потолок вложения — как у сервера: больше он всё равно не примет. */
const FILE_MAX = 40 * 1024 * 1024;
/** Что предлагает окно выбора файла. Решает всё равно сервер — по содержимому. */
const ACCEPT = 'image/*,video/*,audio/*,.pdf,.zip,.docx,.xlsx,.pptx';

type ComposerProps = {
  placeholder: string;
  /** Отправка или сохранение правки. `true` — готово, поле очищается;
   *  `false` — ошибка, текст остаётся. */
  onSend: (text: string) => Promise<boolean>;
  /** Отправка с вложением: файл с подписью или голосовое. Без неё скрепки и
   *  микрофона нет. */
  onSendAttachment?: (input: Omit<AttachmentInput, 'replyTo'>) => Promise<boolean>;
  mode?: ComposerMode;
  onCancelMode?: () => void;
  /** Стрелка вверх в пустом поле — править последнее своё, как в Телеграме. */
  onEditLast?: () => void;
  onTyping?: () => void;
  autoFocus?: boolean;
  /** Кого можно упомянуть через @ — участники группы без себя. */
  mentionables?: Author[];
  /** Создать опрос — кнопка рядом со скрепкой, только в группах и каналах. */
  onCreatePoll?: () => void;
  /** «Отправить позже»: правый клик или долгое нажатие на кнопку отправки.
   *  Ошибку бросает — окно выбора времени её покажет. */
  onSchedule?: (text: string, sendAt: Date) => Promise<void>;
};

export function Composer({
  placeholder,
  onSend,
  onSendAttachment,
  mode = null,
  onCancelMode,
  onEditLast,
  onTyping,
  autoFocus = false,
  mentionables,
  onCreatePoll,
  onSchedule,
}: ComposerProps) {
  const [scheduling, setScheduling] = useState<string | null>(null);
  const id = useId();
  const [caret, setCaret] = useState(0);
  const [pickIndex, setPickIndex] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const lastTyping = useRef(0);
  const editing = mode?.kind === 'edit';
  const left = LIMIT - text.length;
  const ready = (text.trim().length > 0 || pending != null) && left >= 0 && !sending;
  const attachable = Boolean(onSendAttachment) && !editing;

  const voice = useRecorder((rec) => {
    if (!onSendAttachment) return;
    setSending(true);
    void onSendAttachment(
      rec.kind === 'video'
        ? { file: rec.blob, name: rec.name, videoNote: { duration: rec.duration } }
        : { file: rec.blob, name: rec.name, voice: { duration: rec.duration, wave: rec.wave } },
    ).finally(() => setSending(false));
  });

  // Вход в правку подставляет текст сообщения, выход из неё — очищает поле:
  // иначе после «Отмена» в поле остался бы старый текст, похожий на черновик.
  const modeKey = mode ? `${mode.kind}:${mode.id}` : '';
  const editBody = mode?.kind === 'edit' ? mode.body : null;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editBody != null) {
      setText(editBody);
      wasEditing.current = true;
    } else if (wasEditing.current) {
      setText('');
      wasEditing.current = false;
    }
    if (modeKey) field.current?.focus();
  }, [modeKey, editBody]);

  // Миниатюра выбранного фото — через object URL, который надо отпускать.
  useEffect(() => {
    if (!pending || !pending.type.startsWith('image/')) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(pending);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);

  function pick(file: File | null | undefined) {
    setFileError(null);
    if (!file) return;
    if (file.size > FILE_MAX) {
      setFileError('Файл больше 40 МБ — такой не отправить.');
      return;
    }
    setPending(file);
    field.current?.focus();
  }

  async function submit() {
    const trimmed = text.trim();
    if ((!trimmed && !pending) || trimmed.length > LIMIT || sending) return;
    setSending(true);
    const ok =
      pending && onSendAttachment && !editing
        ? await onSendAttachment({ file: pending, name: pending.name, body: trimmed })
        : await onSend(trimmed);
    setSending(false);
    if (ok) {
      setText('');
      setPending(null);
      wasEditing.current = false;
    }
    field.current?.focus();
  }

  // Подсказка упоминаний: «@» и начало логина или имени — до шести участников.
  const query = mentionables?.length ? mentionQuery(text, caret) : null;
  const suggestions =
    query && dismissed !== query.start
      ? mentionables!
          .filter((a) => a.username.startsWith(query.q) || fold(a.displayName).split(/\s+/).some((w) => w.startsWith(query.q)))
          .slice(0, 6)
      : [];
  const active = Math.min(pickIndex, Math.max(0, suggestions.length - 1));

  function insertMention(a: Author) {
    if (!query) return;
    const before = text.slice(0, query.start);
    const after = text.slice(caret);
    const next = `${before}@${a.username} ${after.replace(/^\s+/, '')}`;
    const at = before.length + a.username.length + 2;
    setText(next);
    setCaret(at);
    setPickIndex(0);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(at, at);
    });
  }

  // Пустое поле без файла — вместо «Отправить» микрофон, как в Телеграме.
  const showMic = attachable && canRecord() && !text.trim() && !pending;

  return (
    <div className="composer-wrap">
      {mode && (
        <div className={mode.kind === 'edit' ? 'composer-mode edit' : 'composer-mode'}>
          <Icon name={mode.kind === 'edit' ? 'edit' : 'reply'} size={20} />
          {/* Имя автора, а не «Ответ Марине»: склонять имена надёжно нельзя,
              а стрелка ответа рядом и так говорит, что это ответ. */}
          <span className="composer-mode-text">
            <strong>
              {mode.kind === 'edit' ? (
                'Редактирование'
              ) : (
                <>
                  <span className="sr-only">Ответ на сообщение: </span>
                  {mode.who}
                </>
              )}
            </strong>
            <span>{mode.body}</span>
          </span>
          <button className="icon-btn" type="button" aria-label="Отменить" onClick={onCancelMode}>
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {pending && (
        <div className="composer-file">
          {preview ? (
            <img className="composer-file-thumb" src={preview} alt="" />
          ) : (
            <span className="composer-file-icon">
              <Icon name={pending.type.startsWith('audio/') ? 'music' : 'file'} size={22} />
            </span>
          )}
          <span className="composer-file-text">
            <strong>{pending.name}</strong>
            <span>{fileSize(pending.size)}</span>
          </span>
          <button className="icon-btn" type="button" aria-label="Убрать файл" onClick={() => setPending(null)}>
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {(fileError || voice.error) && (
        <p className="composer-error" role="alert">
          {fileError ?? voice.error}
        </p>
      )}

      {suggestions.length > 0 && (
        <ul className="mention-pop" role="listbox" id={`${id}-mentions`} aria-label="Кого упомянуть">
          {suggestions.map((a, i) => (
            <li
              key={a.id}
              id={`${id}-mention-${a.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : undefined}
              // mousedown, а не click: поле не должно терять фокус и каретку.
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(a);
              }}
            >
              <Monogram username={a.username} displayName={a.displayName} avatarUrl={a.avatarUrl} size="sm" />
              <strong>{a.displayName}</strong>
              <span>@{a.username}</span>
            </li>
          ))}
        </ul>
      )}

      {scheduling != null && onSchedule && (
        <ScheduleDialog
          title="Отправить позже"
          preview={scheduling}
          submitLabel="Запланировать"
          onSubmit={async (at) => {
            await onSchedule(scheduling, at);
            setText('');
          }}
          onClose={() => {
            setScheduling(null);
            field.current?.focus();
          }}
        />
      )}

      {voice.recording === 'video' && voice.stream && (
        <VideoNotePreview stream={voice.stream} elapsed={voice.elapsed} />
      )}

      {voice.recording ? (
        <div
          className="composer recording"
          role="group"
          aria-label={voice.recording === 'video' ? 'Запись видеосообщения' : 'Запись голосового'}
        >
          <button className="icon-btn" type="button" aria-label="Отменить запись" onClick={() => voice.stop(true)}>
            <Icon name="trash" />
          </button>
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time" aria-live="off">
            {mmss(voice.elapsed)}
          </span>
          <span className="rec-hint">Идёт запись — отправьте, когда закончите</span>
          <button
            className="composer-send"
            type="button"
            aria-label={voice.recording === 'video' ? 'Отправить видеосообщение' : 'Отправить голосовое'}
            onClick={() => voice.stop(false)}
          >
            <Icon name="send" size={20} />
          </button>
        </div>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {attachable && (
            <>
              <button
                className="icon-btn composer-attach"
                type="button"
                aria-label="Прикрепить файл"
                title="Фото, видео, музыка или документ"
                onClick={() => picker.current?.click()}
              >
                <Icon name="paperclip" />
              </button>
              {onCreatePoll && (
                <button
                  className="icon-btn composer-poll"
                  type="button"
                  aria-label="Создать опрос"
                  title="Опрос"
                  onClick={onCreatePoll}
                >
                  <Icon name="poll" />
                </button>
              )}
              <input
                ref={picker}
                type="file"
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </>
          )}

          <label className="sr-only" htmlFor={id}>
            {editing ? 'Новый текст сообщения' : pending ? 'Подпись к файлу' : 'Сообщение'}
          </label>
          <textarea
            id={id}
            ref={field}
            rows={1}
            value={text}
            placeholder={pending ? 'Подпись' : placeholder}
            autoFocus={autoFocus && !touch()}
            aria-autocomplete={mentionables ? 'list' : undefined}
            aria-controls={suggestions.length ? `${id}-mentions` : undefined}
            aria-activedescendant={suggestions.length ? `${id}-mention-${suggestions[active].id}` : undefined}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setPickIndex(0);
              const now = Date.now();
              if (onTyping && e.target.value.trim() && !editing && now - lastTyping.current > TYPING_EVERY_MS) {
                lastTyping.current = now;
                onTyping();
              }
            }}
            // Вставка картинки из буфера (скриншот) — сразу вложение, как в Телеграме.
            onPaste={(e) => {
              const file = attachable ? e.clipboardData.files[0] : undefined;
              if (file) {
                e.preventDefault();
                pick(file);
              }
            }}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setPickIndex((active + step + suggestions.length) % suggestions.length);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  insertMention(suggestions[active]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDismissed(query!.start);
                  return;
                }
              }
              if (e.key === 'Escape' && (mode || pending)) {
                e.preventDefault();
                if (pending) setPending(null);
                else onCancelMode?.();
                return;
              }
              if (e.key === 'ArrowUp' && !text && !mode && !pending && onEditLast) {
                e.preventDefault();
                onEditLast();
                return;
              }
              // isComposing — набор через IME: Enter там подтверждает слово, а не
              // отправляет сообщение.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touch()) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {left <= COUNTER_FROM && <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>}
          {showMic ? (
            <>
              {/* «Кружок» — отдельной кнопкой рядом с микрофоном: в вебе явная
                  кнопка понятнее переключателя «нажми — сменится режим». */}
              {canRecord('video') && (
                <button
                  className="icon-btn composer-video"
                  type="button"
                  aria-label="Записать видеосообщение"
                  title="Видеосообщение — до минуты"
                  disabled={sending}
                  onClick={() => {
                    voice.clearError();
                    void voice.start('video');
                  }}
                >
                  <Icon name="video" />
                </button>
              )}
              <button
                className="composer-send mic"
                type="button"
                aria-label="Записать голосовое"
                disabled={sending}
                onClick={() => {
                  voice.clearError();
                  void voice.start('voice');
                }}
              >
                <Icon name="mic" size={20} />
              </button>
            </>
          ) : (
            <button
              className="composer-send"
              type="submit"
              disabled={!ready}
              aria-label={editing ? 'Сохранить' : 'Отправить'}
              title={onSchedule && !mode ? 'Отправить. Правый клик или долгое нажатие — отправить позже' : undefined}
              onContextMenu={(e) => {
                // Отложить можно обычное сообщение — без ответа, правки и файла.
                if (!onSchedule || mode || pending || !ready) return;
                e.preventDefault();
                setScheduling(text.trim());
              }}
            >
              <Icon name={editing ? 'check' : 'send'} size={20} />
            </button>
          )}
        </form>
      )}
    </div>
  );
}

/* ─ Поиск внутри переписки ──────────────────────────────────────────── */

/** Запрос уходит после паузы в наборе, а не на каждую букву. */
const SEARCH_DEBOUNCE_MS = 300;

type SearchProps = {
  onSearch: (q: string) => Promise<ConversationHit[]>;
  onPick: (id: number) => void;
  onClose: () => void;
};

/**
 * Поиск по открытой переписке: строка под шапкой и список найденного,
 * свежее сверху. Выбор — переход к сообщению в ленте, с догрузкой старых.
 */
export function ConversationSearch({ onSearch, onPick, onClose }: SearchProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ConversationHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terms = searchTerms(query);
  const search = useRef(onSearch);
  search.current = onSearch;

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search.current(q)
        .then((res) => {
          if (!cancelled) {
            setHits(res);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Поиск не удался');
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <section className="pane-panel conv-search" aria-label="Поиск по переписке">
      <div className="conv-search-bar">
        <label className="list-search">
          <Icon name="search" size={18} />
          <span className="sr-only">Найти в переписке</span>
          <input
            type="search"
            value={query}
            placeholder="Найти в переписке"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
        </label>
        <button className="btn ghost small" type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {hits && (
        <p className="conv-search-count" aria-live="polite">
          {hits.length === 0
            ? 'Ничего не нашлось'
            : `${hits.length} ${plural(hits.length, 'сообщение', 'сообщения', 'сообщений')}${hits.length >= 50 ? ' — показаны последние' : ''}`}
        </p>
      )}

      {hits && hits.length > 0 && (
        <ul className="conv-search-hits">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => onPick(h.id)}>
                <span className="conv-hit-head">
                  <strong>{h.author?.displayName ?? 'Публикация'}</strong>
                  <time dateTime={h.createdAt}>{dayLabel(h.createdAt)}, {clockTime(h.createdAt)}</time>
                </span>
                <span className="conv-hit-body">{highlight(oneLine(h.body), terms)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ─ Закреплённое сообщение ───────────────────────────────────────────── */

type PinnedBarProps = {
  pinned: PinnedPreview;
  onOpen: () => void;
  /** Нет — значит, откреплять этому человеку нельзя (группа, канал). */
  onUnpin?: () => void;
};

/** Полоса под шапкой, как в Телеграме: по нажатию лента едет к сообщению. */
export function PinnedBar({ pinned, onOpen, onUnpin }: PinnedBarProps) {
  return (
    <div className="pinned-bar">
      <button className="pinned-open" type="button" onClick={onOpen}>
        <span className="pinned-text">
          <strong>Закреплённое сообщение</strong>
          <span>{pinned.body}</span>
        </span>
      </button>
      {onUnpin && (
        <button className="icon-btn" type="button" aria-label="Открепить" title="Открепить" onClick={onUnpin}>
          <Icon name="close" size={18} />
        </button>
      )}
    </div>
  );
}

/**
 * Показать сообщение, которого может не быть в ленте: догружает страницы
 * вверх, пока не найдёт, и возвращает новую ленту и курсор. Общая для ЛС,
 * групп и каналов — различается только то, как грузить страницу.
 */
export async function revealOlder<T extends { id: number }>(
  id: number,
  list: T[],
  cursor: number | null,
  loadPage: (cursor: number) => Promise<{ items: T[]; nextCursor: number | null }>,
): Promise<{ list: T[]; cursor: number | null; found: boolean }> {
  let items = list;
  let next = cursor;
  // Потолок в двадцать страниц — не повод висеть бесконечно на удалённом.
  for (let i = 0; i < 20 && !items.some((m) => m.id === id) && next != null; i += 1) {
    const page = await loadPage(next);
    items = [...page.items, ...items];
    next = page.nextCursor;
  }
  return { list: items, cursor: next, found: items.some((m) => m.id === id) };
}

/* ─ Шапка переписки ───────────────────────────────────────────────────── */

type HeadProps = {
  avatar: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  /** Куда ведёт клик по имени — профиль собеседника. У группы ссылки нет. */
  to?: string;
  actions?: ReactNode;
  /** Подзаголовок акцентным цветом — «в сети», «печатает…». */
  live?: boolean;
  /** Куда «назад», если не в список чатов: из комментариев — в канал. Такая
   *  стрелка видна всегда, и в две колонки: список рядом, а канал — нет. */
  back?: { to: string; label: string };
};

export function PaneHead({ avatar, title, subtitle, to, actions, live = false, back }: HeadProps) {
  const who = (
    <>
      {avatar}
      <span className="pane-who-text">
        <strong className="pane-title">{title}</strong>
        {/* aria-live: «печатает…» и «в сети» меняются сами, без действия
            человека, — диктор должен о них сказать, но вежливо. */}
        <span className={live ? 'pane-sub live' : 'pane-sub'} aria-live="polite">
          {subtitle}
        </span>
      </span>
    </>
  );

  return (
    <header className="pane-head">
      {/* Назад — только когда список и переписка не помещаются рядом: в две
          колонки список и так на виду (см. messaging.css). */}
      <Link className={back ? 'pane-back always' : 'pane-back'} to={back?.to ?? '/messages'} aria-label={back?.label ?? 'Ко всем чатам'}>
        <Icon name="chevron-left" size={22} />
      </Link>
      {to ? (
        <Link className="pane-who" to={to}>
          {who}
        </Link>
      ) : (
        <div className="pane-who">{who}</div>
      )}
      {actions && <div className="pane-actions">{actions}</div>}
    </header>
  );
}

/** Переводит «текст сообщения» в строку для полосы ответа: одна строка, без переносов. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Можно ли ещё править — те же 48 часов, что проверяет сервер. */
export const EDIT_WINDOW_MS = 48 * 60 * 60_000;
export const editable = (createdAt: string) => Date.now() - Date.parse(createdAt) < EDIT_WINDOW_MS;

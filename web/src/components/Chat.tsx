import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  REACTIONS, type Attachment, type AttachmentInput, type Author, type ForwardedFrom, type Quote, type Reaction,
} from '../api';
import { clockTime, dayKey, dayLabel, fullDate, isOnline, plural } from '../time';
import { canRecord, mmss, useVoiceRecorder } from '../voice';
import { Icon } from './Icon';
import { Monogram } from './Monogram';

/* ─ Вложения ───────────────────────────────────────────────────────────── */

/** Подпись вложения там, где его самого не видно: список чатов, полоса ответа. */
export function attachmentLabel(a: Pick<Attachment, 'kind' | 'name'> | null | undefined) {
  if (!a) return '';
  switch (a.kind) {
    case 'image': return 'Фото';
    case 'video': return 'Видео';
    case 'voice': return 'Голосовое сообщение';
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
};

/** Какие действия есть в меню. У публикации канала нет «Ответить», у
 *  комментария — ни реакций, ни пересылки. */
export type ListActions = { reply?: boolean; react?: boolean; forward?: boolean };
const ALL_ACTIONS: Required<ListActions> = { reply: true, react: true, forward: true };

export type MessageAction =
  | { type: 'reply' }
  | { type: 'edit' }
  | { type: 'delete' }
  | { type: 'forward' }
  | { type: 'copy' }
  | { type: 'react'; emoji: string | null };

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
};

type MenuState = { item: BubbleItem; x: number; y: number } | null;

/**
 * Лента со своей прокруткой. Родитель обязан пересоздавать её для каждой
 * переписки (`key`), иначе смена чата выглядела бы как «пришло 30 новых
 * сообщений» и прокрутка вела бы себя по правилам дозагрузки.
 */
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
}: ListProps) {
  const can = { ...ALL_ACTIONS, ...actions };
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
                    {m.body ? (
                      <p className="bubble-text">
                        {m.body}
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
  onClose: () => void;
  onAction: (action: MessageAction) => void;
};

/**
 * Реакции сверху, действия списком — как контекстное меню Телеграма. Встаёт
 * там, где щёлкнули, и отодвигается от краёв окна. Esc и щелчок мимо —
 * закрыть; стрелки ходят по пунктам.
 */
function MessageMenu({ state, readOnly, can, onClose, onAction }: MenuProps) {
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
        {can.forward && (
          <MenuItem icon="forward" onClick={() => onAction({ type: 'forward' })}>
            Переслать
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
  icon: 'reply' | 'copy' | 'forward' | 'edit' | 'trash';
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
}: ComposerProps) {
  const id = useId();
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

  const voice = useVoiceRecorder((rec) => {
    if (!onSendAttachment) return;
    setSending(true);
    void onSendAttachment({ file: rec.blob, name: rec.name, voice: { duration: rec.duration, wave: rec.wave } })
      .finally(() => setSending(false));
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

      {voice.recording ? (
        <div className="composer recording" role="group" aria-label="Запись голосового">
          <button className="icon-btn" type="button" aria-label="Отменить запись" onClick={() => voice.stop(true)}>
            <Icon name="trash" />
          </button>
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time" aria-live="off">
            {mmss(voice.elapsed)}
          </span>
          <span className="rec-hint">Идёт запись — отправьте, когда закончите</span>
          <button className="composer-send" type="button" aria-label="Отправить голосовое" onClick={() => voice.stop(false)}>
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
            onChange={(e) => {
              setText(e.target.value);
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
            <button
              className="composer-send mic"
              type="button"
              aria-label="Записать голосовое"
              disabled={sending}
              onClick={() => {
                voice.clearError();
                void voice.start();
              }}
            >
              <Icon name="mic" size={20} />
            </button>
          ) : (
            <button
              className="composer-send"
              type="submit"
              disabled={!ready}
              aria-label={editing ? 'Сохранить' : 'Отправить'}
            >
              <Icon name={editing ? 'check' : 'send'} size={20} />
            </button>
          )}
        </form>
      )}
    </div>
  );
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

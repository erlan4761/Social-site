import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { REACTIONS, type Author, type Quote, type Reaction } from '../api';
import { clockTime, dayKey, dayLabel, fullDate, isOnline } from '../time';
import { Icon } from './Icon';
import { Monogram } from './Monogram';

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
  forwardedFrom: { username: string; displayName: string } | null;
  replyTo: Quote | null;
  reactions: Reaction[];
  canEdit: boolean;
  canDelete: boolean;
};

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
};

type MenuState = { item: BubbleItem; x: number; y: number } | null;

/**
 * Лента со своей прокруткой. Родитель обязан пересоздавать её для каждой
 * переписки (`key`), иначе смена чата выглядела бы как «пришло 30 новых
 * сообщений» и прокрутка вела бы себя по правилам дозагрузки.
 */
export function MessageList({ items, loading, hasMore, loadingMore, onLoadOlder, empty, onAction, readOnly = false }: ListProps) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prev = useRef<{ first?: number; last?: number; height: number }>({ height: 0 });
  const [menu, setMenu] = useState<MenuState>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);

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
    <div className="msgs" ref={box} onScroll={onScroll}>
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
                        Переслано от{' '}
                        <Link to={`/u/${m.forwardedFrom.username}`}>{m.forwardedFrom.displayName}</Link>
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

                    {/* Невидимая копия подписи в конце текста резервирует ей место
                        в последней строке: время встаёт справа внизу, как в
                        Телеграме, и никогда не наезжает на слова. */}
                    <p className="bubble-text">
                      {m.body}
                      <span className="bubble-meta-space" aria-hidden="true">
                        {meta}
                      </span>
                    </p>

                    {m.reactions.length > 0 && (
                      <div className="reactions">
                        {m.reactions.map((r) => (
                          <button
                            key={r.emoji}
                            className={r.mine ? 'reaction mine' : 'reaction'}
                            type="button"
                            aria-pressed={r.mine}
                            aria-label={`${r.emoji} ${r.count}${r.mine ? ', ваша реакция' : ''}`}
                            disabled={readOnly}
                            onClick={() => onAction({ type: 'react', emoji: r.mine ? null : r.emoji }, m)}
                          >
                            <span className="reaction-emoji">{r.emoji}</span>
                            <span className="reaction-count">{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    <span className="bubble-meta">{meta}</span>

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

      {menu && (
        <MessageMenu
          state={menu}
          readOnly={readOnly}
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

/* ─ Меню сообщения ─────────────────────────────────────────────────────── */

type MenuProps = {
  state: NonNullable<MenuState>;
  readOnly: boolean;
  onClose: () => void;
  onAction: (action: MessageAction) => void;
};

/**
 * Реакции сверху, действия списком — как контекстное меню Телеграма. Встаёт
 * там, где щёлкнули, и отодвигается от краёв окна. Esc и щелчок мимо —
 * закрыть; стрелки ходят по пунктам.
 */
function MessageMenu({ state, readOnly, onClose, onAction }: MenuProps) {
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
      {!readOnly && (
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
        {!readOnly && (
          <MenuItem icon="reply" onClick={() => onAction({ type: 'reply' })}>
            Ответить
          </MenuItem>
        )}
        <MenuItem icon="copy" onClick={() => onAction({ type: 'copy' })}>
          Копировать текст
        </MenuItem>
        <MenuItem icon="forward" onClick={() => onAction({ type: 'forward' })}>
          Переслать
        </MenuItem>
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

type ComposerProps = {
  placeholder: string;
  /** Отправка или сохранение правки. `true` — готово, поле очищается;
   *  `false` — ошибка, текст остаётся. */
  onSend: (text: string) => Promise<boolean>;
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
  mode = null,
  onCancelMode,
  onEditLast,
  onTyping,
  autoFocus = false,
}: ComposerProps) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const lastTyping = useRef(0);
  const left = LIMIT - text.length;
  const ready = text.trim().length > 0 && left >= 0 && !sending;

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

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > LIMIT || sending) return;
    setSending(true);
    const ok = await onSend(trimmed);
    setSending(false);
    if (ok) {
      setText('');
      wasEditing.current = false;
    }
    field.current?.focus();
  }

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

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor={id}>
          {mode?.kind === 'edit' ? 'Новый текст сообщения' : 'Сообщение'}
        </label>
        <textarea
          id={id}
          ref={field}
          rows={1}
          value={text}
          placeholder={placeholder}
          autoFocus={autoFocus && !touch()}
          onChange={(e) => {
            setText(e.target.value);
            const now = Date.now();
            if (onTyping && e.target.value.trim() && mode?.kind !== 'edit' && now - lastTyping.current > TYPING_EVERY_MS) {
              lastTyping.current = now;
              onTyping();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && mode) {
              e.preventDefault();
              onCancelMode?.();
              return;
            }
            if (e.key === 'ArrowUp' && !text && !mode && onEditLast) {
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
        <button
          className="composer-send"
          type="submit"
          disabled={!ready}
          aria-label={mode?.kind === 'edit' ? 'Сохранить' : 'Отправить'}
        >
          <Icon name={mode?.kind === 'edit' ? 'check' : 'send'} size={20} />
        </button>
      </form>
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
};

export function PaneHead({ avatar, title, subtitle, to, actions, live = false }: HeadProps) {
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
      <Link className="pane-back" to="/messages" aria-label="Ко всем чатам">
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

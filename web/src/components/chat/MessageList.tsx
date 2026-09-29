import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { REACTIONS, type Attachment, type Author, type ForwardedFrom, type Poll, type Quote, type Reaction } from '../../api';
import { clockTime, dayKey, dayLabel, fullDate, plural } from '../../time';
import { Icon } from '../Icon';
import { useSession } from '../../session';
import { StickerArt } from '../../stickers';
import { AttachmentView, ImageViewer } from './attachments';
import { Ticks, type Delivery } from './status';
import { PollCard } from './PollCard';
import { MessageText, firstUrl } from './MessageText';
import { LinkPreview } from './LinkPreview';

/* ─ Лента сообщений ─────────────────────────────────────────────────────
   Пузыри, серии, дни, прокрутка, меню действий и долгое нажатие. */

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
  /** Стикер вместо текста — рисуется крупно и без пузыря. */
  sticker?: string | null;
  /** Код альбома: подряд идущие снимки с одним кодом — одна сетка. */
  albumId?: string | null;
  /** Собранный альбом: все его снимки по порядку (заполняет сама лента). */
  album?: BubbleItem[];
};

/**
 * Подряд идущие снимки одного альбома — одним пузырём, как в Телеграме. Пузырь
 * говорит от имени снимка с подписью (или первого): ему отвечают, его правят,
 * закрепляют и пересылают; удаление — всего альбома. Время и галочки — у
 * последнего снимка.
 */
export function groupAlbums(items: BubbleItem[]): BubbleItem[] {
  const out: BubbleItem[] = [];
  for (let i = 0; i < items.length; ) {
    const m = items[i];
    let j = i + 1;
    while (m.albumId && j < items.length && items[j].albumId === m.albumId && items[j].mine === m.mine && items[j].author?.id === m.author?.id) j++;
    if (j - i < 2) {
      out.push(m);
    } else {
      const parts = items.slice(i, j);
      const head = parts.find((x) => x.body) ?? parts[0];
      const last = parts[parts.length - 1];
      out.push({
        ...head,
        createdAt: last.createdAt,
        status: last.status,
        attachment: null,
        album: parts,
        canDelete: parts.every((x) => x.canDelete),
      });
    }
    i = j;
  }
  return out;
}

/** Какие действия есть в меню. У публикации канала нет «Ответить», у
 *  комментария — ни реакций, ни пересылки. */
export type ListActions = { reply?: boolean; react?: boolean; forward?: boolean; pin?: boolean; readers?: boolean };
/** Закреплять вправе не все (в группе и канале — владелец), поэтому «pin»
 *  включается явно, а остальное есть по умолчанию. */
// «Кто прочитал» — только в группах: в личке хватает двух галочек.
const ALL_ACTIONS: Required<ListActions> = { reply: true, react: true, forward: true, pin: false, readers: false };

export type MessageAction =
  | { type: 'reply' }
  | { type: 'edit' }
  /** `ids` — у альбома: удаляются все его снимки разом. */
  | { type: 'delete'; ids?: number[] }
  | { type: 'forward' }
  | { type: 'copy' }
  | { type: 'pin' }
  | { type: 'readers' }
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
  const raw = items;
  items = groupAlbums(raw);
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
    const first = raw[0]?.id;
    const last = raw.at(-1)?.id;
    const was = prev.current;

    if (was.last === undefined) {
      // Первая порция — сразу к последнему сообщению, как открывается любой мессенджер.
      el.scrollTop = el.scrollHeight;
    } else if (first !== was.first && last === was.last) {
      // Подгрузили старые сверху — держим на месте то, что человек читал.
      el.scrollTop += el.scrollHeight - was.height;
    } else if (last !== was.last && (atBottom.current || raw.at(-1)?.mine)) {
      // Новое снизу: едем к нему, только если человек и так внизу или это его
      // собственное сообщение. Читающего историю не дёргаем.
      el.scrollTop = el.scrollHeight;
    }

    prev.current = { first, last, height: el.scrollHeight };
  }, [raw]);

  // Меню, открытое на сообщении, которое тем временем удалили, закрывается само.
  useEffect(() => {
    if (menu && !raw.some((m) => m.id === menu.item.id)) setMenu(null);
  }, [raw, menu]);

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
              // Стикер — тоже без пузыря: картинка и время поверх неё.
              if (m.sticker) cls.push('has-sticker');

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
                  {/* Переход к любому снимку альбома находит его пузырь. */}
                  {m.album?.filter((x) => x.id !== m.id).map((x) => <span key={x.id} data-mid={x.id} hidden />)}
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

                    {m.album && (
                      <div className={m.album.length % 2 ? 'album odd' : 'album'}>
                        {m.album.map(
                          (x) =>
                            x.attachment && (
                              <AttachmentView
                                key={x.id}
                                a={x.attachment}
                                onMediaLoad={onMediaLoad}
                                onOpenImage={(url, alt) => setViewer({ url, alt })}
                              />
                            ),
                        )}
                      </div>
                    )}

                    {/* Невидимая копия подписи в конце текста резервирует ей место
                        в последней строке: время встаёт справа внизу, как в
                        Телеграме, и никогда не наезжает на слова. Без текста
                        (фото, голосовое) подпись идёт отдельной строкой. */}
                    {m.sticker ? (
                      <>
                        <StickerArt id={m.sticker} />
                        {m.reactions.length === 0 && <span className="bubble-foot" aria-hidden="true" />}
                      </>
                    ) : m.poll ? (
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
                      <>
                        <p className="bubble-text">
                          <MessageText text={m.body} me={me} />
                          <span className="bubble-meta-space" aria-hidden="true">
                            {meta}
                          </span>
                        </p>
                        {/* У фото и файла своя картинка — карточка ссылки там лишняя. */}
                        {!m.attachment && firstUrl(m.body) && <LinkPreview url={firstUrl(m.body)!} onLoad={onMediaLoad} />}
                      </>
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
            // Удалить альбом — значит все его снимки.
            onAction(action.type === 'delete' && item.album ? { type: 'delete', ids: item.album.map((x) => x.id) } : action, item);
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
        {can.readers && item.mine && (
          <MenuItem icon="eye" onClick={() => onAction({ type: 'readers' })}>
            Кто прочитал
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
  icon: 'reply' | 'copy' | 'forward' | 'edit' | 'trash' | 'pin' | 'eye';
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

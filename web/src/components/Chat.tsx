import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Author } from '../api';
import { clockTime, dayKey, dayLabel, fullDate, isOnline } from '../time';
import { Icon } from './Icon';
import { Monogram } from './Monogram';

/**
 * Детали мессенджера, общие для личной переписки и группового чата: у них
 * разные API и разные шапки, но лента сообщений, пузырь и поле ввода одни.
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
};

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

type ListProps = {
  items: BubbleItem[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
  empty: ReactNode;
};

/**
 * Лента со своей прокруткой. Родитель обязан пересоздавать её для каждой
 * переписки (`key`), иначе смена чата выглядела бы как «пришло 30 новых
 * сообщений» и прокрутка вела бы себя по правилам дозагрузки.
 */
export function MessageList({ items, loading, hasMore, loadingMore, onLoadOlder, empty }: ListProps) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prev = useRef<{ first?: number; last?: number; height: number }>({ height: 0 });

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

  function onScroll() {
    const el = box.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (el.scrollTop < TOP_PRELOAD && hasMore && !loadingMore) onLoadOlder();
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

              const meta = (
                <>
                  <time dateTime={m.createdAt} title={fullDate(m.createdAt)}>
                    {clockTime(m.createdAt)}
                  </time>
                  {m.mine && m.status && <Ticks status={m.status} />}
                </>
              );

              return (
                <div key={m.id} className="bubble-row">
                  {newDay && (
                    <div className="day-sep" role="separator">
                      <span>{dayLabel(m.createdAt)}</span>
                    </div>
                  )}
                  <div className={cls.join(' ')}>
                    {!m.mine && m.author && starts && (
                      <Link className="bubble-author" to={`/u/${m.author.username}`}>
                        {m.author.displayName}
                      </Link>
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
                    <span className="bubble-meta">{meta}</span>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

/* ─ Поле ввода ─────────────────────────────────────────────────────────── */

const LIMIT = 1000;
/** Счётчик символов появляется, только когда до потолка осталось немного. */
const COUNTER_FROM = 120;

/** На сенсорных экранах Enter — перевод строки, как в мобильном Телеграме:
 *  отправка там — кнопкой, а случайная отправка недописанного обидна. */
const touch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

type ComposerProps = {
  placeholder: string;
  /** Отправка. `true` — ушло, поле очищается; `false` — ошибка, текст остаётся. */
  onSend: (text: string) => Promise<boolean>;
  autoFocus?: boolean;
};

export function Composer({ placeholder, onSend, autoFocus = false }: ComposerProps) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const left = LIMIT - text.length;
  const ready = text.trim().length > 0 && left >= 0 && !sending;

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > LIMIT || sending) return;
    setSending(true);
    const ok = await onSend(trimmed);
    setSending(false);
    if (ok) setText('');
    field.current?.focus();
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" htmlFor={id}>
        Сообщение
      </label>
      <textarea
        id={id}
        ref={field}
        rows={1}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus && !touch()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // isComposing — набор через IME: Enter там подтверждает слово, а не
          // отправляет сообщение.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touch()) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {left <= COUNTER_FROM && <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>}
      <button className="composer-send" type="submit" disabled={!ready} aria-label="Отправить">
        <Icon name="send" size={20} />
      </button>
    </form>
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
  /** Подзаголовок акцентным цветом — «в сети». */
  live?: boolean;
};

export function PaneHead({ avatar, title, subtitle, to, actions, live = false }: HeadProps) {
  const who = (
    <>
      {avatar}
      <span className="pane-who-text">
        <strong className="pane-title">{title}</strong>
        <span className={live ? 'pane-sub live' : 'pane-sub'}>{subtitle}</span>
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

import { type Author } from '../../api';
import { isOnline } from '../../time';
import { Monogram } from '../Monogram';

/* ─ Метки состояния: «в сети», галочки, «печатает…» ──────────────────── */

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

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { type PinnedPreview } from '../../api';
import { Icon } from '../Icon';

/* ─ Шапка переписки и полоса закреплённого ───────────────────────────── */

type PinnedBarProps = {
  /** Закреплённые, свежие сверху. */
  pins: PinnedPreview[];
  onOpen: (id: number) => void;
  /** Нет — значит, откреплять этому человеку нельзя (группа, канал). */
  onUnpin?: (id: number) => void;
};

/**
 * Полоса под шапкой, как в Телеграме: по нажатию лента едет к сообщению, а
 * полоса переходит к предыдущему закреплённому — и так по кругу. Риски слева
 * показывают, какое из нескольких сейчас на виду; крестик открепляет его.
 */
export function PinnedBar({ pins, onOpen, onUnpin }: PinnedBarProps) {
  const [index, setIndex] = useState(0);
  const n = pins.length;
  const i = Math.min(index, n - 1);
  const current = pins[i];
  // Больше четырёх рисок не различить глазом — окно из четырёх, как в Телеграме.
  const marks = Math.min(n, 4);
  const lit = n <= 4 ? i : Math.round((i * 3) / (n - 1));
  return (
    <div className="pinned-bar">
      <button
        className={n > 1 ? 'pinned-open many' : 'pinned-open'}
        type="button"
        onClick={() => {
          onOpen(current.id);
          if (n > 1) setIndex((i + 1) % n);
        }}
      >
        {n > 1 && (
          <span className="pinned-marks" aria-hidden="true">
            {Array.from({ length: marks }, (_, k) => (
              <span key={k} className={k === lit ? 'on' : undefined} />
            ))}
          </span>
        )}
        <span className="pinned-text">
          <strong>{n > 1 ? `Закреплённое ${i + 1} из ${n}` : 'Закреплённое сообщение'}</strong>
          <span>{current.body}</span>
        </span>
      </button>
      {onUnpin && (
        <button
          className="icon-btn"
          type="button"
          aria-label={n > 1 ? 'Открепить это сообщение' : 'Открепить'}
          title={n > 1 ? 'Открепить это сообщение' : 'Открепить'}
          onClick={() => onUnpin(current.id)}
        >
          <Icon name="close" size={18} />
        </button>
      )}
    </div>
  );
}

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

/* ─ Короткое уведомление над полем ввода ─────────────────────────────── */

/** «Ссылка скопирована» и подобное: показать на две секунды и убрать. */
export function useNotice(): [string | null, (text: string) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return [notice, useCallback((text: string) => setNotice(text), [])];
}

export function PaneNotice({ text }: { text: string | null }) {
  // Живая область есть всегда — иначе скринридер не заметил бы первое уведомление.
  return (
    <p className={text ? 'pane-notice' : 'pane-notice empty'} role="status">
      {text}
    </p>
  );
}

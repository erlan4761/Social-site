import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { type PinnedPreview } from '../../api';
import { Icon } from '../Icon';

/* ─ Шапка переписки и полоса закреплённого ───────────────────────────── */

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

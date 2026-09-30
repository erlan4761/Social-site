import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatFolder } from '../../api';
import { Icon } from '../Icon';
import type { Row } from './rows';

/* ─ Меню строки списка ───────────────────────────────────────────────── */

type RowMenuProps = {
  state: { row: Row; x: number; y: number };
  onClose: () => void;
  onPin: (pinned: boolean) => void;
  onMute: (muted: boolean) => void;
  onArchive: (archived: boolean) => void;
  folders: { folder: ChatFolder; inside: boolean }[];
  onFolder: (folder: ChatFolder, on: boolean) => void;
};

/** Меню строки списка: закрепить, выключить уведомления, убрать в архив. Встаёт там, где
 *  щёлкнули, и отодвигается от краёв окна, как меню сообщения. */
export function RowMenu({ state, onClose, onPin, onMute, onArchive, folders, onFolder }: RowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });
  const pinned = Boolean(state.row.item.pinnedAt);
  const muted = state.row.item.muted;
  const archived = state.row.item.archived;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(state.x, window.innerWidth - width - 8)),
      top: state.y + height > window.innerHeight - 8 ? Math.max(8, state.y - height) : state.y,
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [state.x, state.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="msg-menu" ref={ref} role="menu" aria-label={`Чат «${state.row.name}»`} style={{ left: pos.left, top: pos.top }}>
      <div className="msg-menu-list">
        <button className="msg-menu-item" type="button" role="menuitem" onClick={() => onPin(!pinned)}>
          <Icon name="pin" size={18} />
          {pinned ? 'Открепить' : 'Закрепить'}
        </button>
        <button className="msg-menu-item" type="button" role="menuitem" onClick={() => onMute(!muted)}>
          <Icon name={muted ? 'bell' : 'bell-off'} size={18} />
          {muted ? 'Включить уведомления' : 'Выключить уведомления'}
        </button>
        <button className="msg-menu-item" type="button" role="menuitem" onClick={() => onArchive(!archived)}>
          <Icon name="archive" size={18} />
          {archived ? 'Вернуть из архива' : 'В архив'}
        </button>
      </div>
      {folders.length > 0 && (
        <div className="msg-menu-list row-menu-folders" role="group" aria-label="Папки">
          <span className="row-menu-label">В папках</span>
          {folders.map(({ folder, inside }) => (
            <button
              key={folder.id}
              className="msg-menu-item"
              type="button"
              role="menuitemcheckbox"
              aria-checked={inside}
              onClick={() => onFolder(folder, !inside)}
            >
              <span className="row-menu-check" aria-hidden="true">
                {inside && <Icon name="check" size={16} />}
              </span>
              {folder.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

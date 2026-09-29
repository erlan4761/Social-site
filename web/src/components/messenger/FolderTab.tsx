

/* ─ Вкладка папки над списком ───────────────────────────────────────── */

/** Вкладка папки. Правый клик — сразу правка этой папки. */
export function FolderTab({
  label,
  active,
  unread,
  onClick,
  onEdit,
}: {
  label: string;
  active: boolean;
  unread: number;
  onClick: () => void;
  onEdit?: () => void;
}) {
  return (
    <button
      className={active ? 'folder-tab on' : 'folder-tab'}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onEdit) return;
        e.preventDefault();
        onEdit();
      }}
    >
      {label}
      {unread > 0 && (
        <span className="folder-badge">
          {unread}
          <span className="sr-only"> непрочитанных</span>
        </span>
      )}
    </button>
  );
}

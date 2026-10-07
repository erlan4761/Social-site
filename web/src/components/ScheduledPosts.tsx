import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, type Post, type ScheduledPost } from '../api';
import { fullDate, plural } from '../time';
import { Icon } from './Icon';
import { ScheduleDialog } from './Scheduled';

type Props = {
  /** Меняется, когда композер что-то отложил, — очередь перечитывается. */
  version: number;
  /** «Опубликовать сейчас» — запись готова, лента кладёт её наверх. */
  onPublished: (post: Post) => void;
  /** Что-то ушло по расписанию само — ленте пора перечитаться. */
  onDue: () => void;
};

/**
 * Полоса «Запланировано: 2 записи» под композером ленты и окно со списком:
 * опубликовать сейчас, изменить время, удалить. Очередь видна только автору.
 * Пока окно закрыто, она перечитывается раз в полминуты: так полоса сама
 * гаснет, когда запись вышла по расписанию.
 */
export function ScheduledPostsBar({ version, onPublished, onDue }: Props) {
  const [items, setItems] = useState<ScheduledPost[]>([]);
  const [open, setOpen] = useState(false);
  const count = useRef(0);

  const load = useCallback(() => {
    api
      .scheduledPosts()
      .then((res) => {
        // Очередь укоротилась сама — значит, что-то вышло по расписанию.
        if (res.scheduled.length < count.current) onDue();
        count.current = res.scheduled.length;
        setItems(res.scheduled);
      })
      .catch(() => undefined);
  }, [onDue]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load, version]);

  if (items.length === 0) return null;
  const next = items[0];

  return (
    <>
      <button className="scheduled-bar scheduled-posts-bar" type="button" onClick={() => setOpen(true)}>
        <Icon name="clock" size={16} />
        <span>
          <strong>
            Запланировано: {items.length} {plural(items.length, 'запись', 'записи', 'записей')}
          </strong>
          <span>ближайшая — {fullDate(next.sendAt)}</span>
        </span>
        <Icon name="chevron-right" size={16} />
      </button>
      {open && (
        <ScheduledPostList
          items={items}
          onChange={(list) => {
            count.current = list.length;
            setItems(list);
          }}
          onPublished={onPublished}
          onClose={() => {
            setOpen(false);
            load();
          }}
        />
      )}
    </>
  );
}

function ScheduledPostList({
  items,
  onChange,
  onPublished,
  onClose,
}: {
  items: ScheduledPost[];
  onChange: (list: ScheduledPost[]) => void;
  onPublished: (post: Post) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retiming, setRetiming] = useState<ScheduledPost | null>(null);

  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.showModal();
    const onNativeClose = () => closeHandler.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  async function run(action: () => Promise<ScheduledPost[]>) {
    setBusy(true);
    setError(null);
    try {
      const list = await action();
      onChange(list);
      if (list.length === 0) dialog.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  }

  const without = (x: ScheduledPost) => items.filter((i) => i.id !== x.id);

  return (
    <dialog
      className="sheet scheduled-sheet"
      ref={dialog}
      onClick={(e) => e.target === dialog.current && dialog.current.close()}
      aria-labelledby={`${id}-t`}
    >
      <h2 className="sheet-title" id={`${id}-t`}>
        Запланированные записи
      </h2>
      <p className="sheet-subject">Выйдут в ленту сами в указанное время. Видите их только вы.</p>
      {error && <p className="error">{error}</p>}

      <ul className="scheduled-list">
        {items.map((s) => (
          <li key={s.id}>
            <span className="scheduled-when">
              <Icon name="clock" size={14} />
              {fullDate(s.sendAt)}
            </span>
            <p className="scheduled-text">{s.body}</p>
            <span className="scheduled-actions">
              <button
                className="btn link"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const res = await api.publishScheduledPost(s.id);
                    onPublished(res.post);
                    return without(s);
                  })
                }
              >
                Опубликовать сейчас
              </button>
              <button className="btn link" type="button" disabled={busy} onClick={() => setRetiming(s)}>
                Изменить время
              </button>
              <button
                className="btn link danger-link"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.cancelScheduledPost(s.id);
                    return without(s);
                  })
                }
              >
                Удалить
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="sheet-foot">
        <button className="btn ghost" type="button" onClick={() => dialog.current?.close()}>
          Готово
        </button>
      </div>

      {retiming && (
        <ScheduleDialog
          title="Изменить время"
          preview={retiming.body}
          initial={new Date(retiming.sendAt)}
          submitLabel="Сохранить"
          onSubmit={async (at) => {
            const res = await api.reschedulePost(retiming.id, at);
            onChange(items.map((i) => (i.id === retiming.id ? res.scheduled : i)).sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
          }}
          onClose={() => setRetiming(null)}
        />
      )}
    </dialog>
  );
}

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { api, ApiError, type Scheduled, type ScheduledKind } from '../api';
import { useLive } from '../live';
import { fullDate, plural } from '../time';
import { Icon } from './Icon';

/* ─ Когда отправить ───────────────────────────────────────────────────── */

/** Значение для <input type="datetime-local"> — в местном времени, без секунд. */
const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Готовые варианты, как в Телеграме: через час, сегодня вечером, завтра утром. */
function presets(now = new Date()) {
  const hour = new Date(now.getTime() + 60 * 60_000);
  const evening = new Date(now);
  evening.setHours(20, 0, 0, 0);
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  return [
    { label: 'Через час', at: hour },
    ...(evening.getTime() - now.getTime() > 30 * 60_000 ? [{ label: 'Сегодня в 20:00', at: evening }] : []),
    { label: 'Завтра в 9:00', at: morning },
  ];
}

type WhenProps = {
  title: string;
  /** Текст, который уйдёт, — чтобы было видно, что именно откладывается. */
  preview?: string;
  initial?: Date;
  submitLabel: string;
  onSubmit: (sendAt: Date) => Promise<void>;
  onClose: () => void;
};

/** Окно «Отправить позже» и «Изменить время» — одно и то же. */
export function ScheduleDialog({ title, preview, initial, submitLabel, onSubmit, onClose }: WhenProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [value, setValue] = useState(localInput(initial ?? new Date(Date.now() + 60 * 60_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function go(at: Date) {
    if (Number.isNaN(at.getTime())) return setError('Выберите дату и время.');
    if (at.getTime() <= Date.now()) return setError('Это время уже прошло — выберите позже.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit(at);
      dialog.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void go(new Date(value));
  }

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current && !busy) dialog.current.close();
  }

  return (
    <dialog className="sheet schedule-sheet" ref={dialog} onClick={backdrop} aria-labelledby={`${id}-t`}>
      <form onSubmit={submit}>
        <h2 className="sheet-title" id={`${id}-t`}>
          {title}
        </h2>
        {preview && <p className="sheet-subject schedule-preview">{preview}</p>}
        {error && <p className="error">{error}</p>}

        <div className="schedule-presets">
          {presets().map((p) => (
            <button key={p.label} className="btn ghost small" type="button" disabled={busy} onClick={() => void go(p.at)}>
              {p.label}
            </button>
          ))}
        </div>

        <label className="field" htmlFor={`${id}-at`}>
          <span>Или точное время</span>
          <input
            id={`${id}-at`}
            type="datetime-local"
            value={value}
            min={localInput(new Date())}
            required
            onChange={(e) => setValue(e.target.value)}
          />
        </label>

        <div className="sheet-foot">
          <button className="btn ghost" type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            Отмена
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Сохраняю…' : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/* ─ Очередь в переписке ─────────────────────────────────────────────────── */

type BarProps = {
  kind: ScheduledKind;
  target: string | number;
  /** Меняется, когда страница что-то отложила, — очередь перечитывается. */
  version: number;
  /** Отложенное ушло «сейчас» или по времени — переписке пора обновиться. */
  onSent: () => void;
};

/**
 * Полоса «Отложено: 2» над полем ввода и окно со списком: отправить сейчас,
 * изменить время, удалить. Очередь видна только автору — сервер отдаёт свои.
 * Пока окно закрыто, очередь перечитывается раз в полминуты: так полоса сама
 * гаснет, когда сообщение ушло по расписанию.
 */
export function ScheduledBar({ kind, target, version, onSent }: BarProps) {
  const [items, setItems] = useState<Scheduled[]>([]);
  const [open, setOpen] = useState(false);
  const count = useRef(0);

  const load = useCallback(() => {
    api.scheduled(kind, target).then((res) => {
      // Очередь укоротилась сама — значит, что-то ушло по расписанию.
      if (res.scheduled.length < count.current) onSent();
      count.current = res.scheduled.length;
      setItems(res.scheduled);
    }).catch(() => undefined);
  }, [kind, target, onSent]);

  useLive((e) => {
    if (e.t === kind) load();
  });

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load, version]);

  if (items.length === 0) return null;
  const next = items[0];

  return (
    <>
      <button className="scheduled-bar" type="button" onClick={() => setOpen(true)}>
        <Icon name="clock" size={16} />
        <span>
          <strong>
            Отложено: {items.length} {plural(items.length, 'сообщение', 'сообщения', 'сообщений')}
          </strong>
          <span>ближайшее — {fullDate(next.sendAt)}</span>
        </span>
        <Icon name="chevron-right" size={16} />
      </button>
      {open && (
        <ScheduledList
          items={items}
          onChange={(list) => {
            count.current = list.length;
            setItems(list);
          }}
          onSent={onSent}
          onClose={() => {
            setOpen(false);
            load();
          }}
        />
      )}
    </>
  );
}

function ScheduledList({
  items,
  onChange,
  onSent,
  onClose,
}: {
  items: Scheduled[];
  onChange: (list: Scheduled[]) => void;
  onSent: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retiming, setRetiming] = useState<Scheduled | null>(null);

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

  async function run(action: () => Promise<Scheduled[]>, sent = false) {
    setBusy(true);
    setError(null);
    try {
      const list = await action();
      onChange(list);
      if (sent) onSent();
      if (list.length === 0) dialog.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  }

  const without = (x: Scheduled) => items.filter((i) => i.id !== x.id);

  return (
    <dialog
      className="sheet scheduled-sheet"
      ref={dialog}
      onClick={(e) => e.target === dialog.current && dialog.current.close()}
      aria-labelledby={`${id}-t`}
    >
      <h2 className="sheet-title" id={`${id}-t`}>
        Отложенные сообщения
      </h2>
      <p className="sheet-subject">Уйдут сами в указанное время. Видите их только вы.</p>
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
              <button className="btn link" type="button" disabled={busy} onClick={() => void run(async () => {
                await api.sendScheduledNow(s.id);
                return without(s);
              }, true)}>
                Отправить сейчас
              </button>
              <button className="btn link" type="button" disabled={busy} onClick={() => setRetiming(s)}>
                Изменить время
              </button>
              <button className="btn link danger-link" type="button" disabled={busy} onClick={() => void run(async () => {
                await api.deleteScheduled(s.id);
                return without(s);
              })}>
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
            const res = await api.updateScheduled(retiming.id, { sendAt: at.toISOString() });
            onChange(
              items.map((i) => (i.id === retiming.id ? res.scheduled : i)).sort((a, b) => a.sendAt.localeCompare(b.sendAt)),
            );
          }}
          onClose={() => setRetiming(null)}
        />
      )}
    </dialog>
  );
}

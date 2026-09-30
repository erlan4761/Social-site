import { useEffect, useState } from 'react';
import type { ForwardRef } from '../../api';
import { plural } from '../../time';
import { Icon } from '../Icon';
import type { Forwarding } from '../ForwardDialog';
import { plainText } from './markup';
import { previewText } from './format';
import type { BubbleItem } from './MessageList';

/* ─ Выбор нескольких сообщений ──────────────────────────────────────────
   Как в Телеграме: «Выбрать» в меню сообщения — и лента переходит в режим
   выбора: нажатие отмечает сообщение, вместо поля ввода — полоса «Переслать,
   Копировать, Удалить». Альбом выбирается целиком. Ни одного отмеченного —
   режим выключается сам; Esc — тоже. */

/** Больше за раз не выбрать — как в Телеграме. */
export const SELECT_MAX = 100;

export type Selection = {
  ids: ReadonlySet<number>;
  active: boolean;
  /** Отметить или снять — несколько id разом (альбом). */
  toggle: (ids: number[]) => void;
  clear: () => void;
};

/** `present` — id сообщений в ленте: удалённые из выбора выпадают сами. */
export function useSelection(present: number[]): Selection {
  const [ids, setIds] = useState<ReadonlySet<number>>(() => new Set());
  const active = ids.size > 0;

  const presentKey = present.join(',');
  useEffect(() => {
    const here = new Set(present);
    setIds((prev) => ([...prev].every((id) => here.has(id)) ? prev : new Set([...prev].filter((id) => here.has(id)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentKey]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIds(new Set());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);

  return {
    ids,
    active,
    toggle: (list) =>
      setIds((prev) => {
        const next = new Set(prev);
        if (list.every((id) => prev.has(id))) list.forEach((id) => next.delete(id));
        else if (prev.size + list.length <= SELECT_MAX) list.forEach((id) => next.add(id));
        return next;
      }),
    clear: () => setIds(new Set()),
  };
}

/**
 * Пересылка выбранного: каждое сообщение — своей группой, подряд идущие снимки
 * одного альбома — одной, чтобы у получателя альбом снова был сеткой.
 */
export function forwardGroups(from: ForwardRef['from'], list: { id: number; albumId?: string | null }[]): ForwardRef[][] {
  const out: ForwardRef[][] = [];
  let album: string | null = null;
  for (const m of list) {
    const ref = { from, id: m.id };
    if (m.albumId && m.albumId === album) out[out.length - 1].push(ref);
    else out.push([ref]);
    album = m.albumId ?? null;
  }
  return out;
}

const stamp = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Что видно в сообщении — для буфера обмена: текст без знаков, со спойлером. */
const visibleText = (m: BubbleItem) => (m.body ? plainText(m.body, 'show') : previewText('', m.attachment, m.sticker));

/** Одно сообщение — просто текст; несколько — «Имя, [дата]» над каждым, как в Телеграме. */
export function copyLines(list: BubbleItem[], who: (m: BubbleItem) => string) {
  if (list.length === 1) return visibleText(list[0]);
  return list.map((m) => `${who(m)}, [${stamp(m.createdAt)}]\n${visibleText(m)}`).join('\n\n');
}

export const messagesCount = (n: number) => `${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`;

type BarProps = {
  selection: Selection;
  /** Сообщения ленты в её порядке — те же, что ушли в MessageList. */
  items: BubbleItem[];
  from: ForwardRef['from'];
  /** Имя автора для «Копировать»: в личке его нет в самом сообщении. */
  who: (m: BubbleItem) => string;
  onForward: (f: Forwarding) => void;
  /** Нет — удалять здесь нельзя (подписчик канала). Подтверждение — на странице. */
  onDelete?: (ids: number[]) => Promise<boolean>;
};

/** Полоса вместо поля ввода, пока идёт выбор. */
export function SelectionBar({ selection, items, from, who, onForward, onDelete }: BarProps) {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 2000);
    return () => window.clearTimeout(timer);
  }, [note]);
  const chosen = items.filter((m) => selection.ids.has(m.id));
  const n = chosen.length;
  // Опрос и запись о звонке не пересылаются — как и по одному.
  const forwardable = n > 0 && chosen.every((m) => !m.poll && !m.call);
  const deletable = Boolean(onDelete) && n > 0 && chosen.every((m) => m.canDelete);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyLines(chosen, who));
      setNote('Скопировано');
    } catch {
      setNote('Не удалось скопировать');
    }
  }

  return (
    <div className="select-bar" role="toolbar" aria-label="Выбранные сообщения">
      <button className="icon-btn" type="button" aria-label="Отменить выбор" title="Отменить выбор (Esc)" onClick={selection.clear}>
        <Icon name="close" />
      </button>
      <span className="select-count" aria-live="polite">
        {note ?? `Выбрано: ${messagesCount(n)}`}
      </span>
      <button
        className="btn ghost small"
        type="button"
        disabled={!forwardable}
        title={forwardable ? 'Переслать' : 'Опрос и запись о звонке не пересылаются'}
        onClick={() => {
          onForward({ groups: forwardGroups(from, chosen), preview: messagesCount(n) });
          selection.clear();
        }}
      >
        <Icon name="forward" size={18} />
        <span className="select-label">Переслать</span>
      </button>
      <button className="btn ghost small" type="button" title="Копировать" disabled={n === 0} onClick={() => void copy()}>
        <Icon name="copy" size={18} />
        <span className="select-label">Копировать</span>
      </button>
      {onDelete && (
        <button
          className="btn ghost small danger"
          type="button"
          disabled={!deletable}
          title={deletable ? 'Удалить' : 'Среди выбранных есть то, что удалить нельзя'}
          onClick={() => {
            void onDelete(chosen.map((m) => m.id)).then((done) => {
              if (done) selection.clear();
            });
          }}
        >
          <Icon name="trash" size={18} />
          <span className="select-label">Удалить</span>
        </button>
      )}
    </div>
  );
}

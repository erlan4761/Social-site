import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import { api, ApiError, type ChatFolder, type PrefKind } from '../api';
import { KIND_LABELS, PRESETS, inFolder, toggleInFolder, type FolderRow } from '../folders';
import { Icon } from './Icon';

const TITLE_MAX = 12;
const FOLDER_LIMIT = 10;

/** Чат в редакторе: то, что нужно правилу, плюс как его показать. */
export type FolderChat = FolderRow & { name: string; avatar: ReactNode };

type Props = {
  folders: ChatFolder[];
  chats: FolderChat[];
  /** Сразу открыть правку этой папки — из меню вкладки. */
  editId?: number | null;
  onChange: (folders: ChatFolder[]) => void;
  onClose: () => void;
};

/**
 * Окно «Папки»: список с порядком, правкой и удалением, а когда папок нет —
 * готовые «Личное», «Группы», «Каналы». Нативный `<dialog>`, как «Новый чат».
 */
export function FoldersDialog({ folders, chats, editId = null, onChange, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [editing, setEditing] = useState<ChatFolder | 'new' | null>(
    editId != null ? folders.find((f) => f.id === editId) ?? null : null,
  );
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

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current) dialog.current.close();
  }

  async function run(action: () => Promise<ChatFolder[]>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const reload = async () => (await api.folders()).folders;

  // Готовые папки, которых ещё нет, — сверяем по имени, с которым их создали.
  const suggested = PRESETS.filter((p) => !folders.some((f) => f.title === p.title));

  function move(index: number, step: -1 | 1) {
    const ids = folders.map((f) => f.id);
    const to = index + step;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    void run(async () => (await api.reorderFolders(ids)).folders);
  }

  return (
    <dialog className="sheet folders-sheet" ref={dialog} onClick={backdrop} aria-labelledby={titleId}>
      {editing ? (
        <FolderEditor
          folder={editing === 'new' ? null : editing}
          chats={chats}
          busy={busy}
          error={error}
          onCancel={() => {
            setError(null);
            setEditing(null);
          }}
          onSave={async (input) => {
            const ok = await run(async () => {
              if (editing === 'new') await api.createFolder(input);
              else await api.updateFolder(editing.id, input);
              return reload();
            });
            if (ok) setEditing(null);
          }}
        />
      ) : (
        <>
          <h2 className="sheet-title" id={titleId}>
            Папки
          </h2>
          <p className="sheet-subject">
            Вкладки над списком чатов. Папка собирает чаты по виду или тех, что вы добавили в неё сами.
          </p>
          {error && <p className="error">{error}</p>}

          {folders.length > 0 && (
            <ul className="folder-list">
              {folders.map((f, i) => (
                <li key={f.id}>
                  <span className="folder-list-name">
                    <strong>{f.title}</strong>
                    <span>{describe(f)}</span>
                  </span>
                  <span className="folder-list-actions">
                    <button className="icon-btn" type="button" aria-label={`Выше: ${f.title}`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                      <Icon name="chevron-down" className="flip" />
                    </button>
                    <button className="icon-btn" type="button" aria-label={`Ниже: ${f.title}`} disabled={busy || i === folders.length - 1} onClick={() => move(i, 1)}>
                      <Icon name="chevron-down" />
                    </button>
                    <button className="icon-btn" type="button" aria-label={`Изменить: ${f.title}`} disabled={busy} onClick={() => setEditing(f)}>
                      <Icon name="edit" />
                    </button>
                    <button
                      className="icon-btn danger"
                      type="button"
                      aria-label={`Удалить: ${f.title}`}
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Удалить папку «${f.title}»? Сами чаты останутся на месте.`)) return;
                        void run(async () => {
                          await api.deleteFolder(f.id);
                          return reload();
                        });
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {suggested.length > 0 && folders.length < FOLDER_LIMIT && (
            <>
              {folders.length > 0 && <p className="folder-presets-title">Готовые папки</p>}
              <ul className="folder-presets">
                {suggested.map((p) => (
                  <li key={p.title}>
                    <span>
                      <strong>{p.title}</strong>
                      <span>{p.hint}</span>
                    </span>
                    <button
                      className="btn small"
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await api.createFolder({ title: p.title, types: p.types });
                        return reload();
                      })}
                    >
                      Добавить
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="sheet-foot">
            <button className="btn ghost" type="button" onClick={() => dialog.current?.close()}>
              Готово
            </button>
            <button className="btn" type="button" disabled={busy || folders.length >= FOLDER_LIMIT} onClick={() => setEditing('new')}>
              Новая папка
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

/** «Личные и группы, без приглушённых, + 2 чата» — что в папке, одной строкой. */
function describe(f: ChatFolder) {
  const parts = f.types.map((t) => KIND_LABELS[t].toLowerCase());
  let text = parts.length ? parts.join(' и ') : 'выбранные чаты';
  if (f.excludeMuted) text += ', без приглушённых';
  if (f.excludeRead) text += ', только непрочитанные';
  if (f.types.length && f.include.length) text += `, и ещё ${f.include.length}`;
  const out = text.charAt(0).toUpperCase() + text.slice(1);
  return out;
}

/* ─ Редактор папки ─────────────────────────────────────────────────────── */

type EditorProps = {
  folder: ChatFolder | null;
  chats: FolderChat[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (input: Omit<ChatFolder, 'id'>) => Promise<void>;
};

function FolderEditor({ folder, chats, busy, error, onCancel, onSave }: EditorProps) {
  const id = useId();
  const [draft, setDraft] = useState<ChatFolder>(
    folder ?? { id: 0, title: '', types: [], include: [], exclude: [], excludeMuted: false, excludeRead: false },
  );
  const [local, setLocal] = useState<string | null>(null);

  function toggleType(kind: PrefKind, on: boolean) {
    setDraft((d) => ({ ...d, types: on ? [...d.types, kind] : d.types.filter((t) => t !== kind) }));
  }

  function toggleChat(chat: FolderChat, on: boolean) {
    setDraft((d) => ({ ...d, ...toggleInFolder(d, chat, on) }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.title.trim()) {
      setLocal('У папки должно быть название.');
      return;
    }
    if (draft.types.length === 0 && draft.include.length === 0) {
      setLocal('Выберите виды чатов или отметьте хотя бы один чат.');
      return;
    }
    setLocal(null);
    const { id: _ignored, ...input } = draft;
    await onSave({ ...input, title: draft.title.trim() });
  }

  const inside = chats.filter((c) => inFolder(draft, c)).length;

  return (
    <form onSubmit={submit}>
      <h2 className="sheet-title">{folder ? 'Папка' : 'Новая папка'}</h2>
      {(local || error) && <p className="error">{local ?? error}</p>}

      <label className="field" htmlFor={`${id}-title`}>
        <span>Название</span>
        <input
          id={`${id}-title`}
          type="text"
          value={draft.title}
          maxLength={TITLE_MAX}
          placeholder="Например: Работа"
          autoFocus
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
      </label>

      <fieldset className="folder-fieldset">
        <legend>Все чаты вида</legend>
        {(Object.keys(KIND_LABELS) as PrefKind[]).map((kind) => (
          <label key={kind} className="check">
            <input type="checkbox" checked={draft.types.includes(kind)} onChange={(e) => toggleType(kind, e.target.checked)} />
            {KIND_LABELS[kind]}
          </label>
        ))}
      </fieldset>

      <fieldset className="folder-fieldset">
        <legend>Скрывать</legend>
        <label className="check">
          <input type="checkbox" checked={draft.excludeMuted} onChange={(e) => setDraft((d) => ({ ...d, excludeMuted: e.target.checked }))} />
          Приглушённые
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.excludeRead} onChange={(e) => setDraft((d) => ({ ...d, excludeRead: e.target.checked }))} />
          Прочитанные
        </label>
      </fieldset>

      <fieldset className="folder-fieldset">
        <legend>
          Чаты в папке: {inside} из {chats.length}
        </legend>
        <ul className="folder-chats">
          {chats.map((c) => (
            <li key={`${c.kind}-${c.id}`}>
              <label className="folder-chat">
                <input type="checkbox" checked={inFolder(draft, c)} onChange={(e) => toggleChat(c, e.target.checked)} />
                {c.avatar}
                <span>{c.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="sheet-foot">
        <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
          Назад
        </button>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>
    </form>
  );
}

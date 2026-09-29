import { type Attachment, type ChatFolder, type FolderInput, type PinnedPreview, type PrefKind } from '../../api';
import { type DbFolder, db, fail } from '../store';
import { attachmentLabelOf } from './messages';

/** Папки чатов и закреплённые сообщения. */

export const toFolder = ({ userId: _owner, ...f }: DbFolder): ChatFolder => ({ ...f, types: [...f.types], include: [...f.include], exclude: [...f.exclude] });

export const myFolders = (userId: number) => db.folders.filter((f) => f.userId === userId).map(toFolder);

/** Те же правила, что на сервере: имя 1–12, виды из трёх, исключение побеждает. */
export function checkFolder(input: FolderInput, current: ChatFolder | null): Omit<ChatFolder, 'id'> {
  const title = input.title === undefined && current ? current.title : (input.title ?? '').trim();
  if (!title) fail(400, '«название папки»: минимум 1 символов');
  if (title.length > 12) fail(400, '«название папки»: максимум 12 символов');
  const types = input.types ?? current?.types ?? [];
  if (types.some((x) => !['dm', 'chat', 'channel'].includes(x))) fail(400, 'Виды чатов — dm, chat или channel');
  const exclude = input.exclude ?? current?.exclude ?? [];
  const include = (input.include ?? current?.include ?? []).filter(
    (x) => !exclude.some((e) => e.kind === x.kind && e.id === x.id),
  );
  if (types.length === 0 && include.length === 0) fail(400, 'В папке должны быть виды чатов или хотя бы один чат');
  return {
    title,
    types: [...new Set(types)],
    include,
    exclude,
    excludeMuted: input.excludeMuted ?? current?.excludeMuted ?? false,
    excludeRead: input.excludeRead ?? current?.excludeRead ?? false,
  };
}

export const pinScope = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;

export const pinnedOf = (kind: PrefKind, scope: string | number) => db.pins.find((x) => x.kind === kind && x.scope === String(scope));

export const setPin = (kind: PrefKind, scope: string | number, messageId: number | null) => {
  db.pins = db.pins.filter((x) => !(x.kind === kind && x.scope === String(scope)));
  if (messageId != null) db.pins.push({ kind, scope: String(scope), messageId });
};

/** Закреплённое глазами смотрящего: не нашлось среди видимых — полосы нет. */
export function pinPreview(kind: PrefKind, scope: string | number, visible: { id: number; body: string; attachment: Attachment | null }[]): PinnedPreview | null {
  const pin = pinnedOf(kind, scope);
  const m = pin ? visible.find((x) => x.id === pin.messageId) : undefined;
  return m ? { id: m.id, body: m.body || attachmentLabelOf(m.attachment), attachmentKind: m.attachment?.kind ?? null } : null;
}

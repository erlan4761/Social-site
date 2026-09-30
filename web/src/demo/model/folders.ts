import { type Attachment, type ChatFolder, type FolderInput, type PinnedPreview, type PinsPayload, type PrefKind } from '../../api';
import { type DbFolder, db, fail } from '../store';
import { attachmentLabelOf } from './messages';
import { plainText } from '../../components/chat/markup';

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

/** Закреплённые переписки — свежие по сообщению сверху, как pins.js. */
const pinnedIdsOf = (kind: PrefKind, scope: string | number) =>
  db.pins.filter((x) => x.kind === kind && x.scope === String(scope)).map((x) => x.messageId).sort((a, b) => b - a);

export const PINS_MAX = 20;

export function addPin(kind: PrefKind, scope: string | number, messageId: number) {
  const ids = pinnedIdsOf(kind, scope);
  if (ids.includes(messageId)) return;
  if (ids.length >= PINS_MAX) fail(400, `Закреплено уже ${PINS_MAX} — открепите что-нибудь`);
  db.pins.push({ kind, scope: String(scope), messageId });
}

/** Открепить одно (`messageId`) или все. */
export const removePin = (kind: PrefKind, scope: string | number, messageId: number | null = null) => {
  db.pins = db.pins.filter((x) => !(x.kind === kind && x.scope === String(scope) && (messageId == null || x.messageId === messageId)));
};

/** Закреплённые глазами смотрящего: не нашлось среди видимых — для него его нет. */
export function pinsPayload(kind: PrefKind, scope: string | number, visible: { id: number; body: string; attachment: Attachment | null }[]): PinsPayload {
  const pins: PinnedPreview[] = [];
  for (const id of pinnedIdsOf(kind, scope)) {
    const m = visible.find((x) => x.id === id);
    if (m) pins.push({ id: m.id, body: m.body ? plainText(m.body) : attachmentLabelOf(m.attachment), attachmentKind: m.attachment?.kind ?? null });
  }
  return { pinned: pins[0] ?? null, pins };
}

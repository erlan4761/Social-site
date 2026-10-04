import { type FolderInput, type PrefKind } from '../../api';
import { type DbFolder, db, id, tick, fail } from '../store';
import { byName, requireMe } from '../model/people';
import { toFolder, myFolders, checkFolder } from '../model/folders';
import { prefOf } from '../model/notifications';
import { memberRow } from '../model/chats';
import { channelBy, subOf } from '../model/channels';

/** Методы витрины: папки чатов и настройки чата в списке. */

/** Имена тем — как CHAT_THEMES на сервере. */
const DEMO_THEMES = ['gold', 'sea', 'forest', 'dusk', 'rose', 'plain'];

/** Чат настройки глазами человека: нет доступа — null (404). */
function prefTarget(kind: PrefKind, target: string | number, userId: number): number | null {
  if (kind === 'dm') return byName(String(target))?.id ?? null;
  if (kind === 'chat') return memberRow(Number(target), userId) ? Number(target) : null;
  const c = channelBy(String(target));
  return c && subOf(c.id, userId) ? c.id : null;
}

export const foldersApi = {
  // ─ Папки чатов ────────────────────────────────────────────────────────

  folders: () => {
    const u = requireMe()!;
    return tick({ folders: myFolders(u.id) });
  },

  createFolder: (input: FolderInput) => {
    const u = requireMe()!;
    if (myFolders(u.id).length >= 10) fail(400, 'Папок не больше 10');
    const f: DbFolder = { id: id(), userId: u.id, ...checkFolder(input, null) };
    db.folders.push(f);
    return tick({ folder: toFolder(f) });
  },

  updateFolder: (folderId: number, input: FolderInput) => {
    const u = requireMe()!;
    const f = db.folders.find((x) => x.id === folderId && x.userId === u.id);
    if (!f) fail(404, 'Папка не найдена');
    Object.assign(f!, checkFolder(input, f!));
    return tick({ folder: toFolder(f!) });
  },

  deleteFolder: (folderId: number) => {
    const u = requireMe()!;
    if (!db.folders.some((x) => x.id === folderId && x.userId === u.id)) fail(404, 'Папка не найдена');
    db.folders = db.folders.filter((x) => x.id !== folderId);
    return tick({ ok: true as const });
  },

  reorderFolders: (ids: number[]) => {
    const u = requireMe()!;
    const mine = myFolders(u.id).map((f) => f.id);
    if (ids.length !== mine.length || [...ids].sort().join() !== [...mine].sort().join()) {
      fail(400, 'Порядок — полный список ваших папок');
    }
    const others = db.folders.filter((f) => f.userId !== u.id);
    db.folders = [...others, ...ids.map((fid) => db.folders.find((f) => f.id === fid)!)];
    return tick({ folders: myFolders(u.id) });
  },

  getPref: (kind: PrefKind, target: string | number) => {
    const u = requireMe()!;
    const targetId = prefTarget(kind, target, u.id);
    if (targetId == null) fail(404, 'Чат не найден');
    const pref = prefOf(u.id, kind, targetId!);
    return tick({ pinned: Boolean(pref?.pinnedAt), muted: Boolean(pref?.muted), archived: pref?.archivedAt != null, theme: pref?.theme ?? null });
  },

  setPref: (kind: PrefKind, target: string | number, input: { pinned?: boolean; muted?: boolean; archived?: boolean; theme?: string | null }) => {
    const u = requireMe()!;
    let targetId: number | null = null;
    if (kind === 'dm') {
      const other = byName(String(target));
      targetId = other?.id ?? null;
    } else if (kind === 'chat') {
      targetId = memberRow(Number(target), u.id) ? Number(target) : null;
    } else {
      const c = channelBy(String(target));
      targetId = c && subOf(c.id, u.id) ? c.id : null;
    }
    if (targetId == null) fail(404, 'Чат не найден');

    const current = prefOf(u.id, kind, targetId!);
    if (input.pinned && !current?.pinnedAt && db.prefs.filter((x) => x.userId === u.id && x.pinnedAt).length >= 5) {
      fail(400, 'Закрепить можно не больше 5 чатов');
    }
    const pinnedAt = input.pinned === undefined
      ? current?.pinnedAt ?? null
      : input.pinned ? current?.pinnedAt ?? new Date().toISOString() : null;
    const muted = input.muted === undefined ? Boolean(current?.muted) : input.muted;
    const archivedAt = input.archived === undefined
      ? current?.archivedAt ?? null
      : input.archived ? new Date().toISOString() : null;

    if (input.theme !== undefined && input.theme !== null && input.theme !== 'default' && !DEMO_THEMES.includes(input.theme)) fail(400, 'Такой темы нет');
    const theme = input.theme === undefined ? current?.theme ?? null : input.theme === 'default' ? null : input.theme;

    db.prefs = db.prefs.filter((x) => x !== current);
    if (pinnedAt || muted || archivedAt || theme) db.prefs.push({ userId: u.id, kind, targetId: targetId!, pinnedAt, muted, archivedAt, theme });
    return tick({ pinned: Boolean(pinnedAt), muted, archived: archivedAt != null, theme });
  },
};

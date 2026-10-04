import type { ChatFolder, ChatRef, PrefKind } from './api';

/**
 * Правила папок — какие чаты в папку попадают. Считаются здесь, на клиенте:
 * список чатов уже загружен целиком, а сервер хранит только само правило.
 * Порядок проверки — как в Телеграме: исключённый вручную не попадает никогда,
 * добавленный вручную попадает всегда, остальные — по виду; фильтры «без
 * приглушённых» и «только непрочитанные» применяются ко всем, кроме добавленных.
 */

/** Чат глазами папки: вид, id, непрочитанное и приглушён ли. */
export type FolderRow = { kind: PrefKind; id: number; unread: number; muted: boolean };

const same = (a: ChatRef, b: ChatRef) => a.kind === b.kind && a.id === b.id;

export function inFolder(folder: ChatFolder, row: FolderRow): boolean {
  if (folder.exclude.some((x) => same(x, row))) return false;
  if (folder.include.some((x) => same(x, row))) return true;
  if (!folder.types.includes(row.kind)) return false;
  if (folder.excludeMuted && row.muted) return false;
  if (folder.excludeRead && row.unread === 0) return false;
  return true;
}

/** Счётчик на вкладке папки — сколько чатов в ней ждут ответа, как в Телеграме:
 *  чатов, а не сообщений, и без приглушённых. */
export const folderUnread = (folder: ChatFolder, rows: FolderRow[]) =>
  rows.filter((r) => !r.muted && r.unread > 0 && inFolder(folder, r)).length;

/**
 * Положить чат в папку или убрать из неё — меняя списки так, как это понял бы
 * человек: подходящий по виду убирается исключением, неподходящий кладётся
 * добавлением. Возвращает новые include и exclude — целиком, как их ждёт сервер.
 */
export function toggleInFolder(folder: ChatFolder, row: FolderRow, on: boolean) {
  const include = folder.include.filter((x) => !same(x, row));
  const exclude = folder.exclude.filter((x) => !same(x, row));
  const ref = { kind: row.kind, id: row.id };
  if (on) {
    // Подходит по правилу — достаточно снять исключение; нет — добавить явно.
    const byRule = { ...folder, include, exclude };
    if (!inFolder(byRule, row)) include.push(ref);
  } else if (inFolder({ ...folder, include, exclude }, row)) {
    exclude.push(ref);
  }
  return { include, exclude };
}

/** Готовые папки для первого раза — как предлагает Телеграм. */
export const PRESETS: { title: string; types: PrefKind[]; hint: string }[] = [
  { title: 'Личное', types: ['dm'], hint: 'Все личные переписки' },
  { title: 'Группы', types: ['chat'], hint: 'Все групповые чаты' },
  { title: 'Каналы', types: ['channel'], hint: 'Все каналы, на которые вы подписаны' },
];

export const KIND_LABELS: Record<PrefKind, string> = { dm: 'Личные', chat: 'Группы', channel: 'Каналы' };

/** Вкладка списка: папка (id), встроенные «Непрочитанные» или «Все» (null). */
export type ActiveTab = number | 'unread' | null;

/** Выбранная вкладка — удобство одного браузера, не данные: localStorage. */
const KEY = 'chronicle-folder';
export function readActiveFolder(): ActiveTab {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'unread') return 'unread';
    const v = Number(raw);
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function writeActiveFolder(id: ActiveTab) {
  try {
    if (id == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(id));
  } catch {
    /* хранилище недоступно — вкладка просто не запомнится */
  }
}

/**
 * Встроенная вкладка «Непрочитанные», как в Телеграме: чаты, где есть
 * непрочитанное, включая приглушённые. Открытый сейчас чат остаётся в списке,
 * пока его читают, — иначе он исчезал бы из-под пальца в момент открытия.
 */
export const inUnread = (row: FolderRow, open = false) => row.unread > 0 || open;

/** Счётчик на вкладке «Непрочитанные» — как у папок: чатов, без приглушённых. */
export const unreadChats = (rows: FolderRow[]) => rows.filter((r) => !r.muted && r.unread > 0).length;

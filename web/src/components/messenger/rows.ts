import type { ChannelSummary, ChatSummary, Conversation } from '../../api';
import type { FolderRow } from '../../folders';

/* ─ Список чатов как данные ─────────────────────────────────────────────
   Три вида переписки в одном списке, поиск по нему и взгляд папки на строку. */

/** Личная переписка, групповой чат и канал живут в разных пространствах API,
 *  но в списке стоят вперемешку: разница — дело сервера, а не человека,
 *  который ищет вчерашний разговор. */
export type Row =
  | { kind: 'dm'; key: string; at: string; name: string; item: Conversation }
  | { kind: 'chat'; key: string; at: string; name: string; item: ChatSummary }
  | { kind: 'channel'; key: string; at: string; name: string; item: ChannelSummary };

/** Имя «Избранного» в списке, поиске и шапке — переписки с самим собой. */
export const SAVED_TITLE = 'Избранное';

export function rows(conversations: Conversation[], chats: ChatSummary[], channels: ChannelSummary[], meId?: number): Row[] {
  const dm: Row[] = conversations.map((c) => ({
    kind: 'dm',
    key: `dm-${c.user.id}`,
    at: c.lastMessage.createdAt,
    name: c.user.id === meId ? SAVED_TITLE : c.user.displayName,
    item: c,
  }));
  // Чат и канал без сообщений встают по дате создания — иначе только что
  // созданные оказались бы в самом низу.
  const group: Row[] = chats.map((c) => ({
    kind: 'chat',
    key: `chat-${c.id}`,
    at: c.lastMessage?.createdAt ?? c.createdAt,
    name: c.title,
    item: c,
  }));
  const channel: Row[] = channels.map((c) => ({
    kind: 'channel',
    key: `channel-${c.id}`,
    at: c.lastPost?.createdAt ?? c.createdAt,
    name: c.title,
    item: c,
  }));
  // Закреплённые — наверху, в том порядке, в каком их закрепляли; остальные —
  // по свежести, как всегда.
  return [...dm, ...group, ...channel].sort((a, b) => {
    const pa = a.item.pinnedAt;
    const pb = b.item.pinnedAt;
    if (pa && pb) return pa.localeCompare(pb);
    if (pa || pb) return pa ? -1 : 1;
    return b.at.localeCompare(a.at);
  });
}

export const fold = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');

export function matches(row: Row, q: string) {
  if (fold(row.name).includes(q)) return true;
  if (row.kind === 'dm') return fold(row.item.user.username).includes(q);
  if (row.kind === 'channel') return row.item.handle.includes(q.replace(/^@/, ''));
  return false;
}

/** Строка списка глазами папки: вид, id, непрочитанное, приглушён ли. */
export function folderRow(row: Row): FolderRow {
  return {
    kind: row.kind,
    id: row.kind === 'dm' ? row.item.user.id : row.item.id,
    unread: row.item.unread,
    muted: row.item.muted,
  };
}

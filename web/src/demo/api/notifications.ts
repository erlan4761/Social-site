import { type Badges } from '../../api';
import { db, tick, fail } from '../store';
import { requireMe } from '../model/people';
import { PAGE } from '../model/posts';
import { mutedFor, dmUnreadTotal, markNotificationsRead, unreadNotifications, toNotification } from '../model/notifications';
import { chatUnread } from '../model/chats';
import { channelUnread } from '../model/channels';

/** Методы витрины: события и счётчики. */

export const notificationsApi = {
  // ─ Уведомления и счётчики ─────────────────────────────────────────────

  notifications: (cursor?: number | null) => {
    const u = requireMe()!;
    let list = db.notifications.filter((n) => n.userId === u.id).sort((a, b) => b.id - a.id);
    if (cursor != null) list = list.filter((n) => n.id < cursor);

    const page = list.slice(0, PAGE);
    return tick({
      notifications: page.map(toNotification),
      nextCursor: list.length > PAGE ? page.at(-1)!.id : null,
      // Общее число непрочитанных, а не число непрочитанных на странице.
      unread: unreadNotifications(u.id),
    });
  },

  readAllNotifications: () => {
    const u = requireMe()!;
    markNotificationsRead({ userId: u.id });
    return tick({ ok: true as const, unread: 0 });
  },

  readNotification: (notificationId: number) => {
    const u = requireMe()!;
    const n = db.notifications.find((x) => x.id === notificationId && x.userId === u.id);
    // Чужое и несуществующее — одинаково 404: посторонний не должен узнавать,
    // что такое событие вообще есть.
    if (!n) fail(404, 'Событие не найдено');
    if (!n!.readAt) n!.readAt = new Date().toISOString();
    return tick({ ok: true as const, unread: unreadNotifications(u.id) });
  },

  badges: (): Promise<Badges> => {
    const u = requireMe()!;
    return tick({
      messages: dmUnreadTotal(u.id),
      chats: db.chatMembers
        .filter((m) => m.userId === u.id)
        .filter((m) => !mutedFor(u.id, 'chat', m.chatId))
        .reduce((sum, m) => sum + chatUnread(m.chatId, u.id), 0),
      channels: db.channelSubs
        .filter((s) => s.userId === u.id)
        .filter((s) => !mutedFor(u.id, 'channel', s.channelId))
        .reduce((sum, s) => sum + channelUnread(s), 0),
      notifications: unreadNotifications(u.id),
    });
  },
};

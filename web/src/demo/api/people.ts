import { type BlockedUser, type ReportReason, type ReportTargetType } from '../../api';
import { type DbUser, db, tick, fail } from '../store';
import { byId, byName, requireMe, author, blockedPair, hidden } from '../model/people';
import { publicUser } from '../model/posts';
import { notify, dropNotification } from '../model/notifications';

/** Методы витрины: профиль, аватар, поиск людей, подписки, блокировки, жалобы. */

export const peopleApi = {
  profile: (username: string) => {
    const u = byName(username);
    if (!u) fail(404, 'Пользователь не найден');
    const target = u!;
    // Профиль отдаётся всегда, но с флагами: записей у заблокированного будет
    // ноль, подписаться нельзя, написать нельзя.
    return tick({
      user: {
        ...publicUser(target),
        blockedByMe: db.blocks.some((b) => b.blockerId === db.meId && b.blockedId === target.id),
        blocksMe: db.blocks.some((b) => b.blockerId === target.id && b.blockedId === db.meId),
      },
    });
  },

  updateProfile: (input: { displayName: string; bio: string }) => {
    const u = requireMe()!;
    if (!input.displayName.trim()) fail(400, '«имя»: минимум 1 символов');
    if (input.bio.length > 200) fail(400, '«о себе»: максимум 200 символов');
    u.displayName = input.displayName.trim();
    u.bio = input.bio.trim();
    return tick({ user: publicUser(u) });
  },

  setAvatar: (file: File) => {
    const u = requireMe()!;
    u.avatarUrl = URL.createObjectURL(file);
    return tick({ user: publicUser(u) });
  },

  removeAvatar: () => {
    const u = requireMe()!;
    u.avatarUrl = null;
    return tick({ user: publicUser(u) });
  },

  searchUsers: (q: string) => {
    const query = q.trim().toLowerCase();
    if (!query) return tick({ users: [] });

    // Обе стороны блокировки выпадают из выдачи друг у друга.
    const scored = db.users
      .filter((u) => !hidden(u.id))
      .map((u) => {
        const username = u.username.toLowerCase();
        const displayName = u.displayName.toLowerCase();
        let rank: number | null = null;
        if (username === query) rank = 0;
        else if (username.startsWith(query)) rank = 1;
        else if (displayName.startsWith(query)) rank = 2;
        else if (username.includes(query) || displayName.includes(query)) rank = 3;
        return rank === null ? null : { u, rank };
      })
      .filter((x): x is { u: DbUser; rank: number } => x !== null)
      .sort((a, b) => a.rank - b.rank || a.u.username.localeCompare(b.u.username))
      .slice(0, 20);

    return tick({ users: scored.map(({ u }) => author(u)) });
  },

  setFollow: (username: string, following: boolean) => {
    const u = requireMe()!;
    const target = byName(username);
    if (!target) fail(404, 'Пользователь не найден');
    if (target!.id === u.id) fail(400, 'Нельзя подписаться на себя');
    if (blockedPair(u.id, target!.id)) fail(400, 'Действие с этим пользователем недоступно');

    db.follows = db.follows.filter((f) => !(f.followerId === u.id && f.followeeId === target!.id));
    if (following) db.follows.push({ followerId: u.id, followeeId: target!.id });

    const event = { userId: target!.id, actorId: u.id, kind: 'follow' as const };
    if (following) notify(event);
    else dropNotification(event);

    return tick({
      followedByMe: following,
      followerCount: db.follows.filter((f) => f.followeeId === target!.id).length,
    });
  },

  // ─ Блокировки и жалобы ────────────────────────────────────────────────

  setBlock: (username: string, blocked: boolean) => {
    const u = requireMe()!;
    const target = byName(username);
    if (!target) fail(404, 'Пользователь не найден');
    if (target!.id === u.id) fail(400, 'Нельзя заблокировать себя');
    const other = target!;

    db.blocks = db.blocks.filter((b) => !(b.blockerId === u.id && b.blockedId === other.id));

    if (blocked) {
      db.blocks.push({ blockerId: u.id, blockedId: other.id, createdAt: new Date().toISOString() });
      // Иначе заблокированный остался бы в подписчиках, а его лайки — в
      // счётчике событий. Непрочитанные события чистятся в обе стороны:
      // те, что от него, — шум, а те, что о нём, вели бы на скрытую запись.
      db.follows = db.follows.filter(
        (f) => !((f.followerId === u.id && f.followeeId === other.id)
          || (f.followerId === other.id && f.followeeId === u.id)),
      );
      db.notifications = db.notifications.filter(
        (n) => n.readAt !== null
          || !((n.userId === u.id && n.actorId === other.id) || (n.userId === other.id && n.actorId === u.id)),
      );
    }

    // Снятие ничего не восстанавливает: подписки и погашенные события назад
    // не возвращаются, зато контент виден сразу.
    return tick({ blockedByMe: blocked });
  },

  blockedUsers: () => {
    const u = requireMe()!;
    // Только те, кого заблокировал я: свежие сверху. Те, кто заблокировал
    // меня, сюда не попадают — это чужое решение, не моё.
    const list: BlockedUser[] = db.blocks
      .filter((b) => b.blockerId === u.id)
      .slice()
      .reverse()
      .map((b) => author(byId(b.blockedId)!));
    return tick({ users: list });
  },

  report: (input: {
    targetType: ReportTargetType;
    targetId: number;
    reason: ReportReason;
    note?: string;
  }) => {
    const u = requireMe()!;

    const types: ReportTargetType[] = ['post', 'comment', 'user'];
    if (!types.includes(input.targetType)) fail(400, 'Неизвестный тип объекта жалобы');

    const targetId = Number(input.targetId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) fail(400, 'Некорректный id объекта');

    const reasons: ReportReason[] = ['spam', 'abuse', 'adult', 'other'];
    if (!reasons.includes(input.reason)) fail(400, 'Причина: spam, abuse, adult или other');

    const note = (input.note ?? '').trim();
    if (note.length > 300) fail(400, '«комментарий»: максимум 300 символов');

    if (input.targetType === 'post' && !db.posts.some((p) => p.id === targetId)) fail(404, 'Пост не найден');
    if (input.targetType === 'comment' && !db.comments.some((c) => c.id === targetId)) fail(404, 'Комментарий не найден');
    if (input.targetType === 'user') {
      if (!byId(targetId)) fail(404, 'Пользователь не найден');
      if (targetId === u.id) fail(400, 'Нельзя пожаловаться на себя');
    }

    const already = db.reports.some(
      (r) => r.reporterId === u.id && r.targetType === input.targetType && r.targetId === targetId,
    );

    if (!already) {
      db.reports.push({
        reporterId: u.id, targetType: input.targetType, targetId,
        reason: input.reason, note, createdAt: new Date().toISOString(),
      });
      // Панели модератора в проекте нет, и жалоба честно уходит в лог — на
      // сервере в консоль процесса, здесь в консоль вкладки. Повтор не
      // печатается: это второй клик, а не второй сигнал.
      console.warn(
        `⚑ Жалоба: @${u.username} → ${input.targetType} #${targetId}, причина «${input.reason}»`
        + (note ? `, комментарий: ${note}` : ''),
      );
    }

    return tick({ ok: true as const, alreadyReported: already });
  },
};

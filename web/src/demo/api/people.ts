import { type BlockedUser, type ReportReason, type ReportTargetType } from '../../api';
import { type DbUser, db, tick, fail } from '../store';
import { byId, byName, requireMe, author, blockedPair, hidden, canSeeAuthor } from '../model/people';
import { publicUser, toPost } from '../model/posts';
import { notify, dropNotification } from '../model/notifications';
import { findByPhones, visiblePhone } from '../model/phoneBook';
import { normalizeLinks } from '../../profileLinks';

/** Методы витрины: профиль, аватар, поиск людей, подписки, блокировки, жалобы. */

/** Подписчики или подписки — как followList() в routes/users.js: свежие сверху, по 50, без скрытых. */
function followListOf(username: string, side: 'followers' | 'following', cursor?: number | null) {
  const owner = byName(username);
  if (!owner) fail(404, 'Пользователь не найден');
  const meId = db.meId;
  if (meId != null && blockedPair(meId, owner!.id)) return tick({ users: [], nextCursor: null as number | null });
  // Курсор — номер строки подписки, как rowid на сервере.
  const rows = db.follows
    .map((f, seq) => ({ f, seq: seq + 1 }))
    .filter(({ f }) => (side === 'followers' ? f.followeeId : f.followerId) === owner!.id)
    .filter(({ seq }) => cursor == null || seq < cursor)
    .reverse()
    .map(({ f, seq }) => ({ seq, person: byId(side === 'followers' ? f.followerId : f.followeeId)! }))
    .filter(({ person }) => person && !hidden(person.id));
  const page = rows.slice(0, 50);
  return tick({
    users: page.map(({ person }) => ({
      ...author(person), bio: person.bio, createdAt: person.createdAt,
      followedByMe: db.follows.some((x) => x.followerId === meId && x.followeeId === person.id),
    })),
    nextCursor: rows.length > 50 ? page[page.length - 1].seq : null,
  });
}

export const peopleApi = {
  profile: (username: string) => {
    const u = byName(username);
    if (!u) fail(404, 'Пользователь не найден');
    const target = u!;
    // Профиль отдаётся всегда, но с флагами: записей у заблокированного будет
    // ноль, подписаться нельзя, написать нельзя.
    const pinnedPost = target.pinnedPostId != null && !hidden(target.id) && canSeeAuthor(db.meId, target.id)
      ? db.posts.find((x) => x.id === target.pinnedPostId)
      : undefined;
    return tick({
      pinnedPost: pinnedPost ? toPost(pinnedPost) : null,
      user: {
        ...publicUser(target),
        blockedByMe: db.blocks.some((b) => b.blockerId === db.meId && b.blockedId === target.id),
        blocksMe: db.blocks.some((b) => b.blockerId === target.id && b.blockedId === db.meId),
        phone: visiblePhone(target, db.meId),
        private: Boolean(target.private),
        canSeePosts: canSeeAuthor(db.meId, target.id),
        requestedByMe: db.followRequests.some((r) => r.requesterId === db.meId && r.targetId === target.id),
      },
    });
  },

  updateProfile: (input: { displayName: string; bio: string; links?: string[] }) => {
    const u = requireMe()!;
    if (!input.displayName.trim()) fail(400, '«имя»: минимум 1 символов');
    if (input.bio.length > 200) fail(400, '«о себе»: максимум 200 символов');
    if (input.links !== undefined) {
      const checked = normalizeLinks(input.links);
      if ('error' in checked) fail(400, checked.error);
      else u.links = checked.links;
    }
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

  setCover: (file: File) => {
    const u = requireMe()!;
    if (!file.type.startsWith('image/')) fail(400, 'Обложка — только изображение');
    u.coverUrl = URL.createObjectURL(file);
    return tick({ user: publicUser(u) });
  },

  removeCover: () => {
    const u = requireMe()!;
    u.coverUrl = null;
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

  findByPhone: (phones: string[]) => {
    const u = requireMe()!;
    if (!Array.isArray(phones) || phones.length === 0 || phones.length > 50) fail(400, 'Номера — списком строк, от 1 до 50');
    return tick({
      users: findByPhones(u.id, phones).map((x) => ({
        ...author(x),
        phone: x.phone!,
        followedByMe: db.follows.some((f) => f.followerId === u.id && f.followeeId === x.id),
      })),
    });
  },

  followers: (username: string, cursor?: number | null) => followListOf(username, 'followers', cursor),
  following: (username: string, cursor?: number | null) => followListOf(username, 'following', cursor),

  // Тот же порядок, что /users/suggestions: кого читают ваши подписки, затем
  // самые читаемые, затем кто писал недавно; только те, кто что-то написал.
  suggestions: () => {
    const meId = db.meId;
    const mine = db.follows.filter((f) => f.followerId === meId).map((f) => f.followeeId);
    const users = db.users
      .filter((u) => u.id !== meId && !u.bannedAt && !hidden(u.id))
      .filter((u) => !mine.includes(u.id) && db.posts.some((p) => p.authorId === u.id))
      .map((u) => {
        const via = db.follows.filter((f) => f.followeeId === u.id && mine.includes(f.followerId));
        const name = via.length ? byId(via.at(-1)!.followerId)?.displayName ?? null : null;
        return {
          ...author(u), bio: u.bio, createdAt: u.createdAt, followedByMe: false,
          followerCount: db.follows.filter((f) => f.followeeId === u.id).length,
          mutualCount: via.length, mutualName: name,
          lastPost: Math.max(...db.posts.filter((p) => p.authorId === u.id).map((p) => p.id)),
        };
      })
      .sort((a, b) => b.mutualCount - a.mutualCount || b.followerCount - a.followerCount || b.lastPost - a.lastPost)
      .slice(0, 5)
      .map(({ lastPost: _, ...rest }) => rest);
    return tick({ users });
  },

  setFollow: (username: string, following: boolean) => {
    const u = requireMe()!;
    const target = byName(username);
    if (!target) fail(404, 'Пользователь не найден');
    if (target!.id === u.id) fail(400, 'Нельзя подписаться на себя');
    if (blockedPair(u.id, target!.id)) fail(400, 'Действие с этим пользователем недоступно');

    // Закрытый профиль: не подписка, а заявка — как на сервере.
    const already = db.follows.some((f) => f.followerId === u.id && f.followeeId === target!.id);
    if (following && target!.private && !already) {
      if (!db.followRequests.some((r) => r.requesterId === u.id && r.targetId === target!.id)) {
        db.followRequests.push({ requesterId: u.id, targetId: target!.id, createdAt: new Date().toISOString() });
      }
      notify({ userId: target!.id, actorId: u.id, kind: 'follow_request' });
      return tick({
        followedByMe: false,
        requested: true,
        followerCount: db.follows.filter((f) => f.followeeId === target!.id).length,
      });
    }
    if (!following) {
      db.followRequests = db.followRequests.filter((r) => !(r.requesterId === u.id && r.targetId === target!.id));
      dropNotification({ userId: target!.id, actorId: u.id, kind: 'follow_request' });
    }

    db.follows = db.follows.filter((f) => !(f.followerId === u.id && f.followeeId === target!.id));
    if (following) db.follows.push({ followerId: u.id, followeeId: target!.id });

    const event = { userId: target!.id, actorId: u.id, kind: 'follow' as const };
    if (following) notify(event);
    else dropNotification(event);

    return tick({
      followedByMe: following,
      requested: false,
      followerCount: db.follows.filter((f) => f.followeeId === target!.id).length,
    });
  },

  // ─ Закрытый профиль и заявки — как routes/users.js и account.js ─────────

  followRequests: () => {
    const u = requireMe()!;
    const users = db.followRequests
      .filter((r) => r.targetId === u.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => {
        const who = byId(r.requesterId)!;
        return { ...author(who), bio: who.bio, createdAt: who.createdAt, requestedAt: r.createdAt };
      });
    return tick({ users });
  },

  acceptFollowRequest: (username: string) => {
    const u = requireMe()!;
    const who = byName(username);
    if (!who || !db.followRequests.some((r) => r.requesterId === who.id && r.targetId === u.id)) fail(404, 'Заявки нет');
    acceptRequest(who!.id, u.id);
    return tick({ ok: true as const, followerCount: db.follows.filter((f) => f.followeeId === u.id).length });
  },

  declineFollowRequest: (username: string) => {
    const u = requireMe()!;
    const who = byName(username);
    if (!who || !db.followRequests.some((r) => r.requesterId === who.id && r.targetId === u.id)) fail(404, 'Заявки нет');
    db.followRequests = db.followRequests.filter((r) => !(r.requesterId === who!.id && r.targetId === u.id));
    dropNotification({ userId: u.id, actorId: who!.id, kind: 'follow_request' });
    return tick({ ok: true as const });
  },

  removeFollower: (username: string) => {
    const u = requireMe()!;
    const who = byName(username);
    if (!who) fail(404, 'Пользователь не найден');
    db.follows = db.follows.filter((f) => !(f.followerId === who!.id && f.followeeId === u.id));
    return tick({ ok: true as const, followerCount: db.follows.filter((f) => f.followeeId === u.id).length });
  },

  setPrivateProfile: (on: boolean) => {
    const u = requireMe()!;
    u.private = on;
    let accepted = 0;
    if (!on) {
      const pending = db.followRequests.filter((r) => r.targetId === u.id);
      for (const r of pending) acceptRequest(r.requesterId, u.id);
      accepted = pending.length;
    }
    return tick({ privateProfile: on, accepted });
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
      db.followRequests = db.followRequests.filter(
        (r) => !((r.requesterId === u.id && r.targetId === other.id) || (r.requesterId === other.id && r.targetId === u.id)),
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

    // Жалоба на то, что модератор уже разобрал, — снова открытая, как на сервере.
    db.reports = db.reports.filter(
      (r) => !(r.reporterId === u.id && r.targetType === input.targetType && r.targetId === targetId && r.resolvedAt),
    );
    const already = db.reports.some(
      (r) => r.reporterId === u.id && r.targetType === input.targetType && r.targetId === targetId,
    );

    if (!already) {
      db.reports.push({
        reporterId: u.id, targetType: input.targetType, targetId,
        reason: input.reason, note, createdAt: new Date().toISOString(),
      });
      // Жалобу разбирают в панели модератора; как и на сервере, она ещё и
      // печатается — здесь в консоль вкладки. Повтор не печатается.
      console.warn(
        `⚑ Жалоба: @${u.username} → ${input.targetType} #${targetId}, причина «${input.reason}»`
        + (note ? `, комментарий: ${note}` : ''),
      );
    }

    return tick({ ok: true as const, alreadyReported: already });
  },
};

/** Заявка принята: подписка и событие заявителю. */
function acceptRequest(requesterId: number, targetId: number) {
  if (!db.follows.some((f) => f.followerId === requesterId && f.followeeId === targetId)) {
    db.follows.push({ followerId: requesterId, followeeId: targetId });
  }
  db.followRequests = db.followRequests.filter((r) => !(r.requesterId === requesterId && r.targetId === targetId));
  notify({ userId: requesterId, actorId: targetId, kind: 'follow_accept' });
}

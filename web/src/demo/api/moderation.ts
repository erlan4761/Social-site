import { type BannedUser, type ModerationAction, type ModerationItem, type ReportTargetType } from '../../api';
import { db, fail, tick } from '../store';
import { author, byId, requireMe } from '../model/people';

/** Панель модератора в витрине — как routes/moderation.js. Смотрящий — модератор. */

function requireModerator() {
  const u = requireMe()!;
  if (!u.moderator) fail(403, 'Только для модераторов');
  return u;
}

function subject(type: ReportTargetType, id: number): ModerationItem['subject'] {
  if (type === 'post') {
    const p = db.posts.find((x) => x.id === id);
    const a = p && byId(p.authorId);
    return p && a ? { authorId: a.id, author: author(a), text: p.body, createdAt: p.createdAt, media: p.media?.url ?? null, banned: Boolean(a.bannedAt) } : null;
  }
  if (type === 'comment') {
    const c = db.comments.find((x) => x.id === id);
    const a = c && byId(c.authorId);
    return c && a ? { authorId: a.id, author: author(a), text: c.body, createdAt: c.createdAt, postId: c.postId, banned: Boolean(a.bannedAt) } : null;
  }
  const u = byId(id);
  return u ? { authorId: u.id, author: author(u), text: u.bio, createdAt: u.createdAt, banned: Boolean(u.bannedAt) } : null;
}

export const moderationApi = {
  moderationReports: (status: 'open' | 'resolved') => {
    requireModerator();
    const groups = new Map<string, ModerationItem>();
    for (const r of [...db.reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (Boolean(r.resolvedAt) !== (status === 'resolved')) continue;
      const key = `${r.targetType}:${r.targetId}`;
      let g = groups.get(key);
      if (!g) {
        g = { targetType: r.targetType, targetId: r.targetId, count: 0, reasons: {}, notes: [], lastAt: r.createdAt, resolution: r.resolution ?? null, resolvedAt: r.resolvedAt ?? null, subject: null };
        groups.set(key, g);
      }
      g.count += 1;
      g.reasons[r.reason] = (g.reasons[r.reason] ?? 0) + 1;
      if (r.note && g.notes.length < 5) g.notes.push({ reporter: byId(r.reporterId)?.username ?? '?', reason: r.reason, note: r.note, createdAt: r.createdAt });
    }
    const reports = [...groups.values()]
      .map((g) => ({ ...g, subject: subject(g.targetType, g.targetId) }))
      .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
    return tick({ reports });
  },

  resolveReport: (targetType: ReportTargetType, targetId: number, action: ModerationAction) => {
    const me = requireModerator();
    const open = db.reports.filter((r) => r.targetType === targetType && r.targetId === targetId && !r.resolvedAt);
    if (open.length === 0) fail(404, 'Открытых жалоб на это нет');
    const s = subject(targetType, targetId);
    if (action !== 'dismiss' && !s) fail(404, 'Этого уже нет — жалобу можно только закрыть');
    if (action === 'remove') {
      if (targetType === 'user') fail(400, 'Человека не удалить — только заблокировать');
      if (targetType === 'post') db.posts = db.posts.filter((p) => p.id !== targetId);
      else db.comments = db.comments.filter((c) => c.id !== targetId);
    }
    if (action === 'ban') {
      const target = byId(s!.authorId)!;
      if (target.id === me.id) fail(400, 'Себя не заблокировать');
      if (target.moderator) fail(400, 'Модератора не заблокировать — сначала снимите с него права');
      target.bannedAt = new Date().toISOString();
      target.banReason = `жалоба на ${targetType} #${targetId}`;
      db.sessions = db.sessions.filter((x) => x.userId !== target.id);
    }
    const resolution = ({ dismiss: 'dismissed', remove: 'removed', ban: 'banned' } as const)[action];
    for (const r of open) {
      r.resolvedAt = new Date().toISOString();
      r.resolution = resolution;
    }
    return tick({ ok: true as const, resolution: resolution as string, resolved: open.length });
  },

  bannedUsers: () => {
    requireModerator();
    const users: BannedUser[] = db.users
      .filter((u) => u.bannedAt)
      .map((u) => ({ ...author(u), bannedAt: u.bannedAt!, reason: u.banReason ?? '' }));
    return tick({ users });
  },

  unbanUser: (username: string) => {
    requireModerator();
    const u = db.users.find((x) => x.username === username.toLowerCase() && x.bannedAt);
    if (!u) fail(404, 'Такого заблокированного нет');
    u!.bannedAt = null;
    u!.banReason = '';
    return tick({ ok: true as const });
  },
};

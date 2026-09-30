import { type Scheduled, type ScheduledKind } from '../../api';
import { type DbUser, type DbChannelPost, type DbMessage, NO_EXTRAS, type DbChatMessage, type DbScheduled, db, id, fail } from '../store';
import { byId, byName, requireMe, blockedPair } from './people';
import { notify, saveMentions } from './notifications';
import { membersOf, memberRow } from './chats';
import { channelBy, subOf } from './channels';
import { dispatchLive } from '../../live';
import { expiryFor } from './autoDelete';

/** Отложенные сообщения и планировщик витрины — как scheduled.js. */

// ─ Отложенные ───────────────────────────────────────────────────────────────

export const toScheduled = ({ userId: _u, targetId: _t, ...s }: DbScheduled): Scheduled => ({ ...s });

/** Куда писать — как resolveTarget() в routes/scheduled.js. */
export function scheduleTarget(kind: ScheduledKind, raw: string | number, u: DbUser) {
  if (kind === 'dm') {
    const other = byName(String(raw));
    return other && !blockedPair(u.id, other.id) ? other.id : null;
  }
  if (kind === 'chat') return memberRow(Number(raw), u.id) ? Number(raw) : null;
  const c = channelBy(String(raw));
  return c && c.ownerId === u.id ? c.id : null;
}

/** Отправка отложенного — те же проверки доступа, что в scheduled.js, в момент отправки. */
export function deliverScheduled(s: DbScheduled): number | null {
  const sent = deliverNow(s);
  // Ушло по часам — толчок экрану, как от живого потока сервера.
  if (sent != null) {
    dispatchLive(s.kind === 'dm' ? { t: 'dm', with: s.targetId } : s.kind === 'chat' ? { t: 'chat', id: s.targetId } : { t: 'channel', id: s.targetId });
  }
  return sent;
}

function deliverNow(s: DbScheduled): number | null {
  db.scheduledMessages = db.scheduledMessages.filter((x) => x.id !== s.id);
  const at = new Date().toISOString();
  if (s.kind === 'dm') {
    const other = byId(s.targetId);
    if (!other || blockedPair(s.userId, other.id)) return null;
    const self = other.id === s.userId;
    const m: DbMessage = { id: id(), fromId: s.userId, toId: other.id, body: s.body, createdAt: at, readAt: self ? at : null, ...NO_EXTRAS, expiresAt: expiryFor('dm', other.id, s.userId) };
    db.messages.push(m);
    if (!self) notify({ userId: other.id, actorId: s.userId, kind: 'message' });
    return m.id;
  }
  if (s.kind === 'chat') {
    if (!memberRow(s.targetId, s.userId)) return null;
    const m: DbChatMessage = { id: id(), chatId: s.targetId, authorId: s.userId, body: s.body, createdAt: at, ...NO_EXTRAS, expiresAt: expiryFor('chat', s.targetId) };
    db.chatMessages.push(m);
    for (const member of membersOf(s.targetId)) notify({ userId: member.userId, actorId: s.userId, kind: 'chat_message', chatId: s.targetId });
    saveMentions(s.targetId, m.id, s.userId, s.body);
    return m.id;
  }
  const c = db.channels.find((x) => x.id === s.targetId && x.ownerId === s.userId);
  if (!c) return null;
  const post: DbChannelPost = { id: id(), channelId: c.id, authorId: s.userId, body: s.body, createdAt: at, editedAt: null, attachment: null, expiresAt: expiryFor('channel', c.id) };
  db.channelPosts.push(post);
  const sub = subOf(c.id, s.userId);
  if (sub) sub.lastReadId = post.id;
  return post.id;
}

export function deliverDueScheduled() {
  const now = new Date().toISOString();
  for (const s of db.scheduledMessages.filter((x) => x.sendAt <= now)) deliverScheduled(s);
}

export function readSendAt(raw: string) {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) fail(400, 'Время отправки — дата в формате ISO');
  if (at.getTime() <= Date.now()) fail(400, 'Время отправки уже прошло');
  if (at.getTime() - Date.now() > 365 * 864e5) fail(400, 'Отложить можно не больше чем на год');
  return at.toISOString();
}

export function requireScheduled(scheduledId: number) {
  const u = requireMe()!;
  const s = db.scheduledMessages.find((x) => x.id === scheduledId && x.userId === u.id);
  return s ?? fail(404, 'Отложенное сообщение не найдено');
}

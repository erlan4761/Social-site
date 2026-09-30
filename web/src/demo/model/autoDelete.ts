import { type PrefKind } from '../../api';
import { db } from '../store';
import { pinnedOf, pinScope, setPin } from './folders';
import { dispatchLive } from '../../live';

/** Автоудаление в витрине — как autoDelete.js: таймер у переписки, срок у сообщения. */

export const dmAutoDelete = (a: number, b: number) =>
  db.dmSettings.find((x) => x.low === Math.min(a, b) && x.high === Math.max(a, b))?.autoDelete ?? 0;

export function setDmAutoDelete(a: number, b: number, seconds: number) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  db.dmSettings = db.dmSettings.filter((x) => !(x.low === low && x.high === high));
  if (seconds) db.dmSettings.push({ low, high, autoDelete: seconds });
}

/** Срок для сообщения, отправленного сейчас, — или null. */
export function expiryFor(kind: PrefKind, targetId: number, fromId: number | null = null) {
  const seconds = kind === 'dm'
    ? dmAutoDelete(fromId ?? targetId, targetId)
    : kind === 'chat'
      ? db.chats.find((c) => c.id === targetId)?.autoDelete ?? 0
      : db.channels.find((c) => c.id === targetId)?.autoDelete ?? 0;
  return seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null;
}

const unpinIf = (kind: PrefKind, scope: string | number, messageId: number) => {
  if (pinnedOf(kind, scope)?.messageId === messageId) setPin(kind, scope, null);
};

/** Убрать истёкшее — тем же тактом, что отправляет отложенные. */
export function sweepExpired() {
  const now = new Date().toISOString();
  const gone = <T extends { expiresAt?: string | null }>(x: T) => Boolean(x.expiresAt && x.expiresAt <= now);
  const dms = db.messages.filter(gone);
  const chats = db.chatMessages.filter(gone);
  const posts = db.channelPosts.filter(gone);
  if (!dms.length && !chats.length && !posts.length) return;
  db.messages = db.messages.filter((m) => !gone(m));
  db.chatMessages = db.chatMessages.filter((m) => !gone(m));
  db.channelPosts = db.channelPosts.filter((p) => !gone(p));
  dms.forEach((m) => unpinIf('dm', pinScope(m.fromId, m.toId), m.id));
  chats.forEach((m) => unpinIf('chat', m.chatId, m.id));
  posts.forEach((p) => unpinIf('channel', p.channelId, p.id));
  dms.forEach((m) => dispatchLive({ t: 'dm', with: db.meId === m.fromId ? m.toId : m.fromId }));
  new Set(chats.map((m) => m.chatId)).forEach((id) => dispatchLive({ t: 'chat', id }));
  new Set(posts.map((p) => p.channelId)).forEach((id) => dispatchLive({ t: 'channel', id }));
}

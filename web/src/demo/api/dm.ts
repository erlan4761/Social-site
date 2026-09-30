import { type AttachmentInput, type ChatMessage, type Conversation, type ForwardRef, type ForwardTarget, type Message } from '../../api';
import { type DbMessage, db, id, tick, fail } from '../store';
import { byId, byName, requireMe, person, blockedPair } from '../model/people';
import { attachmentFrom, toMessage, assertEditable, setReaction, pairThread, requirePairMessage, findHits, dmKey, setTyping, clearTyping, isTyping, forwardSource, marinaAnswers, readSticker, CHAT_PAGE, BODY_MAX, checkAlbum } from '../model/messages';
import { pinScope, pinnedOf, setPin, pinPreview } from '../model/folders';
import { prefFields, dmUnreadTotal, notify, markNotificationsRead } from '../model/notifications';
import { clearDraft, draftOf } from '../model/drafts';
import { dmAutoDelete, expiryFor, setDmAutoDelete } from '../model/autoDelete';
import { chatsApi } from './chats';

/** Методы витрины: личная переписка. */

export const dmApi = {
  conversations: () => {
    const u = requireMe()!;
    const mine = db.messages.filter((m) => m.fromId === u.id || m.toId === u.id);
    const others = [...new Set(mine.map((m) => (m.fromId === u.id ? m.toId : m.fromId)))];

    const list: Conversation[] = others
      .map((otherId) => {
        const thread = mine.filter((m) => (m.fromId === u.id ? m.toId : m.fromId) === otherId);
        const last = thread.reduce((a, b) => (a.id > b.id ? a : b));
        return {
          user: person(byId(otherId)!),
          unread: db.messages.filter((m) => m.toId === u.id && m.fromId === otherId && !m.readAt).length,
          lastMessage: toMessage(last),
          // История не удаляется и диалог из списка не исчезает — меняется
          // только возможность отвечать.
          blocked: blockedPair(u.id, otherId),
          ...prefFields(u.id, 'dm', otherId, last.createdAt),
          draft: draftOf(u.id, 'dm', otherId),
        };
      })
      .sort((a, b) => b.lastMessage.id - a.lastMessage.id);

    return tick({
      conversations: list,
      unreadTotal: dmUnreadTotal(u.id),
    });
  },

  thread: (username: string, cursor?: number | null) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');

    let list = db.messages
      .filter((m) =>
        (m.fromId === u.id && m.toId === other!.id) || (m.fromId === other!.id && m.toId === u.id))
      .sort((a, b) => b.id - a.id);

    if (cursor != null) list = list.filter((m) => m.id < cursor);

    const page = list.slice(0, CHAT_PAGE);
    return tick({
      user: person(other!),
      messages: page.map(toMessage).reverse(),
      nextCursor: list.length > CHAT_PAGE ? page.at(-1)!.id : null,
      blocked: blockedPair(u.id, other!.id),
      typing: !blockedPair(u.id, other!.id) && isTyping(dmKey(u.id, other!.id), other!.id),
      pinned: pinPreview('dm', pinScope(u.id, other!.id), pairThread(u.id, other!.id)),
      autoDelete: dmAutoDelete(u.id, other!.id),
    });
  },

  sendMessage: (username: string, text: string, replyTo?: number | null, forward?: ForwardRef, file?: AttachmentInput, sticker?: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    // Себе — это «Избранное»: сразу прочитано, без события.
    const saved = other!.id === u.id;
    // Текст одинаков в обе стороны намеренно: по формулировке нельзя понять,
    // кто кого заблокировал.
    if (blockedPair(u.id, other!.id)) fail(403, 'Переписка с этим пользователем недоступна');

    const src = forward ? forwardSource(forward, u) : null;
    const body = src ? src.body : text.trim();
    const attachment = src ? src.attachment : file ? attachmentFrom(file) : null;
    const stick = sticker ? readSticker(sticker) : src?.sticker ?? null;
    if (!body && !attachment && !stick) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (!src && replyTo != null && !pairThread(u.id, other!.id).some((m) => m.id === replyTo)) {
      fail(400, 'Сообщение, на которое вы отвечаете, не найдено');
    }

    const albumId = checkAlbum(file?.album, attachment,
      db.messages.filter((x) => x.albumId && x.albumId === file?.album).map((x) => ({ mine: x.fromId === u.id && x.toId === other!.id })));
    const m: DbMessage = {
      id: id(), fromId: u.id, toId: other!.id, body, albumId, expiresAt: expiryFor('dm', other!.id, u.id),
      createdAt: new Date().toISOString(), readAt: saved ? new Date().toISOString() : null,
      replyToId: src ? null : replyTo ?? null, editedAt: null, fwdUserId: src?.fwdUserId ?? null, fwdChannelId: src?.fwdChannelId ?? null, attachment,
      sticker: stick,
    };
    db.messages.push(m);
    clearTyping(dmKey(u.id, other!.id), u.id);
    // Отправленный текст — больше не черновик; стикер и пересылка его не трогают.
    if (!stick && !src) clearDraft(u.id, 'dm', other!.id);
    if (!saved) notify({ userId: other!.id, actorId: u.id, kind: 'message' });
    if (other!.username === 'marina') marinaAnswers(u);
    return tick({ message: toMessage(m) });
  },

  setDmAutoDelete: (username: string, seconds: number) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    if (blockedPair(u.id, other!.id)) fail(403, 'Переписка с этим пользователем недоступна');
    if (![0, 86_400, 604_800, 2_592_000].includes(seconds)) fail(400, 'Автоудаление — выключено, сутки, неделя или месяц');
    setDmAutoDelete(u.id, other!.id, seconds);
    return tick({ autoDelete: seconds });
  },

  sendAttachment: (username: string, input: AttachmentInput) =>
    dmApi.sendMessage(username, input.body ?? '', input.replyTo ?? null, undefined, input),

  editMessage: (username: string, messageId: number, text: string) => {
    const { u, other, m } = requirePairMessage(username, messageId);
    assertEditable(m.fromId, m.createdAt, m.fwdUserId, u, m.fwdChannelId);
    if (m.sticker) fail(403, 'Стикер изменить нельзя');
    if (blockedPair(u.id, other.id)) fail(403, 'Переписка с этим пользователем недоступна');
    const body = text.trim();
    if (!body && !m.attachment) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (body !== m.body) {
      m.body = body;
      m.editedAt = new Date().toISOString();
    }
    return tick({ message: toMessage(m) });
  },

  deleteMessage: (username: string, messageId: number) => {
    const { u, m } = requirePairMessage(username, messageId);
    if (m.fromId !== u.id) fail(403, 'Удалить можно только своё сообщение');
    db.messages = db.messages.filter((x) => x.id !== m.id);
    if (pinnedOf('dm', pinScope(m.fromId, m.toId))?.messageId === m.id) setPin('dm', pinScope(m.fromId, m.toId), null);
    db.dmReactions = db.dmReactions.filter((r) => r.messageId !== m.id);
    return tick({ ok: true as const });
  },

  reactMessage: (username: string, messageId: number, emoji: string | null) => {
    const { u, other, m } = requirePairMessage(username, messageId);
    if (emoji && blockedPair(u.id, other.id)) fail(403, 'Переписка с этим пользователем недоступна');
    setReaction(db.dmReactions, m.id, u.id, emoji);
    return tick({ message: toMessage(m) });
  },

  typing: (username: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    if (other!.id !== u.id && !blockedPair(u.id, other!.id)) setTyping(dmKey(u.id, other!.id), u.id);
    return tick({ ok: true as const });
  },

  /** Переслать — это та же отправка, только текст берётся из оригинала. */
  forward: (target: ForwardTarget, source: ForwardRef): Promise<{ message: Message }> | Promise<{ message: ChatMessage }> =>
    target.kind === 'dm'
      ? dmApi.sendMessage(target.username, '', null, source)
      : chatsApi.sendChatMessage(target.id, '', null, source),

  markRead: (username: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    for (const m of db.messages) {
      if (m.toId === u.id && m.fromId === other!.id && !m.readAt) m.readAt = new Date().toISOString();
    }
    // Прочитанный диалог гасит и событие о нём: иначе лента событий жила бы
    // отдельной жизнью от переписки.
    markNotificationsRead({ userId: u.id, kind: 'message', actorId: other!.id });
    return tick({
      ok: true as const,
      unreadTotal: dmUnreadTotal(u.id),
    });
  },

  // ─ Настройки чатов ────────────────────────────────────────────────────

  // ─ Поиск внутри переписки ─────────────────────────────────────────────

  searchThread: (username: string, q: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    const hits = findHits(q, pairThread(u.id, other!.id), (m) => m.fromId);
    return tick({ results: hits });
  },

  pinMessage: (username: string, messageId: number) => {
    const { u, other, m } = requirePairMessage(username, messageId);
    if (blockedPair(u.id, other.id)) fail(403, 'Переписка с этим пользователем недоступна');
    setPin('dm', pinScope(u.id, other.id), m.id);
    return tick({ pinned: pinPreview('dm', pinScope(u.id, other.id), pairThread(u.id, other.id)) });
  },

  unpinMessage: (username: string) => {
    const u = requireMe()!;
    const other = byName(username);
    if (!other) fail(404, 'Пользователь не найден');
    setPin('dm', pinScope(u.id, other!.id), null);
    return tick({ ok: true as const });
  },

  // ─ Стикеры ────────────────────────────────────────────────────────────

  sendSticker: (username: string, sticker: string) => dmApi.sendMessage(username, '', null, undefined, undefined, sticker),
};

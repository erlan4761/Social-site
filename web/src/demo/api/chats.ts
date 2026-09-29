import { type AttachmentInput, type ChatSummary, type ForwardRef, type PollInput } from '../../api';
import { type DbUser, type DbChat, NO_EXTRAS, type DbChatMessage, db, id, tick, fail } from '../store';
import { byId, byName, requireMe, blockedPair, hidden } from '../model/people';
import { attachmentFrom, assertEditable, setReaction, findHits, setTyping, clearTyping, isTyping, forwardSource, readSticker, CHAT_PAGE, BODY_MAX } from '../model/messages';
import { pinnedOf, setPin, pinPreview } from '../model/folders';
import { prefFields, dropPrefs, notify, saveMentions, unreadMentions, markNotificationsRead } from '../model/notifications';
import { clearDraft, draftOf } from '../model/drafts';
import { membersOf, memberRow, visibleChatMessages, toChatMessage, requireChatMessage, toChat, othersReadUpTo, chatUnread, requireChat, MEMBERS_MAX, checkTitle, newInvite } from '../model/chats';
import { person as personOf } from '../model/people';
import { pollOf, readPoll, addPoll } from '../model/polls';

/** Методы витрины: групповые чаты. */

export const chatsApi = {
  // ─ Групповые чаты ─────────────────────────────────────────────────────

  chats: () => {
    const u = requireMe()!;

    const list: ChatSummary[] = db.chatMembers
      .filter((m) => m.userId === u.id)
      .map((m) => db.chats.find((c) => c.id === m.chatId))
      .filter((c): c is DbChat => Boolean(c))
      .map((c) => {
        // Последнее сообщение — последнее **видимое**: реплика заблокированного
        // не показывается даже в превью.
        const last = visibleChatMessages(c.id).at(-1) ?? null;
        return {
          ...toChat(c),
          unread: chatUnread(c.id, u.id),
          mentions: unreadMentions(c.id, u.id),
          lastMessage: last ? toChatMessage(last) : null,
          readUpTo: othersReadUpTo(c.id, u.id),
          ...prefFields(u.id, 'chat', c.id),
          draft: draftOf(u.id, 'chat', c.id),
        };
      })
      // Чат без сообщений встаёт по своему созданию, иначе только что
      // собранный чат уезжал бы в самый низ списка.
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt).localeCompare(a.lastMessage?.createdAt ?? a.createdAt));

    return tick({ chats: list, unreadTotal: list.reduce((sum, c) => sum + c.unread, 0) });
  },

  createChat: (input: { title: string; members: string[] }) => {
    const u = requireMe()!;
    const title = checkTitle(input.title);
    if (!Array.isArray(input.members)) fail(400, 'Список участников должен быть массивом имён');

    // Участники приходят именами, а не id: id из тела запроса в проекте
    // принципиально не принимают. Своё имя и повторы схлопываются молча.
    const names = [...new Set(input.members.map((n) => (typeof n === 'string' ? n.trim().toLowerCase() : '')))]
      .filter((n) => n && n !== u.username);

    const invited: DbUser[] = [];
    for (const name of names) {
      const found = byName(name);
      if (!found) fail(400, `Пользователь «${name}» не найден`);
      if (blockedPair(u.id, found!.id)) fail(400, `Добавить «${name}» в чат нельзя`);
      invited.push(found!);
    }

    if (invited.length === 0) fail(400, 'В чате должно быть не меньше двух участников');
    if (invited.length + 1 > MEMBERS_MAX) fail(400, `В чате не больше ${MEMBERS_MAX} участников`);

    const now = new Date().toISOString();
    const chat: DbChat = { id: id(), title, ownerId: u.id, createdAt: now };
    db.chats.push(chat);
    db.chatMembers.push({ chatId: chat.id, userId: u.id, joinedAt: now, lastReadId: 0 });

    for (const person of invited) {
      db.chatMembers.push({ chatId: chat.id, userId: person.id, joinedAt: now, lastReadId: 0 });
      notify({ userId: person.id, actorId: u.id, kind: 'chat_invite', chatId: chat.id });
    }

    return tick({ chat: toChat(chat) });
  },

  chat: (chatId: number) => {
    const { chat } = requireChat(chatId);
    return tick({ chat: toChat(chat) });
  },

  renameChat: (chatId: number, title: string) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Переименовать чат может только владелец');
    chat.title = checkTitle(title);
    return tick({ chat: toChat(chat) });
  },

  deleteChat: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Удалить чат может только владелец');
    db.chats = db.chats.filter((c) => c.id !== chat.id);
    dropPrefs('chat', chat.id);
    db.chatMembers = db.chatMembers.filter((m) => m.chatId !== chat.id);
    db.chatMessages = db.chatMessages.filter((m) => m.chatId !== chat.id);
    db.notifications = db.notifications.filter((n) => n.chatId !== chat.id);
    return tick({ ok: true as const });
  },

  chatMessages: (chatId: number, cursor?: number | null) => {
    const { u, chat } = requireChat(chatId);

    let list = visibleChatMessages(chat.id);
    if (cursor != null) list = list.filter((m) => m.id < cursor);

    // Старые сверху: страница — последние 30 по id, курсор — id самого
    // старого элемента страницы, то есть точка для подгрузки вверх.
    const page = list.slice(-CHAT_PAGE);
    return tick({
      chat: toChat(chat),
      messages: page.map(toChatMessage),
      nextCursor: list.length > CHAT_PAGE ? page[0].id : null,
      readUpTo: othersReadUpTo(chat.id, u.id),
      typing: membersOf(chat.id)
        .filter((m) => m.userId !== u.id && !hidden(m.userId) && isTyping(`chat:${chat.id}`, m.userId))
        .map((m) => ({ id: m.userId, displayName: byId(m.userId)!.displayName })),
      pinned: pinPreview('chat', chat.id, visibleChatMessages(chat.id)),
    });
  },

  sendChatMessage: (chatId: number, text: string, replyTo?: number | null, forward?: ForwardRef, file?: AttachmentInput, sticker?: string) => {
    const { u, chat } = requireChat(chatId);
    const src = forward ? forwardSource(forward, u) : null;
    const body = src ? src.body : text.trim();
    const attachment = src ? src.attachment : file ? attachmentFrom(file) : null;
    const stick = sticker ? readSticker(sticker) : src?.sticker ?? null;
    if (!body && !attachment && !stick) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (!src && replyTo != null && !visibleChatMessages(chat.id).some((m) => m.id === replyTo)) {
      fail(400, 'Сообщение, на которое вы отвечаете, не найдено');
    }

    const m: DbChatMessage = {
      id: id(), chatId: chat.id, authorId: u.id, body, createdAt: new Date().toISOString(),
      replyToId: src ? null : replyTo ?? null, editedAt: null, fwdUserId: src?.fwdUserId ?? null, fwdChannelId: src?.fwdChannelId ?? null, attachment,
      sticker: stick,
    };
    db.chatMessages.push(m);
    clearTyping(`chat:${chat.id}`, u.id);
    if (!stick && !src) clearDraft(u.id, 'chat', chat.id);

    for (const member of membersOf(chat.id)) {
      notify({ userId: member.userId, actorId: u.id, kind: 'chat_message', chatId: chat.id });
    }
    if (!src) saveMentions(chat.id, m.id, u.id, body);

    return tick({ message: toChatMessage(m) });
  },

  sendChatAttachment: (chatId: number, input: AttachmentInput) =>
    chatsApi.sendChatMessage(chatId, input.body ?? '', input.replyTo ?? null, undefined, input),

  editChatMessage: (chatId: number, messageId: number, text: string) => {
    const { u, chat } = requireChat(chatId);
    const m = requireChatMessage(chat.id, messageId);
    assertEditable(m.authorId, m.createdAt, m.fwdUserId, u, m.fwdChannelId);
    if (pollOf('chat', m.id)) fail(403, 'Опрос изменить нельзя — за него уже голосуют');
    if (m.sticker) fail(403, 'Стикер изменить нельзя');
    const body = text.trim();
    if (!body && !m.attachment) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (body !== m.body) {
      m.body = body;
      m.editedAt = new Date().toISOString();
      saveMentions(chat.id, m.id, u.id, body);
    }
    return tick({ message: toChatMessage(m) });
  },

  deleteChatMessage: (chatId: number, messageId: number) => {
    const { u, chat } = requireChat(chatId);
    const m = requireChatMessage(chat.id, messageId);
    // Своё — автор, любое — владелец чата, как админ группы.
    if (m.authorId !== u.id && chat.ownerId !== u.id) fail(403, 'Удалить можно только своё сообщение');
    db.chatMessages = db.chatMessages.filter((x) => x.id !== m.id);
    if (pinnedOf('chat', chat.id)?.messageId === m.id) setPin('chat', chat.id, null);
    db.chatReactions = db.chatReactions.filter((r) => r.messageId !== m.id);
    db.chatMentions = db.chatMentions.filter((x) => x.messageId !== m.id);
    db.notifications = db.notifications.filter((n) => n.messageId !== m.id);
    return tick({ ok: true as const });
  },

  reactChatMessage: (chatId: number, messageId: number, emoji: string | null) => {
    const { u, chat } = requireChat(chatId);
    const m = requireChatMessage(chat.id, messageId);
    setReaction(db.chatReactions, m.id, u.id, emoji);
    return tick({ message: toChatMessage(m) });
  },

  chatTyping: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    setTyping(`chat:${chat.id}`, u.id);
    return tick({ ok: true as const });
  },

  markChatRead: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    const row = memberRow(chat.id, u.id)!;
    // Ватерлиния встаёт на максимальный id чата, включая скрытые реплики:
    // иначе они всплывали бы как непрочитанные после снятия блокировки.
    const top = db.chatMessages.filter((m) => m.chatId === chat.id).reduce((max, m) => Math.max(max, m.id), 0);
    row.lastReadId = Math.max(row.lastReadId, top);
    markNotificationsRead({ userId: u.id, kind: 'chat_message', chatId: chat.id });
    markNotificationsRead({ userId: u.id, kind: 'mention', chatId: chat.id });
    return tick({ ok: true as const, unread: 0 });
  },

  addChatMember: (chatId: number, username: string) => {
    // Звать людей может любой участник — удалять их может только владелец.
    const { u, chat } = requireChat(chatId);
    const name = username.trim().toLowerCase();
    const person = byName(name);
    if (!person) fail(400, `Пользователь «${name}» не найден`);
    if (memberRow(chat.id, person!.id)) fail(400, 'Этот человек уже в чате');
    if (blockedPair(u.id, person!.id)) fail(400, `Добавить «${name}» в чат нельзя`);
    if (membersOf(chat.id).length >= MEMBERS_MAX) fail(400, `В чате не больше ${MEMBERS_MAX} участников`);

    db.chatMembers.push({
      chatId: chat.id, userId: person!.id, joinedAt: new Date().toISOString(), lastReadId: 0,
    });
    notify({ userId: person!.id, actorId: u.id, kind: 'chat_invite', chatId: chat.id });

    return tick({ chat: toChat(chat) });
  },

  createInvite: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Ссылкой-приглашением управляет владелец');
    chat.invite = newInvite();
    return tick({ invite: chat.invite });
  },

  revokeInvite: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Ссылкой-приглашением управляет владелец');
    chat.invite = null;
    return tick({ invite: null });
  },

  invitePreview: (token: string) => {
    const u = requireMe()!;
    const chat = db.chats.find((c) => c.invite && c.invite === token);
    if (!chat) fail(404, 'Ссылка недействительна: её отключили или сменили');
    const members = membersOf(chat!.id);
    return tick({
      chat: {
        id: chat!.id, title: chat!.title, memberCount: members.length,
        members: members.slice(0, 5).map((m) => personOf(byId(m.userId)!)),
      },
      member: members.some((m) => m.userId === u.id),
    });
  },

  joinByInvite: (token: string) => {
    const u = requireMe()!;
    const chat = db.chats.find((c) => c.invite && c.invite === token);
    if (!chat) fail(404, 'Ссылка недействительна: её отключили или сменили');
    if (memberRow(chat!.id, u.id)) return tick({ chat: toChat(chat!) });
    if (blockedPair(u.id, chat!.ownerId)) fail(403, 'Вступить в этот чат нельзя');
    if (membersOf(chat!.id).length >= MEMBERS_MAX) fail(400, `В чате не больше ${MEMBERS_MAX} участников`);
    // Как на сервере: пришедший по ссылке начинает с «сейчас».
    const top = Math.max(0, ...db.chatMessages.filter((m) => m.chatId === chat!.id).map((m) => m.id));
    db.chatMembers.push({ chatId: chat!.id, userId: u.id, joinedAt: new Date().toISOString(), lastReadId: top });
    return tick({ chat: toChat(chat!) });
  },

  removeChatMember: (chatId: number, username: string) => {
    const { u, chat } = requireChat(chatId);
    const person = byName(username);
    const row = person ? memberRow(chat.id, person.id) : undefined;
    // Текст отличает этот 404 от «чата нет»: здесь скрывать уже нечего.
    if (!person || !row) fail(404, 'Участник не найден');

    const leaving = person!.id === u.id;
    if (!leaving && chat.ownerId !== u.id) fail(403, 'Удалять участников может только владелец');

    db.chatMembers = db.chatMembers.filter((m) => !(m.chatId === chat.id && m.userId === person!.id));
    dropPrefs('chat', chat.id, person!.id);
    // Ушедшему события об этом чате больше некуда вести.
    db.notifications = db.notifications.filter((n) => !(n.userId === person!.id && n.chatId === chat.id));

    const rest = membersOf(chat.id);
    if (rest.length === 0) {
      db.chats = db.chats.filter((c) => c.id !== chat.id);
      dropPrefs('chat', chat.id);
      db.chatMessages = db.chatMessages.filter((m) => m.chatId !== chat.id);
      db.notifications = db.notifications.filter((n) => n.chatId !== chat.id);
    } else if (chat.ownerId === person!.id) {
      // Чат без владельца невозможно ни переименовать, ни распустить —
      // владение переходит участнику с самым ранним joined_at.
      chat.ownerId = rest[0].userId;
    }

    return leaving ? tick({ ok: true as const, left: true }) : tick({ ok: true as const });
  },

  searchChat: (chatId: number, q: string) => {
    const { chat } = requireChat(chatId);
    return tick({ results: findHits(q, visibleChatMessages(chat.id), (m) => m.authorId) });
  },

  pinChatMessage: (chatId: number, messageId: number) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Закреплять сообщения может только владелец чата');
    const m = requireChatMessage(chat.id, messageId);
    setPin('chat', chat.id, m.id);
    return tick({ pinned: pinPreview('chat', chat.id, visibleChatMessages(chat.id)) });
  },

  unpinChatMessage: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Откреплять сообщения может только владелец чата');
    setPin('chat', chat.id, null);
    return tick({ ok: true as const });
  },

  sendChatSticker: (chatId: number, sticker: string) =>
    chatsApi.sendChatMessage(chatId, '', null, undefined, undefined, sticker),

  // ─ Опросы ──────────────────────────────────────────────────────────────

  sendChatPoll: (chatId: number, input: PollInput) => {
    const { u, chat } = requireChat(chatId);
    const poll = readPoll(input);
    const m: DbChatMessage = {
      id: id(), chatId: chat.id, authorId: u.id, body: poll.question, createdAt: new Date().toISOString(), ...NO_EXTRAS,
    };
    db.chatMessages.push(m);
    addPoll('chat', m.id, poll);
    for (const member of membersOf(chat.id)) notify({ userId: member.userId, actorId: u.id, kind: 'chat_message', chatId: chat.id });
    return tick({ message: toChatMessage(m) });
  },
};

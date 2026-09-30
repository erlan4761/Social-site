import { type AttachmentInput, type ChatSummary, type ForwardRef, type PollInput } from '../../api';
import { type DbUser, type DbChat, NO_EXTRAS, type DbChatMessage, db, id, tick, fail } from '../store';
import { byId, byName, requireMe, blockedPair, hidden } from '../model/people';
import { attachmentFrom, assertEditable, setReaction, findHits, setTyping, clearTyping, isTyping, forwardSource, readSticker, CHAT_PAGE, BODY_MAX, checkAlbum } from '../model/messages';
import { pinnedOf, setPin, pinPreview } from '../model/folders';
import { prefFields, dropPrefs, notify, saveMentions, unreadMentions, markNotificationsRead } from '../model/notifications';
import { clearDraft, draftOf } from '../model/drafts';
import { membersOf, memberRow, visibleChatMessages, toChatMessage, requireChatMessage, toChat, othersReadUpTo, chatUnread, requireChat, MEMBERS_MAX, checkTitle, newInvite, isAdmin, outranks, postBlock, roleOf } from '../model/chats';
import { SLOW_MODE_OPTIONS } from '../../api';
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
        // Состава в строке списка нет — как на сервере: он приходит с чатом.
        const { members: _members, ...chat } = toChat(c);
        return {
          ...chat,
          unread: chatUnread(c.id, u.id),
          mentions: unreadMentions(c.id, u.id),
          lastMessage: last ? toChatMessage(last) : null,
          readUpTo: othersReadUpTo(c.id, u.id),
          ...prefFields(u.id, 'chat', c.id, last?.createdAt ?? null),
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
    if (!isAdmin(chat, u.id)) fail(403, 'Менять группу могут владелец и администраторы');
    chat.title = checkTitle(title);
    return tick({ chat: toChat(chat) });
  },

  updateChat: (chatId: number, patch: { slowMode?: number; adminsOnly?: boolean }) => {
    const { u, chat } = requireChat(chatId);
    if (!isAdmin(chat, u.id)) fail(403, 'Менять группу могут владелец и администраторы');
    if (patch.slowMode === undefined && patch.adminsOnly === undefined) fail(400, 'Нечего менять');
    if (patch.slowMode !== undefined) {
      if (!(SLOW_MODE_OPTIONS as readonly number[]).includes(patch.slowMode)) fail(400, `Медленный режим — одно из: ${SLOW_MODE_OPTIONS.join(', ')} секунд`);
      chat.slowMode = patch.slowMode;
    }
    if (patch.adminsOnly !== undefined) chat.adminsOnly = patch.adminsOnly;
    return tick({ chat: toChat(chat) });
  },

  setChatAdmin: (chatId: number, username: string, admin: boolean) => {
    const { u, chat } = requireChat(chatId);
    if (chat.ownerId !== u.id) fail(403, 'Назначать администраторов может только владелец');
    const target = byName(username);
    const role = target ? roleOf(chat, target.id) : null;
    if (!role) fail(404, 'Участник не найден');
    if (role === 'owner') fail(400, 'Владелец и так главный');
    memberRow(chat.id, target!.id)!.role = admin ? 'admin' : 'member';
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
    const continuing = Boolean(file?.album) && db.chatMessages.some((x) => x.albumId === file!.album && x.authorId === u.id && x.chatId === chat.id);
    postBlock(chat, u.id, continuing);
    const src = forward ? forwardSource(forward, u) : null;
    const body = src ? src.body : text.trim();
    const attachment = src ? src.attachment : file ? attachmentFrom(file) : null;
    const stick = sticker ? readSticker(sticker) : src?.sticker ?? null;
    if (!body && !attachment && !stick) fail(400, '«сообщение»: минимум 1 символов');
    if (body.length > BODY_MAX) fail(400, `«сообщение»: максимум ${BODY_MAX} символов`);
    if (!src && replyTo != null && !visibleChatMessages(chat.id).some((m) => m.id === replyTo)) {
      fail(400, 'Сообщение, на которое вы отвечаете, не найдено');
    }

    const albumId = checkAlbum(file?.album, attachment,
      db.chatMessages.filter((x) => x.albumId && x.albumId === file?.album).map((x) => ({ mine: x.authorId === u.id && x.chatId === chat.id })));
    const m: DbChatMessage = {
      id: id(), chatId: chat.id, authorId: u.id, body, createdAt: new Date().toISOString(), albumId,
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
    // Своё — автор; владелец — любое, администратор — сообщения участников.
    if (m.authorId !== u.id && !outranks(chat, u.id, m.authorId)) fail(403, 'Удалить можно своё сообщение, а администратору — сообщения участников');
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
    if (!isAdmin(chat, u.id)) fail(403, 'Ссылкой-приглашением управляют владелец и администраторы');
    chat.invite = newInvite();
    return tick({ invite: chat.invite });
  },

  revokeInvite: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    if (!isAdmin(chat, u.id)) fail(403, 'Ссылкой-приглашением управляют владелец и администраторы');
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
    if (!leaving && !outranks(chat, u.id, person!.id)) fail(403, 'Удалять участников могут владелец, а администраторы — только обычных участников');

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
      // Чат без владельца невозможно ни настроить, ни распустить — владение
      // переходит старейшему администратору, а без них — старейшему участнику.
      const heir = rest.find((m) => m.role === 'admin') ?? rest[0];
      chat.ownerId = heir.userId;
      heir.role = 'member';
    }

    return leaving ? tick({ ok: true as const, left: true }) : tick({ ok: true as const });
  },

  searchChat: (chatId: number, q: string) => {
    const { chat } = requireChat(chatId);
    return tick({ results: findHits(q, visibleChatMessages(chat.id), (m) => m.authorId) });
  },

  /**
   * Предпросмотр: сервера у витрины нет, чужие страницы она не скачивает.
   * Заготовлена карточка для одной ссылки — репозитория проекта, чтобы было
   * видно, как карточка выглядит; остальные ссылки остаются просто ссылками.
   */
  linkPreview: (url: string) =>
    tick({
      preview: url.replace(/\/$/, '') === 'https://github.com/erlan4761/Social-site'
        ? {
            url: 'https://github.com/erlan4761/Social-site',
            title: 'erlan4761/Social-site',
            description: '«Хроника» — социальная сеть и мессенджер: React, Express и SQLite без внешних сервисов.',
            siteName: 'GitHub',
            image: null,
          }
        : null,
    }),

  // Звонки браузеры ведут напрямую, а сводит их сервер — у витрины его нет.
  callConfig: (): Promise<{ iceServers: RTCIceServer[] }> => fail(400, 'В витрине звонков нет: браузеры соединяет сервер, а у витрины его нет'),
  startCall: (_to: string, _video: boolean, _sdp: RTCSessionDescriptionInit): Promise<{ call: { id: string; video: boolean } }> =>
    fail(400, 'В витрине звонков нет: браузеры соединяет сервер, а у витрины его нет'),
  answerCall: (_id: string, _sdp: RTCSessionDescriptionInit): Promise<{ ok: true }> => fail(400, 'В витрине звонков нет'),
  sendIce: (_id: string, _candidate: RTCIceCandidateInit): Promise<{ ok: true }> => fail(400, 'В витрине звонков нет'),
  endCall: (_id: string): Promise<{ ok: true; reason: string }> => fail(400, 'В витрине звонков нет'),

  chatReaders: (chatId: number, messageId: number) => {
    const { u, chat } = requireChat(chatId);
    const m = requireChatMessage(chat.id, messageId);
    if (m.authorId !== u.id) fail(403, 'Кто прочитал, видно только автору сообщения');
    const others = membersOf(chat.id)
      .filter((x) => x.userId !== u.id && !blockedPair(u.id, x.userId))
      .map((x) => ({ row: x, who: byId(x.userId)! }))
      .sort((a, b) => a.who.displayName.localeCompare(b.who.displayName));
    return tick({
      read: others.filter((x) => x.row.lastReadId >= m.id).map((x) => personOf(x.who)),
      unread: others.filter((x) => x.row.lastReadId < m.id).map((x) => personOf(x.who)),
    });
  },

  pinChatMessage: (chatId: number, messageId: number) => {
    const { u, chat } = requireChat(chatId);
    if (!isAdmin(chat, u.id)) fail(403, 'Закреплять сообщения могут владелец и администраторы');
    const m = requireChatMessage(chat.id, messageId);
    setPin('chat', chat.id, m.id);
    return tick({ pinned: pinPreview('chat', chat.id, visibleChatMessages(chat.id)) });
  },

  unpinChatMessage: (chatId: number) => {
    const { u, chat } = requireChat(chatId);
    if (!isAdmin(chat, u.id)) fail(403, 'Откреплять сообщения могут владелец и администраторы');
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

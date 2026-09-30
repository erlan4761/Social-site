import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi as api } from './mockApi';
import { seed } from './seed';
import { deliverDueScheduled } from './model/scheduled';
import { totpNow } from './model/twoFactor';

/**
 * Сценарии витрины — как смоук-тест сервера, только для подставного API.
 * То, что витрина отвечает теми же именами и формами, проверяет компилятор
 * (api.ts); здесь — что она ведёт себя как сервер: права, отказы, правила.
 * Каждый тест начинается с засева, как перезагрузка вкладки.
 */

const PASSWORD = 'parol12345';
const loginAs = (username: string) => api.login({ username, password: PASSWORD });
const room = async () => (await api.chats()).chats.find((c) => c.title === 'Плёнка и проявка')!;

beforeEach(() => {
  seed();
});

describe('витрина: основа', () => {
  it('входит под «demo», а ошибки — отклонённые промисы, а не исключения', async () => {
    expect((await api.me()).user?.username).toBe('demo');
    const call = api.thread('nobody_here');
    expect(call).toBeInstanceOf(Promise);
    await expect(call).rejects.toMatchObject({ status: 404 });
  });

  it('засев показывает «Избранное», упоминание в группе и отложенное Марине', async () => {
    const { conversations } = await api.conversations();
    const me = (await api.me()).user!;
    expect(conversations.some((c) => c.user.id === me.id)).toBe(true);
    expect((await room()).mentions).toBe(1);
    expect((await api.scheduled('dm', 'marina')).scheduled).toHaveLength(1);
  });
});

describe('витрина: переписка', () => {
  it('сообщение себе сразу прочитано и не будит счётчик', async () => {
    const { message } = await api.sendMessage('demo', 'заметка');
    expect(message.readAt).not.toBeNull();
    expect((await api.conversations()).conversations.find((c) => c.user.username === 'demo')?.unread).toBe(0);
  });

  it('стикер: из набора — да, выдуманный — 400, править — нельзя', async () => {
    const { message } = await api.sendSticker('marina', 'plenka/hi');
    expect(message.sticker).toBe('plenka/hi');
    await expect(api.sendSticker('marina', 'plenka/nope')).rejects.toMatchObject({ status: 400 });
    await expect(api.editMessage('marina', message.id, 'текст')).rejects.toMatchObject({ status: 403 });
  });

  it('упоминание доходит до участника группы событием и значком «@»', async () => {
    const chat = await room();
    await api.sendChatMessage(chat.id, '@nina, бачок не забудь');
    await loginAs('nina');
    expect((await room()).mentions).toBeGreaterThan(0);
    const events = (await api.notifications()).notifications;
    expect(events.some((e) => e.kind === 'mention' && e.message?.excerpt.startsWith('@nina'))).toBe(true);
  });
});

describe('витрина: опросы', () => {
  it('голос открывает результаты, два ответа в опросе с одним — 400', async () => {
    const chat = await room();
    const msg = (await api.chatMessages(chat.id)).messages.find((m) => m.poll)!;
    const poll = msg.poll!;
    expect(poll.options.every((o) => o.votes === null)).toBe(true);
    await expect(api.votePoll(poll.id, [poll.options[0].id, poll.options[1].id])).rejects.toMatchObject({ status: 400 });
    const res = await api.votePoll(poll.id, [poll.options[0].id]);
    expect(res.poll.myVotes).toEqual([poll.options[0].id]);
    expect(res.poll.options[0].votes).toBe(1);
  });

  it('завершить чужой опрос нельзя', async () => {
    const chat = await room();
    const poll = (await api.chatMessages(chat.id)).messages.find((m) => m.poll)!.poll!;
    await expect(api.closePoll(poll.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe('витрина: отложенные', () => {
  it('уходят в срок, прошедшее время — 400', async () => {
    await expect(api.schedule('dm', 'marina', 'поздно', new Date(Date.now() - 1000).toISOString())).rejects.toMatchObject({ status: 400 });
    await api.schedule('dm', 'marina', 'Точно в срок', new Date(Date.now() + 30).toISOString());
    await new Promise((resolve) => setTimeout(resolve, 60));
    deliverDueScheduled();
    const thread = await api.thread('marina');
    expect(thread.messages.at(-1)?.body).toBe('Точно в срок');
  });
});

describe('витрина: аккаунт', () => {
  it('«никому» прячет время и у собеседника, и у себя', async () => {
    await api.setPrivacy({ lastSeen: 'nobody' });
    const { user } = await api.thread('marina');
    expect(user.lastSeenAt).toBeNull();
    expect(user.seenRecently).toBe(true);
  });

  it('пароль меняется только по текущему; удалённый аккаунт больше не входит', async () => {
    await expect(api.changePassword('ne-tot', 'novyi-parol')).rejects.toMatchObject({ status: 403 });
    await expect(api.deleteAccount({ password: 'ne-tot' })).rejects.toMatchObject({ status: 403 });
    await api.deleteAccount({ password: PASSWORD });
    expect((await api.me()).user).toBeNull();
    await expect(loginAs('demo')).rejects.toMatchObject({ status: 401 });
  });

  it('папка без видов и чатов — 400', async () => {
    await expect(api.createFolder({ title: 'Пусто' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('витрина: вход по номеру', () => {
  it('новый номер: код → регистрация → вход; по логину такой аккаунт не входит', async () => {
    await api.logout();
    const sent = await api.phoneStart('+996 700 11-22-33');
    expect(sent.phone).toBe('+996700112233');
    await expect(api.phoneVerify(sent.phone, '000000' === sent.demoCode ? '111111' : '000000')).rejects.toMatchObject({ status: 400 });
    const verdict = await api.phoneVerify(sent.phone, sent.demoCode!);
    expect(verdict.status).toBe('signup');
    if (verdict.status !== 'signup') return;
    const { user } = await api.phoneSignup(verdict.ticket, 'novyi_nomer', 'Новый');
    expect((await api.me()).user?.id).toBe(user.id);
    expect(await api.account()).toMatchObject({ phone: '+996700112233', hasPassword: false, passwordLogin: false });
    await expect(api.login({ username: 'novyi_nomer', password: '' })).rejects.toMatchObject({ status: 401 });
  });

  it('старый аккаунт с номером: после кода спрашивают пароль', async () => {
    await api.logout();
    const sent = await api.phoneStart('+996555000001');
    const verdict = await api.phoneVerify(sent.phone, sent.demoCode!);
    expect(verdict.status).toBe('password');
    if (verdict.status !== 'password') return;
    await expect(api.phonePassword(verdict.ticket, 'ne-tot')).rejects.toMatchObject({ status: 403 });
    const res = await api.phonePassword(verdict.ticket, PASSWORD);
    expect(res.status === 'signed-in' && res.user.username).toBe('demo');
  });

  it('вход — событие «вход в аккаунт», регистрация — без него', async () => {
    await api.logout();
    await loginAs('demo');
    const { notifications } = await api.notifications();
    expect(notifications[0]).toMatchObject({ kind: 'new_login', readAt: null });
    expect(notifications[0].actor.username).toBe('demo');
    expect(typeof notifications[0].device).toBe('string');

    await api.logout();
    const sent = await api.phoneStart('+996700998877');
    const verdict = await api.phoneVerify(sent.phone, sent.demoCode!);
    if (verdict.status !== 'signup') throw new Error(verdict.status);
    await api.phoneSignup(verdict.ticket, 'bez_sobytiya', 'Новичок');
    expect((await api.notifications()).notifications).toHaveLength(0);
  });

  it('новый код сразу — 429, мусор вместо номера — 400', async () => {
    await api.phoneStart('+996700445566');
    await expect(api.phoneStart('+996700445566')).rejects.toMatchObject({ status: 429 });
    await expect(api.phoneStart('123')).rejects.toMatchObject({ status: 400 });
  });
});

describe('витрина: поиск по номеру', () => {
  it('находит только разрешивших; «мои подписки» — только тех, на кого подписан владелец', async () => {
    const hits = async (phones: string[]) => (await api.findByPhone(phones)).users.map((u) => u.username);
    expect(await hits(['+996 555 00-00-02', 'мусор'])).toEqual(['marina']);
    // Олега по номеру находят те, на кого подписан он сам.
    await loginAs('oleg_k');
    await api.setFollow('demo', false);
    await loginAs('demo');
    expect(await hits(['+996555000003'])).toEqual([]);
    await loginAs('oleg_k');
    await api.setFollow('demo', true);
    await loginAs('demo');
    expect(await hits(['+996555000003'])).toEqual(['oleg_k']);
    expect(await hits(['+996555000001'])).toEqual([]);
    await expect(api.findByPhone([])).rejects.toMatchObject({ status: 400 });
  });

  it('номер в профиле: гостю нет, «мои подписки» — только тем, на кого подписан владелец', async () => {
    await loginAs('marina');
    await api.setFollow('demo', false);
    await loginAs('demo');
    expect((await api.profile('marina')).user.phone).toBeNull();
    await loginAs('marina');
    await api.setFollow('demo', true);
    await loginAs('demo');
    expect((await api.profile('marina')).user.phone).toBe('+996555000002');
    await api.logout();
    expect((await api.profile('marina')).user.phone).toBeNull();
  });

  it('настройки меняются по одной, без галочки при регистрации — не находят', async () => {
    expect(await api.setPrivacy({ phoneFind: 'all' })).toMatchObject({ phoneFind: 'all', phoneShow: 'nobody', lastSeen: 'all' });
    await expect(api.setPrivacy({})).rejects.toMatchObject({ status: 400 });
    await api.logout();
    const sent = await api.phoneStart('+996700123123');
    const verdict = await api.phoneVerify(sent.phone, sent.demoCode!);
    if (verdict.status !== 'signup') throw new Error(verdict.status);
    await api.phoneSignup(verdict.ticket, 'tihij', 'Тихий');
    expect((await api.account()).phoneFind).toBe('nobody');
  });
});

describe('витрина: черновики', () => {
  it('засев: недописанное Олегу видно в списке, отправка снимает черновик', async () => {
    const row = async () => (await api.conversations()).conversations.find((c) => c.user.username === 'oleg_k')!;
    expect((await row()).draft?.body).toMatch(/^Да, Am7/);
    await api.sendSticker('oleg_k', 'plenka/hi');
    expect((await row()).draft).not.toBeNull();
    await api.sendMessage('oleg_k', 'Да, Am7');
    expect((await row()).draft).toBeNull();
  });

  it('пустой — удалён; в чужой группе и чужом канале черновика нет', async () => {
    expect((await api.saveDraft('dm', 'marina', 'Марина, ')).draft?.body).toBe('Марина, ');
    expect((await api.saveDraft('dm', 'marina', '   ')).draft).toBeNull();
    expect((await api.draft('dm', 'marina')).draft).toBeNull();
    await expect(api.saveDraft('chat', 999_999, 'x')).rejects.toMatchObject({ status: 404 });
    // Канал Нины: смотрящий подписан, но публиковать в нём не может.
    await expect(api.saveDraft('channel', 'plenka_notes', 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('черновик в группе — в списке; выход из группы его уносит', async () => {
    const chat = await room();
    await api.saveDraft('chat', chat.id, 'Про проявку: ');
    expect((await room()).draft?.body).toBe('Про проявку: ');
    await api.removeChatMember(chat.id, 'demo');
    await expect(api.draft('chat', chat.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('витрина: ссылка-приглашение', () => {
  it('владелец создаёт ссылку, по ней вступают; сменённая перестаёт работать', async () => {
    const chat = await room();
    expect(chat.invite).toBeNull();
    const { invite } = await api.createInvite(chat.id);
    expect(invite).toMatch(/^[A-Za-z0-9_-]{22}$/);

    await loginAs('oleg_k');
    const preview = await api.invitePreview(invite);
    expect(preview.chat.title).toBe('Плёнка и проявка');
    // Олега в группе нет: по ссылке он видит состав, но ещё не участник.
    expect(preview.member).toBe(false);
    const { chat: joined } = await api.joinByInvite(invite);
    expect(joined.members.some((m) => m.username === 'oleg_k')).toBe(true);
    // Пришедший по ссылке начинает с «сейчас»: старое не падает непрочитанным.
    expect((await api.chats()).chats.find((c) => c.id === chat.id)?.unread).toBe(0);

    await loginAs('demo');
    const { invite: next } = await api.createInvite(chat.id);
    expect(next).not.toBe(invite);
    await expect(api.invitePreview(invite)).rejects.toMatchObject({ status: 404 });
    await api.revokeInvite(chat.id);
    await expect(api.joinByInvite(next)).rejects.toMatchObject({ status: 404 });
  });

  it('управлять ссылкой может только владелец', async () => {
    const chat = await room();
    await loginAs('nina');
    await expect(api.createInvite(chat.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe('витрина: администраторы группы', () => {
  it('владелец назначает админа; админ настраивает группу и убирает участника', async () => {
    const chat = await room();
    expect(chat.myRole).toBe('owner');
    const { chat: withAdmin } = await api.setChatAdmin(chat.id, 'marina', true);
    expect(withAdmin.members.find((m) => m.username === 'marina')?.role).toBe('admin');

    await loginAs('marina');
    const { chat: slow } = await api.updateChat(chat.id, { slowMode: 30 });
    expect(slow.slowMode).toBe(30);
    await expect(api.updateChat(chat.id, { slowMode: 7 })).rejects.toMatchObject({ status: 400 });
    await expect(api.setChatAdmin(chat.id, 'nina', true)).rejects.toMatchObject({ status: 403 });
    await expect(api.removeChatMember(chat.id, 'demo')).rejects.toMatchObject({ status: 403 });

    await loginAs('nina');
    await api.sendChatMessage(chat.id, 'Раз');
    await expect(api.sendChatMessage(chat.id, 'Два')).rejects.toMatchObject({ status: 429 });
    expect((await api.chat(chat.id)).chat.nextPostAt).not.toBeNull();

    await loginAs('marina');
    await api.sendChatMessage(chat.id, 'Админу можно');
    await api.sendChatMessage(chat.id, 'И ещё раз');
    await api.updateChat(chat.id, { slowMode: 0, adminsOnly: true });
    await loginAs('nina');
    await expect(api.sendChatMessage(chat.id, 'А мне?')).rejects.toMatchObject({ status: 403 });
    expect((await api.chat(chat.id)).chat.adminsOnly).toBe(true);
  });
});

describe('витрина: кто прочитал', () => {
  it('автору — прочитавшие и нет; чужое — 403', async () => {
    const chat = await room();
    const { message } = await api.sendChatMessage(chat.id, 'Прочтите');
    let r = await api.chatReaders(chat.id, message.id);
    expect(r.read).toHaveLength(0);
    expect(r.unread.map((p) => p.username).sort()).toEqual(['marina', 'nina']);
    await loginAs('nina');
    await api.markChatRead(chat.id);
    await expect(api.chatReaders(chat.id, message.id)).rejects.toMatchObject({ status: 403 });
    await loginAs('demo');
    r = await api.chatReaders(chat.id, message.id);
    expect(r.read.map((p) => p.username)).toEqual(['nina']);
  });
});

describe('витрина: кто поставил реакцию', () => {
  it('любому участнику, свежие сверху; смена реакции — одна запись', async () => {
    const chat = await room();
    const { message } = await api.sendChatMessage(chat.id, 'Кто за?');
    await loginAs('nina');
    await api.reactChatMessage(chat.id, message.id, '👍');
    await loginAs('marina');
    await api.reactChatMessage(chat.id, message.id, '🔥');
    let r = await api.chatReactions(chat.id, message.id);
    expect(r.reactions.map((x) => x.user.username + x.emoji)).toEqual(['marina🔥', 'nina👍']);
    await loginAs('nina');
    await api.reactChatMessage(chat.id, message.id, '❤️');
    await loginAs('demo');
    r = await api.chatReactions(chat.id, message.id);
    expect(r.reactions.map((x) => x.user.username + x.emoji)).toEqual(['nina❤️', 'marina🔥']);
  });
});

describe('витрина: вход с кодом из приложения', () => {
  it('подключение, вход с кодом и резервным, отключение', async () => {
    await expect(api.twoFactorSetup('ne-tot')).rejects.toMatchObject({ status: 403 });
    const { secret, uri } = await api.twoFactorSetup(PASSWORD);
    expect(uri).toContain(`secret=${secret}`);
    await expect(api.twoFactorEnable('000000' === totpNow(secret) ? '111111' : '000000')).rejects.toMatchObject({ status: 403 });
    const { backupCodes } = await api.twoFactorEnable(totpNow(secret));
    expect(backupCodes).toHaveLength(10);
    expect((await api.account()).twoFactor).toEqual({ enabled: true, backupCodesLeft: 10 });

    const step = await loginAs('demo');
    expect(step.status).toBe('two-factor');
    const ticket = step.status === 'two-factor' ? step.ticket : '';
    await expect(api.twoFactorLogin(ticket, '12345')).rejects.toMatchObject({ status: 403 });
    expect((await api.twoFactorLogin(ticket, totpNow(secret, 1))).user.username).toBe('demo');
    await expect(api.twoFactorLogin(ticket, totpNow(secret, 1))).rejects.toMatchObject({ status: 410 });

    const again = await loginAs('demo');
    const res = await api.twoFactorLogin(again.status === 'two-factor' ? again.ticket : '', backupCodes[0].toUpperCase());
    expect(res.backupCodesLeft).toBe(9);

    await expect(api.twoFactorDisable(PASSWORD, backupCodes[0])).rejects.toMatchObject({ status: 403 });
    await api.twoFactorDisable(PASSWORD, backupCodes[1]);
    expect((await loginAs('demo')).status).toBeUndefined();
  });
});

describe('витрина: кнопка «@»', () => {
  it('непрочитанные упоминания — с первой страницей, прочитал — пусто', async () => {
    const chat = await room();
    await loginAs('nina');
    const { message } = await api.sendChatMessage(chat.id, '@demo, глянь');
    await loginAs('demo');
    // В засеве у этого чата уже есть упоминание — новое встаёт в очередь последним.
    expect((await api.chatMessages(chat.id)).unreadMentions?.at(-1)).toBe(message.id);
    expect((await api.chatMessages(chat.id, message.id)).unreadMentions).toBeUndefined();
    await api.markChatRead(chat.id);
    expect((await api.chatMessages(chat.id)).unreadMentions).toEqual([]);
  });
});

describe('витрина: предпросмотр ссылок', () => {
  it('карточка только у заготовленной ссылки', async () => {
    expect((await api.linkPreview('https://github.com/erlan4761/Social-site')).preview?.siteName).toBe('GitHub');
    expect((await api.linkPreview('https://example.com/')).preview).toBeNull();
  });
});

describe('витрина: альбомы', () => {
  const photo = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
  it('снимки с одним кодом — альбом; документ и чужой альбом — 400', async () => {
    const album = 'albumdemo0001';
    await api.sendAttachment('marina', { file: photo('1.png'), name: '1.png', body: 'Два кадра', album });
    const { message } = await api.sendAttachment('marina', { file: photo('2.png'), name: '2.png', album });
    expect(message.albumId).toBe(album);
    await expect(api.sendAttachment('marina', { file: new File(['x'], 'a.pdf', { type: 'application/pdf' }), name: 'a.pdf', album })).rejects.toMatchObject({ status: 400 });
    await expect(api.sendAttachment('oleg_k', { file: photo('3.png'), name: '3.png', album })).rejects.toMatchObject({ status: 400 });
    const { messages } = await api.thread('marina');
    expect(messages.filter((m) => m.albumId === album)).toHaveLength(2);
  });

  it('альбом в канале и пересылка альбома целиком', async () => {
    const album = 'albumchan0001';
    const first = await api.publish('chronika_dev', { file: photo('1.png'), name: '1.png', body: 'Репортаж', album });
    const second = await api.publish('chronika_dev', { file: photo('2.png'), name: '2.png', album });
    expect([first.post.albumId, second.post.albumId]).toEqual([album, album]);

    const copy = 'albumfwd00001';
    for (const post of [first.post, second.post]) await api.forward({ kind: 'dm', username: 'oleg_k' }, { from: 'channel', id: post.id }, copy);
    const { messages } = await api.thread('oleg_k');
    const forwarded = messages.filter((m) => m.albumId === copy);
    expect(forwarded.map((m) => m.body)).toEqual(['Репортаж', '']);
    expect(forwarded.every((m) => m.forwardedFrom?.kind === 'channel')).toBe(true);
    // Текст альбомом не переслать — как на сервере.
    const text = (await api.sendMessage('oleg_k', 'Просто текст')).message;
    await expect(api.forward({ kind: 'dm', username: 'marina' }, { from: 'dm', id: text.id }, 'albumtext0001')).rejects.toMatchObject({ status: 400 });
  });
});

describe('витрина: смена логина', () => {
  it('новый логин — сразу, старый закреплён за прежним владельцем', async () => {
    const res = await api.changeUsername('Erlan_New');
    expect(res.user.username).toBe('erlan_new');
    expect(res.previous).toBe('demo');
    expect((await api.me()).user?.username).toBe('erlan_new');
    await expect(api.changeUsername('marina')).rejects.toMatchObject({ status: 409 });
    await loginAs('marina');
    await expect(api.changeUsername('demo')).rejects.toMatchObject({ status: 409 });
    await loginAs('erlan_new');
    expect((await api.changeUsername('demo')).user.username).toBe('demo');
  });
});

describe('витрина: модерация', () => {
  it('жалобы на снимок Нины сгруппированы; «оставить» закрывает их', async () => {
    const { reports } = await api.moderationReports('open');
    expect(reports[0]).toMatchObject({ targetType: 'post', count: 2 });
    expect(reports[0].subject?.author?.username).toBe('nina');
    await api.resolveReport('post', reports[0].targetId, 'dismiss');
    expect((await api.moderationReports('open')).reports).toHaveLength(0);
    expect((await api.moderationReports('resolved')).reports[0].resolution).toBe('dismissed');
  });

  it('блокировка: заблокированный не входит, после снятия — входит', async () => {
    const { reports } = await api.moderationReports('open');
    await api.resolveReport('post', reports[0].targetId, 'ban');
    expect((await api.bannedUsers()).users.map((u) => u.username)).toEqual(['nina']);
    await expect(loginAs('nina')).rejects.toMatchObject({ status: 403 });
    await loginAs('demo');
    await api.unbanUser('nina');
    const back = await loginAs('nina');
    expect('user' in back ? back.user.username : null).toBe('nina');
  });

  it('не модератору панель закрыта', async () => {
    await loginAs('marina');
    await expect(api.moderationReports('open')).rejects.toMatchObject({ status: 403 });
  });
});

describe('витрина: архив', () => {
  it('в архив — и обратно с новым сообщением, если не приглушён', async () => {
    const row = async () => (await api.conversations()).conversations.find((c) => c.user.username === 'marina')!;
    expect((await api.setPref('dm', 'marina', { archived: true })).archived).toBe(true);
    expect((await row()).archived).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await loginAs('marina');
    await api.sendMessage('demo', 'Выходи из архива');
    await loginAs('demo');
    expect((await row()).archived).toBe(false);
    await api.setPref('dm', 'marina', { archived: true, muted: true });
    await new Promise((r) => setTimeout(r, 5));
    await loginAs('marina');
    await api.sendMessage('demo', 'Я приглушена');
    await loginAs('demo');
    expect((await row()).archived).toBe(true);
  });
});

describe('витрина: вход по QR-коду', () => {
  it('код с «компьютера» подтверждают на «телефоне» — и компьютер входит', async () => {
    await api.logout();
    const qr = await api.qrLoginStart();
    expect(await api.qrLoginPoll(qr.token, qr.secret)).toEqual({ status: 'pending' });
    await loginAs('marina');
    await expect(api.qrApprove({ code: 'AAAAAAAA' })).rejects.toMatchObject({ status: 404 });
    await api.qrApprove({ code: `${qr.code.slice(0, 4).toLowerCase()}-${qr.code.slice(4)}` });
    await api.logout();
    const res = await api.qrLoginPoll(qr.token, qr.secret);
    expect(res.status === 'approved' && res.user.username).toBe('marina');
    await expect(api.qrLoginPoll(qr.token, qr.secret)).rejects.toMatchObject({ status: 410 });
  });
});

describe('витрина: автоудаление', () => {
  it('таймер общий, новые сообщения получают срок, истёкшие убираются', async () => {
    const { sweepExpired } = await import('./model/autoDelete');
    const { db } = await import('./store');
    await expect(api.setDmAutoDelete('marina', 5)).rejects.toMatchObject({ status: 400 });
    await api.setDmAutoDelete('marina', 86_400);
    await loginAs('marina');
    expect((await api.thread('demo')).autoDelete).toBe(86_400);
    const { message } = await api.sendMessage('demo', 'Исчезну');
    expect(Date.parse(message.expiresAt!) - Date.now()).toBeGreaterThan(86_300_000);
    db.messages.find((m) => m.id === message.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    sweepExpired();
    expect((await api.thread('demo')).messages.some((m) => m.id === message.id)).toBe(false);
  });
});

describe('витрина: выгрузка данных', () => {
  it('свой профиль, свои записи, переписки обеих сторон — без пароля', async () => {
    const data = await api.exportData();
    expect(data.profile.username).toBe('demo');
    expect((data.posts as unknown[]).length).toBeGreaterThan(0);
    const convs = data.conversations as { with: string; messages: { from: string }[] }[];
    const oleg = convs.find((c) => c.with === 'oleg_k')!;
    expect(oleg.messages.some((m) => m.from === 'me') && oleg.messages.some((m) => m.from === 'oleg_k')).toBe(true);
    expect(JSON.stringify(data)).not.toContain('parol12345');
  });
});

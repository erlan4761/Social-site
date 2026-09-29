import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi as api } from './mockApi';
import { seed } from './seed';
import { deliverDueScheduled } from './model/scheduled';

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
    await api.setLastSeen('nobody');
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
    expect((await api.phonePassword(verdict.ticket, PASSWORD)).user.username).toBe('demo');
  });

  it('новый код сразу — 429, мусор вместо номера — 400', async () => {
    await api.phoneStart('+996700445566');
    await expect(api.phoneStart('+996700445566')).rejects.toMatchObject({ status: 429 });
    await expect(api.phoneStart('123')).rejects.toMatchObject({ status: 400 });
  });
});

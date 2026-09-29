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
    await expect(api.deleteAccount('ne-tot')).rejects.toMatchObject({ status: 403 });
    await api.deleteAccount(PASSWORD);
    expect((await api.me()).user).toBeNull();
    await expect(loginAs('demo')).rejects.toMatchObject({ status: 401 });
  });

  it('папка без видов и чатов — 400', async () => {
    await expect(api.createFolder({ title: 'Пусто' })).rejects.toMatchObject({ status: 400 });
  });
});

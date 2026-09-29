import { type Poll, type PollInput } from '../../api';
import { type DbPoll, db, id, fail } from '../store';
import { byId, requireMe, author, hidden } from './people';
import { memberRow } from './chats';

/** Опросы — как polls.js. */

/** Опрос глазами смотрящего — как serializePoll() в polls.js. */
export function toPoll(poll: DbPoll, authorId: number): Poll {
  const votes = db.pollVotes.filter((v) => v.pollId === poll.id);
  const mine = votes.filter((v) => v.userId === db.meId).map((v) => v.optionId);
  const closed = poll.closedAt != null;
  const results = closed || mine.length > 0 || db.meId === authorId;
  return {
    id: poll.id, multiple: poll.multiple, anonymous: poll.anonymous, closed,
    total: new Set(votes.map((v) => v.userId)).size,
    myVotes: mine,
    canClose: !closed && db.meId === authorId,
    options: poll.options.map((o) => {
      const here = votes.filter((v) => v.optionId === o.id);
      return {
        id: o.id, text: o.text,
        votes: results ? here.length : null,
        voters: results && !poll.anonymous
          ? here.filter((v) => v.userId === db.meId || !hidden(v.userId)).map((v) => author(byId(v.userId)!))
          : [],
      };
    }),
  };
}

export const pollOf = (kind: 'chat' | 'channel', messageId: number) => db.polls.find((x) => x.kind === kind && x.messageId === messageId);

export function readPoll(raw: PollInput) {
  const question = (raw.question ?? '').trim();
  if (!question) fail(400, 'У опроса должен быть вопрос');
  if (question.length > 255) fail(400, 'Вопрос — не длиннее 255 символов');
  const options = (raw.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (options.length < 2 || options.length > 10) fail(400, 'Вариантов ответа — от 2 до 10');
  if (options.some((o) => o.length > 100)) fail(400, 'Вариант ответа — не длиннее 100 символов');
  if (new Set(options.map((o) => o.toLocaleLowerCase('ru'))).size !== options.length) fail(400, 'Варианты ответа не должны повторяться');
  return { question, options, multiple: raw.multiple === true, anonymous: raw.anonymous !== false };
}

export function addPoll(kind: 'chat' | 'channel', messageId: number, input: ReturnType<typeof readPoll>) {
  db.polls.push({
    id: id(), kind, messageId, multiple: input.multiple, anonymous: input.anonymous, closedAt: null,
    options: input.options.map((text) => ({ id: id(), text })),
  });
}

/** Опрос, видимый смотрящему, и его автор — как visiblePoll() в routes/polls.js. */
export function requirePoll(pollId: number) {
  const u = requireMe()!;
  const poll = db.polls.find((x) => x.id === pollId);
  if (poll?.kind === 'chat') {
    const m = db.chatMessages.find((x) => x.id === poll.messageId);
    if (m && memberRow(m.chatId, u.id) && !hidden(m.authorId)) return { u, poll, authorId: m.authorId };
  } else if (poll) {
    const post = db.channelPosts.find((x) => x.id === poll.messageId);
    const c = post ? db.channels.find((x) => x.id === post.channelId) : undefined;
    if (c) return { u, poll, authorId: c.ownerId };
  }
  return fail(404, 'Опрос не найден');
}

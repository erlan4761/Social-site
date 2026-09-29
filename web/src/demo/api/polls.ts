import { db, tick, fail } from '../store';
import { toPoll, requirePoll } from '../model/polls';

/** Методы витрины: голос и завершение опроса. */

export const pollsApi = {
  votePoll: (pollId: number, options: number[]) => {
    const { u, poll, authorId } = requirePoll(pollId);
    if (poll.closedAt) fail(400, 'Опрос завершён — голосовать больше нельзя');
    const chosen = [...new Set(options)];
    if (!poll.multiple && chosen.length > 1) fail(400, 'В этом опросе можно выбрать только один вариант');
    if (chosen.some((x) => !poll.options.some((o) => o.id === x))) fail(400, 'Такого варианта в опросе нет');
    db.pollVotes = db.pollVotes.filter((v) => !(v.pollId === poll.id && v.userId === u.id));
    for (const optionId of chosen) db.pollVotes.push({ pollId: poll.id, optionId, userId: u.id, createdAt: new Date().toISOString() });
    return tick({ poll: toPoll(poll, authorId) });
  },

  closePoll: (pollId: number) => {
    const { u, poll, authorId } = requirePoll(pollId);
    if (authorId !== u.id) fail(403, 'Завершить опрос может только его автор');
    poll.closedAt ??= new Date().toISOString();
    return tick({ poll: toPoll(poll, authorId) });
  },
};

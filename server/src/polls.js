import { db, nowIso } from './db.js';
import { isBlockedPair } from './blocks.js';
import { publicUrl } from './media.js';
import { bad } from './validate.js';

/**
 * Опросы — в группах и каналах, как в Телеграме. Опрос не отдельная сущность
 * ленты, а приложение к сообщению или публикации: вопрос — это текст самого
 * сообщения, поэтому его видно в превью списка, в ответах и в поиске без
 * особых случаев. Строка polls ссылается на сообщение внешним ключом с
 * каскадом — удалили сообщение, чат или канал, и опрос ушёл вместе с голосами.
 *
 * Результаты видны тому, кто уже проголосовал, автору и всем после завершения:
 * иначе первые проценты подсказывали бы, за что голосовать.
 *
 * Викторина — опрос с одним правильным ответом, как в Телеграме: ответ один и
 * окончательный (не меняется и не отзывается), правильный вариант и пояснение
 * открываются ответившему, автору и всем после завершения — до того они были
 * бы подсказкой.
 */

export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 10;
const QUESTION_MAX = 255;
const OPTION_MAX = 100;
export const EXPLANATION_MAX = 200;

const COLUMN = { chat: 'chat_message_id', channel: 'channel_post_id' };

/** Опрос из тела запроса — или 400 с понятной причиной. */
export function readPoll(raw) {
  if (raw == null || typeof raw !== 'object') throw bad('Опрос — вопрос и варианты ответа');
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (!question) throw bad('У опроса должен быть вопрос');
  if (question.length > QUESTION_MAX) throw bad(`Вопрос — не длиннее ${QUESTION_MAX} символов`);

  if (!Array.isArray(raw.options)) throw bad('Варианты ответа — список строк');
  const options = raw.options.map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean);
  if (options.length < POLL_OPTIONS_MIN || options.length > POLL_OPTIONS_MAX) {
    throw bad(`Вариантов ответа — от ${POLL_OPTIONS_MIN} до ${POLL_OPTIONS_MAX}`);
  }
  if (options.some((o) => o.length > OPTION_MAX)) throw bad(`Вариант ответа — не длиннее ${OPTION_MAX} символов`);
  const seen = new Set(options.map((o) => o.toLocaleLowerCase('ru')));
  if (seen.size !== options.length) throw bad('Варианты ответа не должны повторяться');

  for (const flag of ['multiple', 'anonymous', 'quiz']) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') throw bad(`«${flag}» — true или false`);
  }
  const quiz = raw.quiz === true;
  let correct = null;
  let explanation = null;
  if (quiz) {
    if (raw.multiple === true) throw bad('В викторине один правильный ответ — «несколько ответов» к ней не подходит');
    // Номер правильного — среди вариантов, как они пришли после очистки пустых.
    correct = raw.correct;
    if (!Number.isSafeInteger(correct) || correct < 0 || correct >= options.length) {
      throw bad('Отметьте правильный ответ викторины');
    }
    if (raw.explanation != null) {
      if (typeof raw.explanation !== 'string') throw bad('Пояснение — строка');
      explanation = raw.explanation.trim() || null;
      if (explanation && explanation.length > EXPLANATION_MAX) throw bad(`Пояснение — не длиннее ${EXPLANATION_MAX} символов`);
    }
  }
  return { question, options, multiple: raw.multiple === true && !quiz, anonymous: raw.anonymous !== false, quiz, correct, explanation };
}

export function createPoll(kind, messageId, poll) {
  const info = db.prepare(`INSERT INTO polls (${COLUMN[kind]}, multiple, anonymous, quiz, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(messageId, poll.multiple ? 1 : 0, poll.anonymous ? 1 : 0, poll.quiz ? 1 : 0, poll.explanation ?? null, nowIso());
  const pollId = Number(info.lastInsertRowid);
  const insert = db.prepare('INSERT INTO poll_options (poll_id, position, text) VALUES (?, ?, ?)');
  const ids = poll.options.map((text, i) => Number(insert.run(pollId, i, text).lastInsertRowid));
  if (poll.quiz) db.prepare('UPDATE polls SET correct_option_id = ? WHERE id = ?').run(ids[poll.correct], pollId);
  return pollId;
}

export const hasPoll = (kind, messageId) =>
  Boolean(db.prepare(`SELECT 1 FROM polls WHERE ${COLUMN[kind]} = ?`).get(messageId));

/**
 * Опрос для смотрящего. authorId — кто его создал (автор сообщения или
 * владелец канала): ему результаты видны сразу, и завершить опрос может он.
 */
export function serializePoll(poll, viewerId, authorId) {
  const options = db.prepare('SELECT id, text FROM poll_options WHERE poll_id = ? ORDER BY position').all(poll.id);
  const votes = db.prepare(`
    SELECT v.option_id, v.user_id, u.username, u.display_name, u.avatar_path
    FROM poll_votes v JOIN users u ON u.id = v.user_id
    WHERE v.poll_id = ? ORDER BY v.created_at
  `).all(poll.id);

  const mine = votes.filter((v) => v.user_id === viewerId).map((v) => v.option_id);
  const closed = poll.closed_at != null;
  const results = closed || mine.length > 0 || viewerId === authorId;
  const anonymous = Boolean(poll.anonymous);
  const quiz = Boolean(poll.quiz);

  return {
    id: poll.id,
    multiple: Boolean(poll.multiple),
    anonymous,
    closed,
    quiz,
    // Ответ викторины и пояснение — тем же, кому видны итоги: иначе подсказка.
    correctOptionId: quiz && results ? poll.correct_option_id : null,
    explanation: quiz && results ? poll.explanation ?? null : null,
    // Голосовавших людей, а не голосов: при нескольких ответах голосов больше.
    total: new Set(votes.map((v) => v.user_id)).size,
    myVotes: mine,
    canClose: !closed && viewerId === authorId,
    options: options.map((o) => {
      const here = votes.filter((v) => v.option_id === o.id);
      return {
        id: o.id,
        text: o.text,
        votes: results ? here.length : null,
        // Открытый опрос показывает, кто за что; заблокированных смотрящий не видит.
        voters: results && !anonymous
          ? here
            .filter((v) => v.user_id === viewerId || !isBlockedPair(viewerId, v.user_id))
            .map((v) => ({ id: v.user_id, username: v.username, displayName: v.display_name, avatarUrl: publicUrl('avatar', v.avatar_path) }))
          : [],
      };
    }),
  };
}

/** Проставляет poll сообщениям страницы; authorOf(m) — кто создал опрос. */
export function withPolls(kind, messages, viewerId, authorOf) {
  if (messages.length === 0) return messages;
  const rows = db.prepare(`
    SELECT * FROM polls WHERE ${COLUMN[kind]} IN (${messages.map(() => '?').join(', ')})
  `).all(...messages.map((m) => m.id));
  const byMessage = new Map(rows.map((r) => [r[COLUMN[kind]], r]));
  return messages.map((m) => {
    const poll = byMessage.get(m.id);
    return { ...m, poll: poll ? serializePoll(poll, viewerId, authorOf(m)) : null };
  });
}

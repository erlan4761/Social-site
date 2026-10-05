import { Router } from 'express';
import multer from 'multer';
import { db, nowIso } from '../db.js';
import { requireAuth, publicUser } from '../auth.js';
import { blockPairSql, isBlockedPair } from '../blocks.js';
import { deleteUpload, publicUrl, storeUpload } from '../media.js';
import { dropNotification, notify } from '../notifications.js';
import { REPOST_VISIBLE_SQL } from './posts.js';
import { findByPhones, LOOKUP_MAX, visiblePhone } from '../phoneBook.js';
import * as v from '../validate.js';

export const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const followerCount = (id) => db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followee_id = ?').get(id).c;
const followingCount = (id) => db.prepare('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?').get(id).c;

const person = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  avatarUrl: publicUrl('avatar', row.avatar_path),
});

// Текст одинаков в обе стороны и не называет причину: заблокированный не
// должен по формулировке понять, что его заблокировали именно здесь.
const BLOCKED_PAIR_MESSAGE = 'Действие с этим пользователем недоступно';

router.patch('/me', requireAuth, (req, res, next) => {
  try {
    const displayName = v.str(req.body?.displayName, 'имя', { min: 1, max: 40 });
    const bio = v.str(req.body?.bio ?? '', 'о себе', { max: 200 });

    db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?')
      .run(displayName, bio, req.user.id);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.put('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const stored = await storeUpload(req.file.buffer, { allowedKinds: ['image'], into: 'avatar' });

    const previous = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(stored.filename, req.user.id);
    deleteUpload('avatar', previous?.avatar_path);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.delete('/me/avatar', requireAuth, (req, res) => {
  const previous = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user.id);
  db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(req.user.id);
  deleteUpload('avatar', previous?.avatar_path);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// Перед /:username — иначе Express принял бы "search" за чьё-то имя пользователя.
//
// Фильтрация идёт в JS, а не в SQL: SQLite LIKE регистронезависим только для
// ASCII, "Борис" не совпадёт с "борис" через LIKE — нужна юникодная
// нормализация, а её у SQLite из коробки нет. String.toLowerCase() в JS
// с кириллицей справляется сама, и таблица пользователей достаточно мала,
// чтобы прогонять её целиком в памяти на каждый запрос.
router.get('/search', (req, res) => {
  const raw = String(req.query.q ?? '').trim().slice(0, 40);
  if (!raw) return res.json({ users: [] });

  const q = raw.toLowerCase();

  // Обе стороны блокировки выпадают из выдачи: заблокировавший не хочет
  // видеть человека, а заблокированному незачем находить того, кому он всё
  // равно не сможет ни написать, ни подписаться.
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path
    FROM users u
    WHERE ${blockPairSql('u.id')}
  `).all({ viewerId: req.user?.id ?? null });

  const scored = rows
    .map((row) => {
      const username = row.username.toLowerCase();
      const displayName = row.display_name.toLowerCase();
      let rank;
      if (username === q) rank = 0;
      else if (username.startsWith(q)) rank = 1;
      else if (displayName.startsWith(q)) rank = 2;
      else if (username.includes(q) || displayName.includes(q)) rank = 3;
      else rank = null;
      return rank === null ? null : { row, rank };
    })
    .filter((x) => x !== null)
    .sort((a, b) => a.rank - b.rank || a.row.username.localeCompare(b.row.username))
    .slice(0, 20);

  res.json({ users: scored.map(({ row }) => person(row)) });
});

/**
 * Найти людей по номерам — набранному в поиске или выбранным из контактов.
 * Только целиком и только тех, кто разрешил (см. phoneBook.js). В ответе —
 * номер, по которому человек нашёлся: его прислал сам спрашивающий, и без него
 * не сопоставить найденного с контактом.
 */
router.post('/by-phone', requireAuth, (req, res) => {
  const phones = req.body?.phones;
  if (!Array.isArray(phones) || phones.length === 0 || phones.length > LOOKUP_MAX || !phones.every((x) => typeof x === 'string')) {
    return res.status(400).json({ error: `Номера — списком строк, от 1 до ${LOOKUP_MAX}` });
  }
  const followed = new Set(
    db.prepare('SELECT followee_id AS id FROM follows WHERE follower_id = ?').all(req.user.id).map((r) => r.id),
  );
  res.json({
    users: findByPhones(req.user.id, phones).map((row) => ({
      ...person(row),
      phone: row.phone,
      followedByMe: followed.has(row.id),
    })),
  });
});

// Тоже перед /:username — иначе Express принял бы "me" за чьё-то имя.
router.get('/me/blocks', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path
    FROM blocks b JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ?
    ORDER BY b.created_at DESC
  `).all(req.user.id);

  res.json({ users: rows.map(person) });
});

/**
 * Архив записей по месяцам: только те месяцы, где смотрящему реально есть что
 * открыть, новые сверху.
 *
 * Блокировка учитывается тем же фрагментом, что и лента с `postCount`: число в
 * архиве обязано совпасть с тем, что откроется по клику. «В мае 3 записи» над
 * пустым списком — это не мелкая неточность, а сломанный сайт с точки зрения
 * человека.
 *
 * `total` считается сложением тех же самых чисел, а не отдельным COUNT(*):
 * два запроса могли бы разойтись между собой, а сумма разойтись с слагаемыми
 * не может.
 *
 * Месяц берётся срезом ISO-строки, то есть по UTC. Запись, сделанная 1 октября
 * в 02:00 по Бишкеку, попадёт в сентябрь; чинить это правильно значит хранить
 * смещение автора, а его в схеме нет. Названо в README прямо.
 *
 * Путь из двух сегментов, `/:username` его не перехватывает; с `/me/blocks`
 * тоже не спорит — второй сегмент другой, а имени «me» не существует
 * (логин от трёх символов).
 */
router.get('/:username/archive', (req, res) => {
  const uname = String(req.params.username).toLowerCase();
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  // Несуществующий автор — 404, как и его профиль: пустой архив означал бы
  // «человек есть, записей нет», а это другое утверждение.
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const months = db.prepare(`
    SELECT substr(p.created_at, 1, 7) AS month, COUNT(*) AS count
    FROM posts p
    WHERE p.author_id = :authorId AND ${blockPairSql('p.author_id')} AND ${REPOST_VISIBLE_SQL}
    GROUP BY month
    ORDER BY month DESC
  `).all({ authorId: user.id, viewerId: req.user?.id ?? null });

  res.json({
    months,
    total: months.reduce((sum, m) => sum + m.count, 0),
  });
});

router.get('/:username', (req, res) => {
  const uname = String(req.params.username).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const viewerId = req.user?.id ?? null;

  // Профиль остаётся видимым — прячется только контент. Счётчик постов при
  // этом обязан совпадать с лентой профиля, а она у заблокированной пары
  // пуста: «12 записей» над пустым списком выглядели бы как поломка.
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count FROM posts p
    WHERE p.author_id = :authorId AND ${blockPairSql('p.author_id')} AND ${REPOST_VISIBLE_SQL}
  `).get({ authorId: user.id, viewerId });

  const followedByMe = req.user
    ? Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, user.id))
    : false;

  const blockedByMe = req.user
    ? Boolean(db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(req.user.id, user.id))
    : false;
  const blocksMe = req.user
    ? Boolean(db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(user.id, req.user.id))
    : false;

  res.json({
    user: {
      ...publicUser(user),
      postCount: count,
      followerCount: followerCount(user.id),
      followingCount: followingCount(user.id),
      followedByMe,
      // Два отдельных флага, а не один: «я его заблокировал» — это кнопка
      // «Разблокировать», «он меня заблокировал» — плашка без кнопки.
      blockedByMe,
      blocksMe,
      // Номер — только если владелец показывает его смотрящему (см. phoneBook.js).
      phone: visiblePhone(user, viewerId),
    },
  });
});

/* ─ Подписчики и подписки ───────────────────────────────────────────────
 * Списки открыты, как и сам профиль: кто на кого подписан, видно любому,
 * кто зашёл, — так в любой соцсети. Свежие подписки сверху, по 50, курсор —
 * rowid строки подписки (порядок вставки: без него страницы ехали бы, пока
 * кто-то подписывается). Люди, с кем смотрящий в блокировке, в списках не
 * показываются; если в блокировке сам смотрящий и владелец профиля — списки
 * пусты, как и его лента.
 */
const FOLLOW_PAGE = 50;

function followList(req, res, side) {
  const owner = db.prepare('SELECT id FROM users WHERE username = ?').get(String(req.params.username).toLowerCase());
  if (!owner) return res.status(404).json({ error: 'Пользователь не найден' });
  const viewerId = req.user?.id ?? null;
  if (viewerId != null && isBlockedPair(viewerId, owner.id)) return res.json({ users: [], nextCursor: null });

  const cursor = Number.parseInt(req.query.cursor, 10);
  // followers: кто подписан на владельца; following: на кого подписан он.
  const [match, other] = side === 'followers' ? ['f.followee_id', 'f.follower_id'] : ['f.follower_id', 'f.followee_id'];
  const rows = db.prepare(`
    SELECT f.rowid AS seq, u.id, u.username, u.display_name, u.bio, u.avatar_path, u.created_at,
           EXISTS(SELECT 1 FROM follows mine WHERE mine.follower_id = :viewerId AND mine.followee_id = u.id) AS followed_by_me
    FROM follows f JOIN users u ON u.id = ${other}
    WHERE ${match} = :ownerId AND (:cursor IS NULL OR f.rowid < :cursor) AND ${blockPairSql('u.id')}
    ORDER BY f.rowid DESC
    LIMIT :limit
  `).all({ ownerId: owner.id, viewerId, cursor: Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null, limit: FOLLOW_PAGE + 1 });

  const page = rows.slice(0, FOLLOW_PAGE);
  res.json({
    users: page.map((r) => ({ ...publicUser(r), followedByMe: Boolean(r.followed_by_me) })),
    nextCursor: rows.length > FOLLOW_PAGE ? page.at(-1).seq : null,
  });
}

router.get('/:username/followers', (req, res) => followList(req, res, 'followers'));
router.get('/:username/following', (req, res) => followList(req, res, 'following'));

router.put('/:username/follow', requireAuth, (req, res, next) => {
  try {
    const uname = String(req.params.username).toLowerCase();
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя подписаться на себя' });

    // Блокировка симметрична: подписаться нельзя ни на того, кого вы
    // заблокировали, ни на того, кто заблокировал вас.
    if (isBlockedPair(req.user.id, target.id)) {
      return res.status(400).json({ error: BLOCKED_PAIR_MESSAGE });
    }

    // Idempotent: subscribing twice is not an error, the row is simply already there.
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)')
      .run(req.user.id, target.id, nowIso());

    // У подписки нет объекта: событие опознаётся парой «получатель + актор»,
    // поэтому повторная подписка второго уведомления не создаёт.
    notify({ userId: target.id, actorId: req.user.id, kind: 'follow' });

    res.json({ followedByMe: true, followerCount: followerCount(target.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:username/follow', requireAuth, (req, res, next) => {
  try {
    const uname = String(req.params.username).toLowerCase();
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, target.id);

    dropNotification({ userId: target.id, actorId: req.user.id, kind: 'follow' });

    res.json({ followedByMe: false, followerCount: followerCount(target.id) });
  } catch (err) {
    next(err);
  }
});

/* ─ Блокировки ─────────────────────────────────────────────────────────── */

/**
 * Блокировка — не только строка в таблице: она обязана убрать следы прошлой
 * связи. Иначе заблокированный остался бы у вас в подписчиках, а его старые
 * лайки — в счётчике событий, и «заблокировал» ощущалось бы как «ничего не
 * произошло». Все три действия идут одной транзакцией: половина блокировки
 * хуже, чем её отсутствие.
 */
router.put('/:username/block', requireAuth, (req, res, next) => {
  try {
    const uname = String(req.params.username).toLowerCase();
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя заблокировать себя' });

    const me = req.user.id;
    db.exec('BEGIN');
    try {
      // Идемпотентно: повторная блокировка — не ошибка, строка просто уже есть.
      db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
        .run(me, target.id, nowIso());

      db.prepare(`
        DELETE FROM follows
        WHERE (follower_id = :me AND followee_id = :other)
           OR (follower_id = :other AND followee_id = :me)
      `).run({ me, other: target.id });

      // Непрочитанные события чистятся в обе стороны. Свои — потому что
      // получать от заблокированного больше нечего; его — потому что события
      // о вашем посте вели бы на пост, который для него теперь не существует
      // (GET /api/posts/:id отвечает 404 заблокированной паре).
      db.prepare(`
        DELETE FROM notifications
        WHERE read_at IS NULL
          AND ((user_id = :me AND actor_id = :other) OR (user_id = :other AND actor_id = :me))
      `).run({ me, other: target.id });

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.json({ blockedByMe: true });
  } catch (err) {
    next(err);
  }
});

// Разблокировка ничего не восстанавливает: снятые подписки и погашенные
// события назад не возвращаются — вернуть их означало бы хранить «теневую»
// копию связи, которую человек считал разорванной. Контент виден снова сразу.
router.delete('/:username/block', requireAuth, (req, res, next) => {
  try {
    const uname = String(req.params.username).toLowerCase();
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, target.id);

    res.json({ blockedByMe: false });
  } catch (err) {
    next(err);
  }
});

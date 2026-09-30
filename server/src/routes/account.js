import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { hashPassword, publicUser, requireAuth, SESSION_COOKIE, verifyPassword } from '../auth.js';
import { dropAttachment } from '../messageExtras.js';
import { deleteUpload } from '../media.js';
import { dropPrefs } from '../prefs.js';
import { dropDrafts } from '../drafts.js';
import { heirOf } from '../chatRoles.js';
import { exportFor } from '../exportData.js';
import { HOLD_DAYS, changeUsername, holdUsername, usernameTaken } from '../usernames.js';
import { unpin } from '../pins.js';
import { LAST_SEEN_OPTIONS } from '../presence.js';
import { checkCode, hasPassword, normalizePhone, sendCode } from '../phone.js';
import { PHONE_PRIVACY_OPTIONS } from '../phoneBook.js';
import * as v from '../validate.js';

/**
 * Настройки аккаунта: почта и номер, кому видно время визита, пароль, сеансы
 * и удаление. Всё — только о себе, поэтому чужого id в путях нет вовсе.
 *
 * Два вида аккаунтов (см. users.password_login): старые входят по логину и
 * паролю и могут привязать номер; созданные по номеру входят только по нему, а
 * пароль у них — необязательная двухэтапная проверка.
 */
export const router = Router();
router.use(requireAuth);

const WRONG_PASSWORD = 'Пароль не подходит';

const me = (req) => db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

router.get('/', (req, res) => {
  const row = me(req);
  res.json({
    email: row.email ?? null,
    phone: row.phone ?? null,
    hasPassword: hasPassword(row),
    passwordLogin: Boolean(row.password_login),
    lastSeen: row.last_seen_privacy,
    phoneFind: row.phone_find,
    phoneShow: row.phone_show,
    createdAt: row.created_at,
  });
});

/* ─ Номер телефона ─────────────────────────────────────────────────────
 * Привязать или сменить: код приходит на новый номер — так подтверждается,
 * что он ваш. Номер, уже привязанный к другому аккаунту, не отдаётся.
 */

router.post('/phone/start', async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const owner = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    if (owner?.id === req.user.id) return res.status(400).json({ error: 'Это уже ваш номер' });
    if (owner) return res.status(409).json({ error: 'Этот номер привязан к другому аккаунту' });
    res.json({ ok: true, phone, ...(await sendCode({ phone, purpose: 'link', userId: req.user.id })) });
  } catch (err) {
    next(err);
  }
});

router.put('/phone', (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    checkCode({ phone, purpose: 'link', code: req.body?.code, userId: req.user.id });
    // Пока шёл код, номер мог уйти другому.
    if (db.prepare('SELECT 1 FROM users WHERE phone = ? AND id <> ?').get(phone, req.user.id)) {
      return res.status(409).json({ error: 'Этот номер привязан к другому аккаунту' });
    }
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.id);
    res.json({ phone });
  } catch (err) {
    next(err);
  }
});

/** Отвязать номер может только старый аккаунт: у созданного по номеру это единственный вход. */
router.delete('/phone', (req, res) => {
  const row = me(req);
  if (!row.password_login) {
    return res.status(400).json({ error: 'Номер — ваш способ входа: его можно сменить, но не убрать' });
  }
  db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(req.user.id);
  res.json({ phone: null });
});

/**
 * Приватность: время захода и номер. Любое подмножество полей — меняется
 * только присланное; неизвестное значение отклоняет запрос целиком.
 */
const PRIVACY_FIELDS = [
  { key: 'lastSeen', column: 'last_seen_privacy', options: LAST_SEEN_OPTIONS, label: 'Кто видит время захода' },
  { key: 'phoneFind', column: 'phone_find', options: PHONE_PRIVACY_OPTIONS, label: 'Кто найдёт по номеру' },
  { key: 'phoneShow', column: 'phone_show', options: PHONE_PRIVACY_OPTIONS, label: 'Кто видит номер' },
];

/**
 * Сменить логин. Старый ещё HOLD_DAYS дней закреплён за вами (usernames.js):
 * по нему никто не зарегистрируется, а вы можете к нему вернуться.
 */
router.put('/username', (req, res, next) => {
  try {
    const row = me(req);
    const username = v.username(req.body?.username);
    if (username === row.username) return res.status(400).json({ error: 'Это и так ваш логин' });
    if (usernameTaken(username, row.id)) return res.status(409).json({ error: 'Это имя пользователя уже занято' });
    const heldUntil = changeUsername(row.id, row.username, username);
    res.json({ user: publicUser(me(req)), previous: row.username, heldUntil, holdDays: HOLD_DAYS });
  } catch (err) {
    next(err);
  }
});

router.put('/privacy', (req, res) => {
  const given = PRIVACY_FIELDS.filter((f) => req.body?.[f.key] !== undefined);
  if (given.length === 0) return res.status(400).json({ error: 'Нечего менять' });
  for (const f of given) {
    if (!f.options.includes(req.body[f.key])) {
      return res.status(400).json({ error: `«${f.label}» — ${f.options.join(', ')}` });
    }
  }
  for (const f of given) {
    db.prepare(`UPDATE users SET ${f.column} = ? WHERE id = ?`).run(req.body[f.key], req.user.id);
  }
  const row = me(req);
  res.json({ lastSeen: row.last_seen_privacy, phoneFind: row.phone_find, phoneShow: row.phone_show });
});

/** Пароль — по текущему, а не по «забыли»: сеанс мог остаться открытым на чужом компьютере. */
async function passwordMatches(userId, candidate) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  return typeof candidate === 'string' && candidate.length > 0 && verifyPassword(candidate, row.password_hash);
}

const hasOwnPassword = (userId) => hasPassword(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId));

const otherSessions = (userId, token) =>
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, token).changes;

/**
 * Задать или сменить пароль. Сменить — по текущему; задать впервые (аккаунт
 * по номеру, двухэтапная проверка ещё не включена) — без него: текущего нет.
 */
router.put('/password', async (req, res, next) => {
  try {
    const fresh = v.password(req.body?.newPassword);
    if (hasOwnPassword(req.user.id) && !(await passwordMatches(req.user.id, req.body?.currentPassword))) {
      return res.status(403).json({ error: WRONG_PASSWORD });
    }
    if (fresh === req.body.currentPassword) {
      return res.status(400).json({ error: 'Новый пароль совпадает с текущим' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(fresh), req.user.id);
    // Пароль меняют, когда боятся, что его знает кто-то ещё: остальные сеансы
    // и неиспользованные ссылки «забыли пароль» больше не должны работать.
    const ended = otherSessions(req.user.id, req.sessionToken);
    db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(req.user.id);
    res.json({ ok: true, ended });
  } catch (err) {
    next(err);
  }
});

/**
 * Выключить двухэтапную проверку — только у аккаунта по номеру: у старого
 * пароль — это и есть вход по логину, без него аккаунт осиротел бы.
 */
router.delete('/password', async (req, res, next) => {
  try {
    const row = me(req);
    if (row.password_login) return res.status(400).json({ error: 'Пароль нужен для входа по логину — убрать его нельзя' });
    if (!hasPassword(row)) return res.status(400).json({ error: 'Пароля и так нет' });
    if (!(await passwordMatches(req.user.id, req.body?.currentPassword))) {
      return res.status(403).json({ error: WRONG_PASSWORD });
    }
    db.prepare("UPDATE users SET password_hash = '' WHERE id = ?").run(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ─ Сеансы ────────────────────────────────────────────────────────────────
 * Токен сеанса — это и есть вход в аккаунт, наружу он не отдаётся даже
 * владельцу: у сеанса в ответе только rowid.
 */

/** Выгрузка своих данных одним JSON-файлом (см. exportData.js). */
router.get('/export', (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Disposition': `attachment; filename="hronika-${req.user.username}-${date}.json"`,
    'Cache-Control': 'no-store',
  });
  res.json(exportFor(req.user.id));
});

router.get('/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT rowid AS id, token, created_at, user_agent FROM sessions
    WHERE user_id = ? AND expires_at > ?
    ORDER BY created_at DESC
  `).all(req.user.id, nowIso());
  const sessions = rows
    .map((r) => ({ id: r.id, current: r.token === req.sessionToken, createdAt: r.created_at, userAgent: r.user_agent ?? null }))
    .sort((a, b) => Number(b.current) - Number(a.current));
  res.json({ sessions });
});

/** «Завершить все другие сеансы» — текущий остаётся. */
router.delete('/sessions', (req, res) => {
  res.json({ ok: true, ended: otherSessions(req.user.id, req.sessionToken) });
});

router.delete('/sessions/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const row = Number.isSafeInteger(id)
    ? db.prepare('SELECT rowid AS id, token FROM sessions WHERE rowid = ? AND user_id = ?').get(id, req.user.id)
    : null;
  if (!row) return res.status(404).json({ error: 'Сеанс не найден' });
  if (row.token === req.sessionToken) {
    return res.status(400).json({ error: 'Это текущий сеанс — чтобы его закончить, нажмите «Выйти»' });
  }
  db.prepare('DELETE FROM sessions WHERE rowid = ?').run(row.id);
  res.json({ ok: true });
});

/* ─ Удаление аккаунта ─────────────────────────────────────────────────── */

const paths = (sql, ...params) => db.prepare(sql).all(...params).map((r) => r.p).filter(Boolean);

/**
 * Удаление — навсегда и целиком: записи, комментарии, сообщения (и в личных,
 * и в группах), каналы, подписки, файлы. Почти всё уносит каскад по внешним
 * ключам от users; руками — то, у чего ключа нет или где каскад неверен:
 *
 * - группа, где остались другие, не удаляется, а переходит старейшему
 *   участнику — как при выходе владельца; группа, где человек был один,
 *   удаляется;
 * - настройки, папки и закрепления других людей, указывающие на ушедшего,
 *   его каналы и удалённые группы (у них нет внешнего ключа);
 * - файлы на диске — после COMMIT, когда строк уже точно нет.
 */
function deleteAccount(me) {
  const files = {
    avatar: paths('SELECT avatar_path AS p FROM users WHERE id = ?', me),
    media: paths('SELECT media_path AS p FROM posts WHERE author_id = ?', me),
    attachment: [
      ...paths('SELECT attach_path AS p FROM messages WHERE from_id = ? OR to_id = ?', me, me),
      ...paths('SELECT attach_path AS p FROM chat_messages WHERE author_id = ?', me),
      ...paths(`
        SELECT p.attach_path AS p FROM channel_posts p JOIN channels c ON c.id = p.channel_id
        WHERE c.owner_id = ?
      `, me),
    ],
  };

  db.exec('BEGIN');
  try {
    const chats = db.prepare(`
      SELECT c.id, c.owner_id FROM chats c JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
    `).all(me);
    for (const chat of chats) {
      const heir = heirOf(chat.id, me);
      if (heir != null) {
        if (chat.owner_id === me) {
          db.prepare('UPDATE chats SET owner_id = ? WHERE id = ?').run(heir, chat.id);
          db.prepare("UPDATE chat_members SET role = 'member' WHERE chat_id = ? AND user_id = ?").run(chat.id, heir);
        }
        continue;
      }
      files.attachment.push(...paths('SELECT attach_path AS p FROM chat_messages WHERE chat_id = ?', chat.id));
      db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
      unpin('chat', chat.id);
      dropPrefs({ kind: 'chat', targetId: chat.id });
      dropDrafts('chat', chat.id);
    }

    for (const { id } of db.prepare('SELECT id FROM channels WHERE owner_id = ?').all(me)) {
      unpin('channel', id);
      dropPrefs({ kind: 'channel', targetId: id });
      dropDrafts('channel', id);
    }

    // Закреплённые его реплики в группах, которые остаются: сами реплики уйдут каскадом.
    db.prepare(`
      DELETE FROM pinned_messages
      WHERE kind = 'chat' AND message_id IN (SELECT id FROM chat_messages WHERE author_id = ?)
    `).run(me);
    // Пары ЛС с ним: ключ «меньший-больший».
    db.prepare(`DELETE FROM pinned_messages WHERE kind = 'dm' AND (scope_id LIKE ? OR scope_id LIKE ?)`)
      .run(`${me}-%`, `%-${me}`);
    dropPrefs({ kind: 'dm', targetId: me });
    // Чужие черновики ему; свои уйдут каскадом вместе со строкой users.
    dropDrafts('dm', me);
    // Логин удалённого тоже не достаётся другому сразу — см. usernames.js.
    holdUsername(db.prepare('SELECT username FROM users WHERE id = ?').get(me).username, me);

    db.prepare('DELETE FROM users WHERE id = ?').run(me);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  files.avatar.forEach((p) => deleteUpload('avatar', p));
  files.media.forEach((p) => deleteUpload('media', p));
  files.attachment.forEach(dropAttachment);
}

/** Удаление без пароля подтверждается кодом из SMS на свой номер. */
router.post('/delete-code', async (req, res, next) => {
  try {
    const row = me(req);
    if (hasPassword(row)) return res.status(400).json({ error: 'Удаление подтверждается паролем' });
    if (!row.phone) return res.status(400).json({ error: 'Нет ни пароля, ни номера — удаление подтвердить нечем' });
    res.json({ ok: true, ...(await sendCode({ phone: row.phone, purpose: 'delete', userId: row.id })) });
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const row = me(req);
    if (hasPassword(row)) {
      if (!(await passwordMatches(req.user.id, req.body?.password))) {
        return res.status(403).json({ error: WRONG_PASSWORD });
      }
    } else {
      if (!row.phone) return res.status(400).json({ error: 'Нет ни пароля, ни номера — удаление подтвердить нечем' });
      checkCode({ phone: row.phone, purpose: 'delete', code: req.body?.code, userId: row.id });
    }
    deleteAccount(req.user.id);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

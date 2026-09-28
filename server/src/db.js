import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { dataDir } from './dataDir.js';

// DB_PATH lets the smoke test run against a throwaway file instead of real data.
const dbFile = process.env.DB_PATH ?? join(dataDir, 'app.db');

export const db = new DatabaseSync(dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    bio           TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    -- Суррогатный id здесь не для красоты: список закладок листается keyset-ом
    -- по времени сохранения, а не по id записи. Сохранили старую запись — она
    -- обязана оказаться сверху, иначе человек её больше не найдёт.
    -- UNIQUE делает «сохранить» идемпотентным на уровне схемы, как и в reports.
    UNIQUE (user_id, post_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    -- Повторная жалоба того же человека на тот же объект — это не второй
    -- сигнал, а второй клик: уникальность делает жалобу идемпотентной
    -- на уровне схемы, а не на уровне доброй воли роутера.
    UNIQUE (reporter_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at    TEXT NOT NULL,
    -- Ватерлиния вместо read_at на каждое сообщение: в групповом чате
    -- получателей N, и честная отметка прочтения стоила бы таблицы N × M.
    -- Непрочитанные = COUNT(*) WHERE chat_id = ? AND id > last_read_id.
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Объявлена после chats: внешний ключ на неё разрешается при вставке,
  -- но держать таблицу ниже той, на которую она ссылается, — единственный
  -- порядок, который читается сверху вниз без обратных ссылок.
  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    post_id    INTEGER REFERENCES posts(id)    ON DELETE CASCADE,
    comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    chat_id    INTEGER REFERENCES chats(id)    ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    read_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_author     ON posts(author_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_likes_post       ON likes(post_id);
  CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments(post_id, id);
  CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
  CREATE INDEX IF NOT EXISTS idx_messages_out     ON messages(from_id, to_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_in      ON messages(to_id, from_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_unread  ON messages(to_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_resets_user       ON password_resets(user_id);
  CREATE INDEX IF NOT EXISTS idx_notif_user        ON notifications(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_notif_unread      ON notifications(user_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_blocks_blocked    ON blocks(blocked_id);
  CREATE INDEX IF NOT EXISTS idx_reports_target    ON reports(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_chat_msgs         ON chat_messages(chat_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_members_u    ON chat_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user     ON bookmarks(user_id, id DESC);
`);

/**
 * Adds a column if an earlier version of the schema doesn't have it yet.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and CREATE TABLE IF NOT EXISTS
 * above only helps a brand-new database — a database from before this code
 * shipped needs its existing tables patched in place, without losing rows.
 */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('users', 'avatar_path', 'TEXT');
ensureColumn('users', 'email', 'TEXT');
// SQLite не считает несколько NULL равными друг другу, поэтому этот индекс
// не мешает старым аккаунтам без почты (их могло быть сколько угодно до
// миграции) — уникальность требуется только когда email реально задан.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
// Когда человек последний раз что-то запрашивал у сервера — отсюда «в сети» и
// «был(а) 5 минут назад» в переписке. Пишется в loadUser не чаще раза в минуту.
ensureColumn('users', 'last_seen_at', 'TEXT');
/* ─ Каналы ──────────────────────────────────────────────────────────────
 * Авторская лента с подписчиками, как канал в Телеграме: публикует владелец,
 * остальные читают, реагируют и комментируют. Отдельные таблицы, а не записи
 * ленты с пометкой: у публикации канала свои просмотры, свои комментарии и
 * своё «непрочитанное», и ни одному запросу ленты не нужно помнить о каналах.
 * Канал открыт всем, кто вошёл, — закрытых каналов нет.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    handle      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL
  );

  -- Ватерлиния непрочитанного — как у групповых чатов.
  CREATE TABLE IF NOT EXISTS channel_subscribers (
    channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at    TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_posts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    edited_at       TEXT,
    attach_path     TEXT,
    attach_kind     TEXT,
    attach_mime     TEXT,
    attach_name     TEXT,
    attach_size     INTEGER,
    attach_duration INTEGER,
    attach_wave     TEXT
  );

  -- Просмотр — один на человека: счётчик считает людей, а не обновления страницы.
  CREATE TABLE IF NOT EXISTS channel_post_views (
    post_id INTEGER NOT NULL REFERENCES channel_posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
  );

  -- Колонка message_id, а не post_id: реакции считает тот же код, что у ЛС и групп.
  CREATE TABLE IF NOT EXISTS channel_post_reactions (
    message_id INTEGER NOT NULL REFERENCES channel_posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES channel_posts(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_channel_posts    ON channel_posts(channel_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_channel_subs_u   ON channel_subscribers(user_id);
  CREATE INDEX IF NOT EXISTS idx_channel_comments ON channel_comments(post_id, id);
`);

/* ─ Настройки чатов в списке ────────────────────────────────────────────
 * Закреплён ли чат наверху списка и выключены ли у него уведомления — у
 * каждого человека свои. Одна таблица на все три вида переписки: kind —
 * dm | chat | channel, target_id — собеседник, чат или канал. Внешнего ключа
 * на target_id нет (он указывает в три разные таблицы), поэтому строки
 * убираются руками там, где человек теряет доступ: выход из чата, отписка,
 * удаление чата или канала (см. prefs.js).
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_prefs (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    pinned_at TEXT,
    muted     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind, target_id)
  );
`);

/* ─ Закреплённое сообщение ──────────────────────────────────────────────
 * Одно на переписку, общее для всех её участников: полоса под шапкой, по
 * нажатию — переход к сообщению. scope_id — пара в ЛС («3-7»), номер чата или
 * канала. Внешнего ключа на message_id нет (три разные таблицы): удалили
 * сообщение — закрепление снимается в том же обработчике (см. pins.js).
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS pinned_messages (
    kind       TEXT NOT NULL,
    scope_id   TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    pinned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    pinned_at  TEXT NOT NULL,
    PRIMARY KEY (kind, scope_id)
  );
`);

// Действия с сообщениями — одинаково для ЛС и групп (см. messageExtras.js).
// reply_to_id без внешнего ключа намеренно: ответ переживает удаление того, на
// что отвечал, и показывает «сообщение удалено», а не исчезает вместе с ним.
// fwd_user_id — автор оригинала пересланного; ушёл из сети — подпись пропадает.
for (const table of ['messages', 'chat_messages']) {
  ensureColumn(table, 'reply_to_id', 'INTEGER');
  ensureColumn(table, 'edited_at', 'TEXT');
  ensureColumn(table, 'fwd_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // Переслано из канала: подпись ведёт на канал, а не на человека.
  ensureColumn(table, 'fwd_channel_id', 'INTEGER REFERENCES channels(id) ON DELETE SET NULL');
  // Вложение — одно на сообщение, как и у записи. attach_kind: image | video |
  // audio | voice | file; длительность и «волна» — только у голосовых.
  ensureColumn(table, 'attach_path', 'TEXT');
  ensureColumn(table, 'attach_kind', 'TEXT');
  ensureColumn(table, 'attach_mime', 'TEXT');
  ensureColumn(table, 'attach_name', 'TEXT');
  ensureColumn(table, 'attach_size', 'INTEGER');
  ensureColumn(table, 'attach_duration', 'INTEGER');
  ensureColumn(table, 'attach_wave', 'TEXT');
}

// Реакция — одна на человека на сообщение, как у Телеграма без подписки:
// новая заменяет старую. Первичный ключ держит это правило схемой.
db.exec(`
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS chat_message_reactions (
    message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
`);

ensureColumn('posts', 'media_path', 'TEXT');
ensureColumn('posts', 'media_type', 'TEXT');
ensureColumn('posts', 'media_mime', 'TEXT');
ensureColumn('posts', 'media_name', 'TEXT');

/* ─ Полнотекстовый индекс записей ──────────────────────────────────────────
 *
 * Поиск людей в этом проекте пришлось писать на JS, потому что SQLite `LIKE`
 * регистронезависим только для ASCII. С записями так не выйдет: их много и они
 * длинные. FTS5 встроен в SQLite (никакой новой зависимости), а его токенизатор
 * `unicode61` сворачивает регистр по юникоду — «БОРИС» находится по «борис».
 *
 * Но `ё` он не считает вариантом `е` ни при каком `remove_diacritics` (проверено
 * на живом node:sqlite). Человек, набравший «пленка», не должен промахиваться
 * мимо «плёнки», поэтому в индекс кладётся нормализованная копия текста: замена
 * делается прямо в триггере, чтобы не существовало пути, которым сырой текст
 * попал бы в индекс в обход JS. Тот же replace применяется к запросу в
 * search.js — обе стороны сравнения нормализуются одинаково.
 *
 * Замена посимвольная 1:1, длина строки не меняется — смещения в индексе не
 * съезжают. Расплата за нормализованную копию: сниппет сервером не отдаётся,
 * иначе он показывал бы «пленка» там, где записано «плёнка».
 */
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    body,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS posts_fts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, body)
    VALUES (new.id, replace(replace(new.body, 'ё', 'е'), 'Ё', 'Е'));
  END;

  CREATE TRIGGER IF NOT EXISTS posts_fts_ad AFTER DELETE ON posts BEGIN
    DELETE FROM posts_fts WHERE rowid = old.id;
  END;

  CREATE TRIGGER IF NOT EXISTS posts_fts_au AFTER UPDATE OF body ON posts BEGIN
    UPDATE posts_fts SET body = replace(replace(new.body, 'ё', 'е'), 'Ё', 'Е')
    WHERE rowid = new.id;
  END;
`);

// Бэкофилл: на базе, которая жила до появления индекса, триггеры не сработают
// задним числом, и поиск нашёл бы ровно ноль записей. Условие NOT EXISTS делает
// вставку идемпотентной — повторный запуск сервера индекс не удваивает, а стоит
// он одного скана по таблице записей.
db.exec(`
  INSERT INTO posts_fts(rowid, body)
  SELECT p.id, replace(replace(p.body, 'ё', 'е'), 'Ё', 'Е') FROM posts p
  WHERE NOT EXISTS (SELECT 1 FROM posts_fts f WHERE f.rowid = p.id)
`);

export const nowIso = () => new Date().toISOString();

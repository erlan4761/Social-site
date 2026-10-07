import { DatabaseSync } from 'node:sqlite';
import { tagsIn } from './hashtags.js';
import { join } from 'node:path';
import { dataDir } from './dataDir.js';

// DB_PATH lets the smoke test run against a throwaway file instead of real data.
const dbFile = process.env.DB_PATH ?? join(dataDir, 'app.db');

export const db = new DatabaseSync(dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// Базу пишет и кто-то ещё (резервная копия, sqlite3 в консоли, смоук-тест) —
// запись ждёт чужую блокировку до пяти секунд, а не падает сразу с «database is locked».
db.exec('PRAGMA busy_timeout = 5000');

/*
 * Кэш подготовленных запросов. Код пишет `db.prepare(sql).get(...)` прямо в
 * обработчиках — так его легко читать, но SQLite каждый раз заново разбирал и
 * планировал бы один и тот же текст. Замер списка групп (scripts/bench-lists.mjs)
 * показал: разбор стоил дороже самих запросов. Теперь один текст — один
 * подготовленный запрос на всё время работы процесса. Это безопасно: запросы
 * выполняются синхронно и до конца (iterate() в проекте не используется), а
 * после ALTER TABLE SQLite перепланирует их сам. Потолок — на случай запросов
 * с переменным текстом (IN (?, ?, …)): старейшие вытесняются.
 */
const STATEMENT_CACHE_MAX = 1000;
const statements = new Map();
const prepareUncached = db.prepare.bind(db);
db.prepare = (sql) => {
  let statement = statements.get(sql);
  if (!statement) {
    statement = prepareUncached(sql);
    if (statements.size >= STATEMENT_CACHE_MAX) statements.delete(statements.keys().next().value);
    statements.set(sql, statement);
  }
  return statement;
};

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
// Кому видно это время: all — всем, follows — тем, на кого человек подписан,
// nobody — никому. Правило взаимное, как в Телеграме (см. presence.js).
ensureColumn('users', 'last_seen_privacy', "TEXT NOT NULL DEFAULT 'all'");
// С какого устройства открыт сеанс — чтобы в настройках было видно, какой из
// них чужой. Сырой User-Agent, название из него собирает клиент.
ensureColumn('sessions', 'user_agent', 'TEXT');
// Сеанс живёт от последнего использования, а не от входа (auth.js):
// last_used_at — когда им пользовались, срок — у владельца в users.session_ttl_days.
ensureColumn('sessions', 'last_used_at', 'TEXT');
ensureColumn('users', 'session_ttl_days', 'INTEGER');
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

/* ─ Папки чатов ─────────────────────────────────────────────────────────
 * Вкладки над списком чатов, как в Телеграме: у каждого свои. Папка — это
 * правило, а не копия списка: виды чатов (types — «dm,chat,channel»), чаты,
 * добавленные вручную, и исключённые (chat_folder_items), плюс «без
 * приглушённых» и «только непрочитанные». Какие чаты подходят, считает
 * клиент — список чатов у него и так загружен целиком.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_folders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    position      INTEGER NOT NULL,
    types         TEXT NOT NULL DEFAULT '',
    exclude_muted INTEGER NOT NULL DEFAULT 0,
    exclude_read  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_folder_items (
    folder_id INTEGER NOT NULL REFERENCES chat_folders(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    mode      TEXT NOT NULL,
    PRIMARY KEY (folder_id, kind, target_id)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_folders_user ON chat_folders(user_id, position);
`);

/* ─ Закреплённые сообщения ──────────────────────────────────────────────
 * Несколько на переписку (до двадцати), общие для всех её участников: полоса
 * под шапкой, по нажатию — переход к сообщению. scope_id — пара в ЛС («3-7»),
 * номер чата или канала. Внешнего ключа на message_id нет (три разные
 * таблицы): удалили сообщение — закрепление снимается в том же обработчике
 * (см. pins.js).
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS pinned_messages (
    kind       TEXT NOT NULL,
    scope_id   TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    pinned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    pinned_at  TEXT NOT NULL,
    PRIMARY KEY (kind, scope_id, message_id)
  );
`);
// Раньше закреплённое было одно — ключ (kind, scope_id). Первичный ключ в
// SQLite не меняется на месте: таблица пересобирается с тем же содержимым.
if (!db.prepare('PRAGMA table_info(pinned_messages)').all().some((c) => c.name === 'message_id' && c.pk > 0)) {
  db.exec(`
    BEGIN;
    CREATE TABLE pinned_messages_many (
      kind       TEXT NOT NULL,
      scope_id   TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      pinned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      pinned_at  TEXT NOT NULL,
      PRIMARY KEY (kind, scope_id, message_id)
    );
    INSERT INTO pinned_messages_many SELECT kind, scope_id, message_id, pinned_by, pinned_at FROM pinned_messages;
    DROP TABLE pinned_messages;
    ALTER TABLE pinned_messages_many RENAME TO pinned_messages;
    COMMIT;
  `);
}

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
  // Стикер — id из встроенного набора («plenka/hi»): картинку рисует клиент,
  // в базе только имя. Сообщение со стикером — без текста и вложения.
  ensureColumn(table, 'sticker', 'TEXT');
}

// Упоминания в группах (см. mentions.js): кого назвали через @ в сообщении.
// Событию об упоминании нужно само сообщение — чтобы процитировать его и
// погаснуть вместе с ним, если его удалят.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_mentions (
    message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_mentions_user ON chat_mentions(user_id, message_id);
`);
// Опросы (см. polls.js): приложение к сообщению группы или публикации канала.
// Два внешних ключа с каскадом, из них заполнен ровно один: опрос уходит
// вместе со своим сообщением, чатом или каналом, и голоса — вместе с ним.
db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_message_id INTEGER UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
    channel_post_id INTEGER UNIQUE REFERENCES channel_posts(id) ON DELETE CASCADE,
    multiple        INTEGER NOT NULL DEFAULT 0,
    anonymous       INTEGER NOT NULL DEFAULT 1,
    closed_at       TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text     TEXT NOT NULL
  );

  -- Голос — пара (вариант, человек): при «нескольких ответах» их у человека несколько.
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (option_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_poll_options ON poll_options(poll_id, position);
  CREATE INDEX IF NOT EXISTS idx_poll_votes   ON poll_votes(poll_id, user_id);
`);
// Правка записи в ленте: когда текст меняли в последний раз — для «изменено».
ensureColumn('posts', 'edited_at', 'TEXT');

// Оформление переписки (prefs.js): тема — фон и цвет своих пузырей, у каждого свои.
ensureColumn('chat_prefs', 'theme', 'TEXT');

// Ответ на комментарий в ленте: на какой комментарий того же поста. Удалили
// исходный — ответ остаётся, просто перестаёт им быть (SET NULL).
ensureColumn('comments', 'reply_to_id', 'INTEGER REFERENCES comments(id) ON DELETE SET NULL');

// Викторина (polls.js): опрос с одним правильным ответом и пояснением к нему.
ensureColumn('polls', 'quiz', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('polls', 'correct_option_id', 'INTEGER');
ensureColumn('polls', 'explanation', 'TEXT');

// Отложенные сообщения (см. scheduled.js): ждут своего времени и уходят обычным
// путём. target_id — собеседник, группа или канал по kind; без внешнего ключа,
// как у настроек чатов, — доступ проверяется в момент отправки.
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    target_id  INTEGER NOT NULL,
    body       TEXT NOT NULL,
    send_at    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_due  ON scheduled_messages(send_at);
  CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_messages(user_id, kind, target_id);
`);
// Пуш-подписки устройств (см. push.js). Подписка живёт, пока жив сеанс:
// вышли на телефоне — строка уходит каскадом, и пуши туда прекращаются.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
    endpoint      TEXT NOT NULL UNIQUE,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);
// Номер телефона — вход и регистрация «как в Телеграме» (см. phone.js).
// password_login: 1 — аккаунт входит и по логину с паролем (все, кто
// появился до входа по номеру), 0 — только по номеру; пароль у таких —
// необязательная двухэтапная проверка, а не самостоятельный вход.
ensureColumn('users', 'phone', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
ensureColumn('users', 'password_login', 'INTEGER NOT NULL DEFAULT 1');
// Кто найдёт по номеру и кому номер виден (см. phoneBook.js). По умолчанию —
// никому: находиться по номеру человек соглашается сам.
ensureColumn('users', 'phone_find', "TEXT NOT NULL DEFAULT 'nobody'");
ensureColumn('users', 'phone_show', "TEXT NOT NULL DEFAULT 'nobody'");

// Ссылка-приглашение в группу: случайный код, по которому любой вошедший
// может вступить. NULL — ссылки нет. Сменить код — старая ссылка перестаёт
// работать.
ensureColumn('chats', 'invite_token', 'TEXT');

// Роли и порядок в группе (см. chatRoles.js): администраторы, медленный режим
// в секундах (0 — выключен), «пишут только администраторы».
ensureColumn('chat_members', 'role', "TEXT NOT NULL DEFAULT 'member'");
ensureColumn('chats', 'slow_mode', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('chats', 'admins_only', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_invite ON chats(invite_token)');

// Предпросмотр ссылок (см. linkPreview.js): кэш по адресу. ok = 0 — страница
// не отдала превью; такую запись повторяют через час, удачную — через сутки.
db.exec(`
  CREATE TABLE IF NOT EXISTS link_previews (
    url         TEXT PRIMARY KEY,
    ok          INTEGER NOT NULL,
    title       TEXT,
    description TEXT,
    site_name   TEXT,
    image_url   TEXT,
    fetched_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_link_previews_image ON link_previews(image_url);
`);

// Альбом — несколько фото и видео подряд: отдельные сообщения с общим
// album_id, как media group в Телеграме (см. messageExtras.js).
ensureColumn('messages', 'album_id', 'TEXT');
ensureColumn('chat_messages', 'album_id', 'TEXT');
ensureColumn('channel_posts', 'album_id', 'TEXT');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_album ON messages(album_id) WHERE album_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_chat_messages_album ON chat_messages(album_id) WHERE album_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_channel_posts_album ON channel_posts(album_id) WHERE album_id IS NOT NULL;
`);

// Двухэтапная проверка (twoFactor.js): секрет приложения-аутентификатора,
// ещё не подтверждённый секрет, когда включена, шаг последнего принятого кода.
ensureColumn('users', 'totp_secret', 'TEXT');
ensureColumn('users', 'totp_pending', 'TEXT');
ensureColumn('users', 'totp_enabled_at', 'TEXT');
ensureColumn('users', 'totp_last_step', 'INTEGER');
db.exec(`
  CREATE TABLE IF NOT EXISTS totp_backup_codes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_codes(user_id);
  CREATE TABLE IF NOT EXISTS totp_tickets (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
  );
`);

// Бронь старого логина после смены (см. usernames.js). Строка без внешнего
// ключа на users намеренно не удаляется вместе с аккаунтом: логин удалённого
// тоже не должен сразу достаться другому.
db.exec(`
  CREATE TABLE IF NOT EXISTS username_holds (
    username TEXT PRIMARY KEY,
    user_id  INTEGER NOT NULL,
    until    TEXT NOT NULL
  );
`);

// Модерация (см. routes/moderation.js): кто модератор, кого модератор
// заблокировал, чем кончилась жалоба.
ensureColumn('users', 'moderator', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'banned_at', 'TEXT');
ensureColumn('users', 'ban_reason', 'TEXT');
ensureColumn('reports', 'resolved_at', 'TEXT');
ensureColumn('reports', 'resolution', 'TEXT');
ensureColumn('reports', 'resolved_by', 'INTEGER');

// Запись о звонке в личной переписке (см. calls.js): JSON {video, outcome,
// duration}. У обычного сообщения — NULL.
ensureColumn('messages', 'call', 'TEXT');

// Архив чатов (см. prefs.js): когда чат убрали в архив; NULL — не в архиве.
ensureColumn('chat_prefs', 'archived_at', 'TEXT');

// Автоудаление (см. autoDelete.js): таймер в секундах у переписки, группы и
// канала и срок у каждого сообщения, отправленного при включённом таймере.
db.exec(`
  CREATE TABLE IF NOT EXISTS dm_settings (
    low_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    high_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auto_delete INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (low_id, high_id)
  );
`);
ensureColumn('chats', 'auto_delete', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('channels', 'auto_delete', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'expires_at', 'TEXT');
ensureColumn('chat_messages', 'expires_at', 'TEXT');
ensureColumn('channel_posts', 'expires_at', 'TEXT');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_chat_messages_expires ON chat_messages(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_channel_posts_expires ON channel_posts(expires_at) WHERE expires_at IS NOT NULL;
`);

// Черновики (см. drafts.js): по одному на человека и чат.
db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('dm', 'chat', 'channel')),
    target_id  INTEGER NOT NULL,
    body       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, kind, target_id)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS phone_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    salt       TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_phone_codes ON phone_codes(phone, purpose, id DESC);

  CREATE TABLE IF NOT EXISTS phone_tickets (
    token      TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
  );
`);
// Подробности события, которым не хватает ссылок на запись или чат: у «входа
// с нового устройства» — само устройство ({"device": "Chrome, Windows"}).
ensureColumn('notifications', 'detail', 'TEXT');
ensureColumn('notifications', 'message_id', 'INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE');

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

// Снимки записи по порядку — до десяти (routes/posts.js). Колонки posts.media_*
// по-прежнему хранят первый: на них опираются модерация, выгрузка и старые
// клиенты. Записи, опубликованные до галерей, переносятся сюда один раз.
db.exec(`
  CREATE TABLE IF NOT EXISTS post_media (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id  INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    path     TEXT NOT NULL,
    type     TEXT NOT NULL,
    mime     TEXT,
    name     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_post_media ON post_media(post_id, position);
  INSERT INTO post_media (post_id, position, path, type, mime, name)
  SELECT p.id, 0, p.media_path, p.media_type, p.media_mime, p.media_name FROM posts p
  WHERE p.media_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.id);
`);

// Репосты и цитаты (routes/posts.js). Чистый репост — запись без текста со
// ссылкой repost_of_id: она уходит вместе с оригиналом по каскаду, а один
// человек делает репост одной записи один раз (частичный уникальный индекс).
// Цитата — запись со своим текстом и quote_of_id без внешнего ключа: удалили
// оригинал — цитата остаётся и показывает «Запись недоступна». id записей —
// AUTOINCREMENT и не переиспользуются, так что висячая ссылка не укажет на
// чужую запись.
ensureColumn('posts', 'repost_of_id', 'INTEGER REFERENCES posts(id) ON DELETE CASCADE');
ensureColumn('posts', 'quote_of_id', 'INTEGER');
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_repost ON posts(repost_of_id, author_id) WHERE repost_of_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_posts_quote ON posts(quote_of_id) WHERE quote_of_id IS NOT NULL;
`);

// Закреплённая запись профиля — одна, своя, не репост (routes/posts.js).
// Удалили запись — закрепление снимается само.
ensureColumn('users', 'pinned_post_id', 'INTEGER REFERENCES posts(id) ON DELETE SET NULL');

// Закрытый профиль (privacy.js): записи видят автор и одобренные подписчики,
// подписка становится заявкой — до ответа владельца она живёт здесь.
ensureColumn('users', 'private', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
  CREATE TABLE IF NOT EXISTS follow_requests (
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (requester_id, target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_follow_requests_target ON follow_requests(target_id, created_at);
`);

// Отложенные записи ленты (routes/scheduledPosts.js): только текст, ждут своего часа.
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    send_at    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts(send_at);
  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_author ON scheduled_posts(author_id, send_at);
`);

// Оформление профиля: обложка (файл в media) и до трёх ссылок (JSON-массив адресов).
ensureColumn('users', 'cover_path', 'TEXT');
ensureColumn('users', 'links', 'TEXT');

// Просмотры записей ленты — как channel_post_views: один на человека, счётчик
// считает людей, а не прокрутки. Свои просмотры автор не набирает.
db.exec(`
  CREATE TABLE IF NOT EXISTS post_views (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
  );
`);

// Черновик записи ленты — один на человека (drafts.js). Отдельной таблицей, а не
// видом в drafts: там CHECK на виды чатов, а у записи нет цели — она «в ленту».
db.exec(`
  CREATE TABLE IF NOT EXISTS post_drafts (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Хэштеги записей (hashtags.js): ключ — для поиска, подпись — как написал автор.
// Записи, опубликованные до хэштегов, размечаются при запуске; запись с «#» без
// настоящего тега просто перечитывается — это дешевле отдельной отметки.
db.exec(`
  CREATE TABLE IF NOT EXISTS post_tags (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    label   TEXT NOT NULL,
    PRIMARY KEY (tag, post_id)
  );
  CREATE INDEX IF NOT EXISTS idx_post_tags_post ON post_tags(post_id);
`);
{
  const insertTag = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag, label) VALUES (?, ?, ?)');
  const untagged = db.prepare(`
    SELECT p.id, p.body FROM posts p
    WHERE p.body LIKE '%#%' AND NOT EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id)
  `).all();
  for (const post of untagged) {
    for (const { tag, label } of tagsIn(post.body)) insertTag.run(post.id, tag, label);
  }
}


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

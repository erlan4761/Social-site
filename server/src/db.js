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
ensureColumn('posts', 'media_path', 'TEXT');
ensureColumn('posts', 'media_type', 'TEXT');
ensureColumn('posts', 'media_mime', 'TEXT');
ensureColumn('posts', 'media_name', 'TEXT');

export const nowIso = () => new Date().toISOString();

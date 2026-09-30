// Замер списков мессенджера на «тяжёлом» аккаунте: 40 личных переписок,
// 40 групп по 10 участников, 20 каналов. Сервер — тот же, что для смоук-теста
// (API_URL, DB_PATH, RELAX_RATE_LIMITS=1); данные кладутся прямо в базу.
//
//   npm run bench:lists
//
// Печатает медиану и 95-й перцентиль ответа /messages, /chats и /channels.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';

const BASE = (process.env.API_URL ?? 'http://127.0.0.1:3001') + '/api';
const db = new DatabaseSync(process.env.DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

const salt = randomBytes(16);
const HASH = ['scrypt', salt.toString('hex'), scryptSync('parol12345', salt, 64).toString('hex')].join('$');
const tag = Date.now().toString(36).slice(-5);
const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

const addUser = db.prepare('INSERT INTO users (username, display_name, bio, email, password_hash, created_at) VALUES (?, ?, \'\', ?, ?, ?)');
const user = (name) => Number(addUser.run(name, name, `${name}@example.test`, HASH, at(10_000)).lastInsertRowid);

db.exec('BEGIN');
const me = user(`bench_${tag}`);
const people = Array.from({ length: 60 }, (_, i) => user(`bp${i}_${tag}`));

const dm = db.prepare('INSERT INTO messages (from_id, to_id, body, created_at, read_at) VALUES (?, ?, ?, ?, ?)');
for (let i = 0; i < 40; i++) {
  for (let k = 0; k < 20; k++) {
    const mine = k % 2 === 0;
    dm.run(mine ? me : people[i], mine ? people[i] : me, `Сообщение ${k}`, at(i * 60 + (20 - k)), k < 18 ? at(1) : null);
  }
}

const chat = db.prepare('INSERT INTO chats (title, owner_id, created_at) VALUES (?, ?, ?)');
const member = db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at, last_read_id) VALUES (?, ?, ?, ?)');
const chatMsg = db.prepare('INSERT INTO chat_messages (chat_id, author_id, body, created_at) VALUES (?, ?, ?, ?)');
for (let i = 0; i < 40; i++) {
  const id = Number(chat.run(`Группа ${i}`, me, at(5000)).lastInsertRowid);
  const members = [me, ...people.slice(i % 50, (i % 50) + 9)];
  for (const u of members) member.run(id, u, at(5000), 0);
  for (let k = 0; k < 30; k++) chatMsg.run(id, members[k % members.length], `Реплика ${k} @bp1_${tag}`, at(i * 30 + (30 - k)));
}

const channel = db.prepare('INSERT INTO channels (handle, title, description, owner_id, created_at) VALUES (?, ?, \'\', ?, ?)');
const sub = db.prepare('INSERT INTO channel_subscribers (channel_id, user_id, joined_at, last_read_id) VALUES (?, ?, ?, 0)');
const post = db.prepare('INSERT INTO channel_posts (channel_id, author_id, body, created_at) VALUES (?, ?, ?, ?)');
for (let i = 0; i < 20; i++) {
  const owner = people[i];
  const id = Number(channel.run(`bench${i}${tag}`, `Канал ${i}`, owner, at(8000)).lastInsertRowid);
  sub.run(id, owner, at(8000));
  sub.run(id, me, at(7000));
  for (let k = 0; k < 20; k++) post.run(id, owner, `Публикация ${k}`, at(i * 40 + (20 - k)));
}
db.exec('COMMIT');

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: `bench_${tag}`, password: 'parol12345' }),
});
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='));
if (!cookie) throw new Error(`Вход не удался: ${login.status}`);

// Замер — обычным http с keep-alive, а не fetch: на Windows fetch сам
// добавляет к каждому запросу ~10 мс, и разница между списками в этом шуме
// тонула (так выглядел первый замер: даже /auth/me «стоил» 12 мс).
const agent = new http.Agent({ keepAlive: true });
const get = (path) =>
  new Promise((resolve, reject) => {
    http.get(BASE + path, { agent, headers: { Cookie: cookie } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

async function measure(path, runs = 50) {
  const times = [];
  let size = 0;
  for (let i = 0; i < runs + 3; i++) {
    const t0 = performance.now();
    const res = await get(path);
    const body = res.body;
    const ms = performance.now() - t0;
    if (res.status !== 200) throw new Error(`${path}: ${res.status}`);
    if (i >= 3) times.push(ms); // первые три — прогрев
    size = body.length;
  }
  times.sort((a, b) => a - b);
  const pick = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
  console.log(`${path.padEnd(9)} медиана ${pick(0.5).padStart(6)} мс   p95 ${pick(0.95).padStart(6)} мс   ответ ${(size / 1024).toFixed(0)} КБ`);
}

// Опорная точка: самый лёгкий запрос — сколько стоят сеанс и Express.
await measure('/auth/me');
await measure('/messages');
await measure('/chats');
await measure('/channels');

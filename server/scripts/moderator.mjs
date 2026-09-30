// Назначить или снять модератора: npm run moderator -- <логин> [off]
// Работает с той же базой, что сервер (DB_PATH / DATA_DIR). Через интерфейс
// модератором не стать — это решение владельца сервера.
import { db } from '../src/db.js';

const [name, flag] = process.argv.slice(2);
if (!name) {
  console.error('Укажите логин: npm run moderator -- <логин> [off]');
  process.exit(1);
}
const on = flag !== 'off';
const info = db.prepare('UPDATE users SET moderator = ? WHERE username = ?').run(on ? 1 : 0, name.toLowerCase().replace(/^@/, ''));
if (info.changes === 0) {
  console.error(`Пользователя @${name} нет`);
  process.exit(1);
}
console.log(on ? `@${name} теперь модератор` : `@${name} больше не модератор`);

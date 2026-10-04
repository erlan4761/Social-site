// Прогоняет API целиком по живому серверу.
// Сервер нужно поднять с RELAX_RATE_LIMITS=1, иначе лимит регистраций
// (10 в час на IP) остановит прогон на середине.
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';

// Сам прогон лимиты не проверяет — с RELAX_RATE_LIMITS=1 их и нет. Если такую
// проверку когда-нибудь добавят, API_URL обязан быть http://127.0.0.1:<порт>,
// а не http://localhost: «localhost» резолвится и в ::1, и в 127.0.0.1,
// соединения открываются то по одному адресу, то по другому, а rateLimit.js
// считает окно по req.ip — счётчик делится на два ключа, и проверка лимита
// становится «зелёной» даже на сломанном лимитере. Поэтому и умолчание ниже —
// адрес, а не имя.
const BASE = (process.env.API_URL ?? 'http://127.0.0.1:3001') + '/api';

// Письмо со ссылкой на сброс пароля в тестовом режиме просто печатается в
// консоль сервера — без RESEND_API_KEY отправлять его некуда, и это
// правильный режим по умолчанию, а не заглушка. Токен из ответа API не
// вернуть: он же и был бы дырой, позволяющей узнать, есть ли такой email.
// Поэтому здесь читаем его напрямую из той же БД, что видит сервер, в обход
// HTTP — сервер и тест смотрят в один файл через DB_PATH.
function lastResetToken(email) {
  if (!process.env.DB_PATH) return null;
  const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT r.token FROM password_resets r
      JOIN users u ON u.id = r.user_id
      WHERE u.email = ?
      ORDER BY r.created_at DESC LIMIT 1
    `).get(email);
    return row?.token ?? null;
  } finally {
    db.close();
  }
}

/*
 * Старые аккаунты — как до входа по номеру: логин, почта, пароль. Через API
 * их больше не создать (регистрация — только по номеру телефона), поэтому
 * тест кладёт их прямо в базу — ровно такими, какими они остались у людей, —
 * а входит обычным /auth/login. Регистрацию по номеру проверяет отдельная
 * секция в конце, с поддельной службой SMS.
 */
const LEGACY_SALT = randomBytes(16);
// Тот же формат, что у hashPassword() сервера: scrypt$соль$ключ.
const LEGACY_HASH = ['scrypt', LEGACY_SALT.toString('hex'), scryptSync('parol12345', LEGACY_SALT, 64).toString('hex')].join('$');
let legacyDb = null;
/** Код приложения-аутентификатора (RFC 6238) — на `shift` шагов по 30 с вперёд. */
function totpCode(secret, shift = 0) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of secret) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + shift));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function legacySignUp(client, username, displayName) {
  if (!legacyDb) {
    legacyDb = new DatabaseSync(process.env.DB_PATH);
    legacyDb.exec('PRAGMA busy_timeout = 5000');
  }
  legacyDb.prepare(`
    INSERT INTO users (username, display_name, bio, email, password_hash, created_at) VALUES (?, ?, '', ?, ?, ?)
  `).run(username.toLowerCase(), displayName, `${username.toLowerCase()}@example.test`, LEGACY_HASH, new Date().toISOString());
  const res = await client('/auth/login', { method: 'POST', body: JSON.stringify({ username, password: 'parol12345' }) });
  // Аккаунт «уже бывал в сети»: его первый вход в тесте — подготовка, а не
  // новость. Событие «Вход в аккаунт» убираем, чтобы секции считали только
  // свои события; сами уведомления о входе проверяет отдельная секция.
  legacyDb.prepare(`
    DELETE FROM notifications WHERE kind = 'new_login' AND user_id = (SELECT id FROM users WHERE username = ?)
  `).run(username.toLowerCase());
  return res;
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

function makeClient() {
  let cookie = '';
  async function call(path, init = {}) {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        // FormData ставит свой Content-Type с boundary — перебивать нельзя.
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...init.headers,
      },
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.startsWith('sid=')) cookie = pair.endsWith('sid=') ? '' : pair;
    }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
  // Сырой GET с той же кукой — для файлов вложений: они отдаются не JSON'ом
  // и только тому, кто видит сообщение.
  call.raw = (path, headers = {}) =>
    fetch(BASE.replace(/\/api$/, '') + path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  return call;
}

const stamp = Date.now().toString(36).slice(-5);
const a = makeClient();
const b = makeClient();
const anon = makeClient();

const userA = `alice_${stamp}`;
const userB = `bob_${stamp}`;

console.log('\n— регистрация и сессия —');
let r = await legacySignUp(a, userA, 'Алиса Иванова');
check('старый аккаунт входит по логину и паролю', r.status === 200, JSON.stringify(r.body));
check('вернулся пользователь', r.body.user?.username === userA, JSON.stringify(r.body));
check('хэш пароля не утёк', !JSON.stringify(r.body).includes('scrypt'));

r = await a('/auth/me');
check('me видит сессию', r.body.user?.username === userA, JSON.stringify(r.body));

r = await anon('/auth/me');
check('me без куки = null', r.body.user === null, JSON.stringify(r.body));

console.log('\n— регистрация по логину закрыта —');
r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: `zed_${stamp}`, displayName: 'z', email: `zed_${stamp}@example.test`, password: 'parol12345' }) });
check('регистрация по логину и почте — 410, только по номеру', r.status === 410, `${r.status} ${JSON.stringify(r.body)}`);
r = await anon('/auth/login', { method: 'POST', body: JSON.stringify({ username: `zed_${stamp}`, password: 'parol12345' }) });
check('и аккаунт не появился', r.status === 401, `${r.status}`);

console.log('\n— вход —');
r = await legacySignUp(b, userB, 'Борис');
check('второй пользователь создан', r.status === 200, JSON.stringify(r.body));

r = await anon('/auth/login', { method: 'POST', body: JSON.stringify({ username: userA, password: 'nepravilny' }) });
check('неверный пароль = 401', r.status === 401);
const wrongPwdMsg = r.body.error;
r = await anon('/auth/login', { method: 'POST', body: JSON.stringify({ username: `net_takogo_${stamp}`, password: 'nepravilny' }) });
check('несуществующий логин = тот же ответ', r.status === 401 && r.body.error === wrongPwdMsg, `${r.status} ${r.body.error} vs ${wrongPwdMsg}`);

console.log('\n— посты —');
r = await anon('/posts', { method: 'POST', body: JSON.stringify({ body: 'аноним' }) });
check('аноним не может постить', r.status === 401, `${r.status}`);

r = await a('/posts', { method: 'POST', body: JSON.stringify({ body: 'Первая запись в хронике.\nСо второй строкой.' }) });
check('пост создан', r.status === 201, JSON.stringify(r.body));
check('автор проставлен', r.body.post?.author?.username === userA);
check('перевод строки сохранён', r.body.post?.body.includes('\n'));
const postA = r.body.post.id;

r = await a('/posts', { method: 'POST', body: JSON.stringify({ body: 'я'.repeat(501) }) });
check('пост >500 символов отклонён', r.status === 400, `${r.status}`);

r = await a('/posts', { method: 'POST', body: JSON.stringify({ body: '   ' }) });
check('пустой пост отклонён', r.status === 400, `${r.status}`);

r = await b('/posts', { method: 'POST', body: JSON.stringify({ body: 'Пост Бориса' }) });
const postB = r.body.post.id;
check('пост второго создан', r.status === 201);

console.log('\n— лента —');
r = await anon('/posts');
check('лента доступна', r.status === 200);
check('оба поста в ленте', r.body.posts.some(p => p.id === postA) && r.body.posts.some(p => p.id === postB));
check('порядок — новые сверху', r.body.posts[0].id > r.body.posts.at(-1).id || r.body.posts.length === 1);

r = await anon(`/posts?author=${userB}`);
check('фильтр по автору', r.body.posts.every(p => p.author.username === userB) && r.body.posts.length > 0);

console.log('\n— удаление —');
r = await b(`/posts/${postA}`, { method: 'DELETE' });
check('чужой пост удалить нельзя (403)', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);

r = await anon(`/posts/${postA}`, { method: 'DELETE' });
check('аноним удалить не может (401)', r.status === 401, `${r.status}`);

r = await a(`/posts/${postA}`, { method: 'DELETE' });
check('свой пост удалён', r.status === 200, `${r.status}`);

r = await a(`/posts/${postA}`, { method: 'DELETE' });
check('повторное удаление = 404', r.status === 404, `${r.status}`);

console.log('\n— профиль —');
r = await anon(`/users/${userA}`);
check('профиль читается', r.body.user?.username === userA, JSON.stringify(r.body));
check('есть счётчик постов', typeof r.body.user?.postCount === 'number');
check('хэш пароля не отдаётся', !JSON.stringify(r.body).includes('password'));

r = await anon(`/users/net_takogo_${stamp}`);
check('несуществующий профиль = 404', r.status === 404);

r = await a('/users/me', { method: 'PATCH', body: JSON.stringify({ displayName: 'Алиса И.', bio: 'Пишу о городе.' }) });
check('профиль обновлён', r.body.user?.displayName === 'Алиса И.' && r.body.user?.bio === 'Пишу о городе.', JSON.stringify(r.body));

r = await anon('/users/me', { method: 'PATCH', body: JSON.stringify({ displayName: 'взлом', bio: '' }) });
check('аноним не правит профиль', r.status === 401, `${r.status}`);

r = await a('/users/me', { method: 'PATCH', body: JSON.stringify({ displayName: 'Алиса И.', bio: 'я'.repeat(201) }) });
check('bio >200 символов отклонено', r.status === 400, `${r.status}`);

console.log('\n— пагинация —');
for (let i = 1; i <= 24; i++) {
  await b('/posts', { method: 'POST', body: JSON.stringify({ body: `Запись номер ${i}` }) });
}
r = await anon(`/posts?author=${userB}`);
check('первая страница = 20 постов', r.body.posts.length === 20, `${r.body.posts.length}`);
check('есть nextCursor', typeof r.body.nextCursor === 'number', `${r.body.nextCursor}`);
const firstIds = r.body.posts.map(p => p.id);

r = await anon(`/posts?author=${userB}&cursor=${r.body.nextCursor}`);
check('вторая страница = 5 постов', r.body.posts.length === 5, `${r.body.posts.length}`);
check('страницы не пересекаются', r.body.posts.every(p => !firstIds.includes(p.id)));
check('дальше страниц нет', r.body.nextCursor === null, `${r.body.nextCursor}`);

console.log('\n— лайки —');
r = await a('/posts', { method: 'POST', body: JSON.stringify({ body: 'Пост под лайки и комментарии' }) });
const hot = r.body.post.id;
check('новый пост без лайков', r.body.post.likeCount === 0 && r.body.post.likedByMe === false, JSON.stringify(r.body.post));
check('новый пост без комментариев', r.body.post.commentCount === 0, JSON.stringify(r.body.post));

r = await anon(`/posts/${hot}/like`, { method: 'PUT' });
check('аноним не может лайкать', r.status === 401, `${r.status}`);

r = await b(`/posts/${hot}/like`, { method: 'PUT' });
check('лайк поставлен', r.status === 200 && r.body.likeCount === 1 && r.body.likedByMe === true, JSON.stringify(r.body));

r = await b(`/posts/${hot}/like`, { method: 'PUT' });
check('повторный лайк не удваивает счёт', r.body.likeCount === 1, JSON.stringify(r.body));

r = await a(`/posts/${hot}/like`, { method: 'PUT' });
check('лайк второго пользователя считается', r.body.likeCount === 2, JSON.stringify(r.body));

r = await anon('/posts');
let seen = r.body.posts.find(p => p.id === hot);
check('лента отдаёт счётчик лайков', seen?.likeCount === 2, JSON.stringify(seen));
check('аноним не помечен как лайкнувший', seen?.likedByMe === false, JSON.stringify(seen));

r = await b('/posts');
seen = r.body.posts.find(p => p.id === hot);
check('свой лайк виден в ленте', seen?.likedByMe === true, JSON.stringify(seen));

r = await b(`/posts/${hot}/like`, { method: 'DELETE' });
check('лайк снят', r.body.likeCount === 1 && r.body.likedByMe === false, JSON.stringify(r.body));

r = await b(`/posts/${hot}/like`, { method: 'DELETE' });
check('повторное снятие не уводит в минус', r.body.likeCount === 1, JSON.stringify(r.body));

r = await b(`/posts/999999/like`, { method: 'PUT' });
check('лайк несуществующего поста = 404', r.status === 404, `${r.status}`);

console.log('\n— комментарии —');
r = await anon(`/posts/${hot}/comments`, { method: 'POST', body: JSON.stringify({ body: 'аноним' }) });
check('аноним не комментирует', r.status === 401, `${r.status}`);

r = await b(`/posts/${hot}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Первый коммент' }) });
check('комментарий создан', r.status === 201, JSON.stringify(r.body));
check('автор комментария проставлен', r.body.comment?.author?.username === userB, JSON.stringify(r.body));
const cB = r.body.comment.id;

r = await a(`/posts/${hot}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Ответ автора поста' }) });
const cA = r.body.comment.id;
check('второй комментарий создан', r.status === 201);

r = await b(`/posts/${hot}/comments`, { method: 'POST', body: JSON.stringify({ body: 'я'.repeat(301) }) });
check('комментарий >300 символов отклонён', r.status === 400, `${r.status}`);

r = await b(`/posts/${hot}/comments`, { method: 'POST', body: JSON.stringify({ body: '  ' }) });
check('пустой комментарий отклонён', r.status === 400, `${r.status}`);

r = await anon(`/posts/${hot}/comments`);
check('тред читается без входа', r.status === 200 && r.body.comments.length === 2, JSON.stringify(r.body));
check('порядок — старые сверху', r.body.comments[0].id < r.body.comments[1].id);

r = await anon('/posts');
seen = r.body.posts.find(p => p.id === hot);
check('лента отдаёт счётчик комментариев', seen?.commentCount === 2, JSON.stringify(seen));

r = await anon(`/posts/999999/comments`);
check('комментарии несуществующего поста = 404', r.status === 404, `${r.status}`);

console.log('\n— права на комментарии —');
r = await anon(`/comments/${cB}`, { method: 'DELETE' });
check('аноним не удаляет комментарии', r.status === 401, `${r.status}`);

// «a» — автор поста, «cB» — комментарий пользователя «b» под этим постом.
r = await a(`/comments/${cB}`, { method: 'DELETE' });
check('автор поста модерирует чужой коммент', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);

// «cA» — комментарий пользователя «a» под постом пользователя «a».
r = await b(`/comments/${cA}`, { method: 'DELETE' });
check('чужой коммент под чужим постом удалить нельзя', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);

r = await a(`/comments/${cA}`, { method: 'DELETE' });
check('свой комментарий удаляется', r.status === 200, `${r.status}`);

r = await a(`/comments/${cA}`, { method: 'DELETE' });
check('повторное удаление коммента = 404', r.status === 404, `${r.status}`);

r = await anon(`/posts/${hot}/comments`);
check('тред опустел', r.body.comments.length === 0, JSON.stringify(r.body));

console.log('\n— каскадное удаление —');
r = await b(`/posts/${hot}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Останусь сиротой?' }) });
const orphan = r.body.comment.id;
await b(`/posts/${hot}/like`, { method: 'PUT' });
r = await a(`/posts/${hot}`, { method: 'DELETE' });
check('пост с лайками и комментами удалён', r.status === 200, `${r.status}`);
r = await b(`/comments/${orphan}`, { method: 'DELETE' });
check('комментарии ушли вместе с постом', r.status === 404, `${r.status}`);

console.log('\n— подписки —');
r = await anon(`/users/${userB}/follow`, { method: 'PUT' });
check('аноним не может подписаться', r.status === 401, `${r.status}`);

r = await a(`/users/${userA}/follow`, { method: 'PUT' });
check('нельзя подписаться на себя', r.status === 400, `${r.status}`);

r = await a(`/users/net_takogo_${stamp}/follow`, { method: 'PUT' });
check('подписка на несуществующего = 404', r.status === 404, `${r.status}`);

r = await a(`/users/${userB}/follow`, { method: 'PUT' });
check('подписка оформлена', r.status === 200 && r.body.followedByMe === true && r.body.followerCount === 1, JSON.stringify(r.body));

r = await a(`/users/${userB}/follow`, { method: 'PUT' });
check('повторная подписка не удваивает счёт', r.body.followerCount === 1, JSON.stringify(r.body));

r = await a(`/users/${userB}`);
check('подписка видна в профиле', r.body.user?.followedByMe === true, JSON.stringify(r.body.user));

r = await anon(`/users/${userB}`);
check('аноним не помечен подписанным', r.body.user?.followedByMe === false, JSON.stringify(r.body.user));

r = await b(`/users/${userA}`);
check('счётчик подписок автора виден', r.body.user?.followingCount === 1, JSON.stringify(r.body.user));

console.log('\n— поиск людей —');
r = await anon('/users/search');
check('поиск без запроса = пустой список, не все пользователи', r.status === 200 && Array.isArray(r.body.users) && r.body.users.length === 0, JSON.stringify(r.body));

r = await anon(`/users/search?q=${userB.slice(0, 5)}`);
check('поиск по части логина находит', r.body.users?.some(u => u.username === userB), JSON.stringify(r.body.users?.map(u => u.username)));

r = await anon('/users/search?q=Борис');
check('поиск по отображаемому имени', r.body.users?.some(u => u.username === userB), JSON.stringify(r.body.users?.map(u => u.username)));

r = await anon('/users/search?q=бОрИс');
check('поиск не зависит от регистра', r.body.users?.some(u => u.username === userB), JSON.stringify(r.body.users?.map(u => u.username)));

r = await anon(`/users/search?q=${userB}`);
check('точное совпадение логина — первым в списке', r.body.users?.[0]?.username === userB, JSON.stringify(r.body.users?.map(u => u.username)));

r = await anon('/users/search?q=%');
check('спецсимвол LIKE не ломает поиск', r.status === 200 && Array.isArray(r.body.users), `${r.status} ${JSON.stringify(r.body)}`);

r = await anon(`/users/search?q=net_takogo_${stamp}_net`);
check('поиск без совпадений — пустой список, не ошибка', r.status === 200 && r.body.users?.length === 0, JSON.stringify(r.body));

r = await anon(`/users/search?q=${userB}`);
check('в результатах нет пароля', !JSON.stringify(r.body).toLowerCase().includes('scrypt'), JSON.stringify(r.body));

console.log('\n— своя лента —');
const userC = `carl_${stamp}`;
const c = makeClient();
await legacySignUp(c, userC, 'Карл');
r = await c('/posts', { method: 'POST', body: JSON.stringify({ body: 'Пост постороннего, на которого никто не подписан' }) });
const outsiderPost = r.body.post.id;

// Свежий пост a: без него его старые посты может вытеснить с первой
// страницы серия из 24 постов b, созданная в блоке пагинации выше.
r = await a('/posts', { method: 'POST', body: JSON.stringify({ body: 'Свежий пост в проверке своей ленты' }) });
const freshOwnPost = r.body.post.id;

r = await anon('/posts?feed=following');
check('лента подписок требует входа', r.status === 401, `${r.status}`);

r = await a('/posts?feed=following');
check('в ленте подписок нет постороннего', !r.body.posts.some(p => p.id === outsiderPost), JSON.stringify(r.body.posts.map(p => p.id)));
check('в ленте подписок есть подписка (b)', r.body.posts.some(p => p.author.username === userB), JSON.stringify(r.body.posts.map(p => p.author.username)));
check('в ленте подписок видны свои посты', r.body.posts.some(p => p.id === freshOwnPost), JSON.stringify(r.body.posts.map(p => p.id)));

r = await a('/posts');
check('в общей ленте посторонний виден', r.body.posts.some(p => p.id === outsiderPost));

r = await a(`/users/${userB}/follow`, { method: 'DELETE' });
check('отписка выполнена', r.status === 200 && r.body.followedByMe === false && r.body.followerCount === 0, JSON.stringify(r.body));

r = await a(`/users/${userB}/follow`, { method: 'DELETE' });
check('повторная отписка не уводит в минус', r.body.followerCount === 0, JSON.stringify(r.body));

console.log('\n— загрузка медиа —');

// Минимально валидные заголовки форматов: проверяем распознавание по сигнатуре,
// а не проигрываемость — декодировать содержимое сервер и не должен.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const MP3_HEAD = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]);
const NOT_MEDIA = Buffer.from('<html><script>alert(1)</script></html>');

const upload = (file, name, type, field = 'media', extra = {}) => {
  const fd = new FormData();
  fd.set(field, new Blob([file], { type }), name);
  for (const [k, val] of Object.entries(extra)) fd.set(k, val);
  return fd;
};

r = await a('/users/me/avatar', { method: 'PUT', body: upload(PNG_1PX, 'me.png', 'image/png', 'avatar') });
check('аватар загружен', r.status === 200 && typeof r.body.user?.avatarUrl === 'string', JSON.stringify(r.body));
const avatarUrl = r.body.user.avatarUrl;
check('аватар лежит в /uploads/avatars/', avatarUrl?.startsWith('/uploads/avatars/'), avatarUrl);

let raw = await fetch(BASE.replace('/api', '') + avatarUrl);
check('аватар отдаётся по ссылке', raw.status === 200, `${raw.status}`);
check('аватар отдан как image/png', raw.headers.get('content-type')?.includes('image/png'), raw.headers.get('content-type'));
check('на аватаре стоит nosniff', raw.headers.get('x-content-type-options') === 'nosniff', raw.headers.get('x-content-type-options'));

r = await anon('/users/me/avatar', { method: 'PUT', body: upload(PNG_1PX, 'me.png', 'image/png', 'avatar') });
check('аноним не грузит аватар', r.status === 401, `${r.status}`);

r = await a('/users/me/avatar', { method: 'PUT', body: upload(NOT_MEDIA, 'evil.png', 'image/png', 'avatar') });
check('html под видом png отклонён', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await a('/users/me/avatar', { method: 'PUT', body: upload(MP3_HEAD, 'song.mp3', 'audio/mpeg', 'avatar') });
check('аудио в аватар не пройдёт', r.status === 400, `${r.status}`);

r = await anon(`/users/${userA}`);
check('аватар виден в чужом профиле', typeof r.body.user?.avatarUrl === 'string', JSON.stringify(r.body.user?.avatarUrl));

console.log('\n— медиа в постах —');
r = await a('/posts', { method: 'POST', body: upload(PNG_1PX, 'photo.png', 'image/png', 'media', { body: 'С картинкой' }) });
check('пост с картинкой создан', r.status === 201, JSON.stringify(r.body));
check('тип медиа определён как image', r.body.post?.media?.type === 'image', JSON.stringify(r.body.post?.media));
check('имя файла сохранено', r.body.post?.media?.name === 'photo.png', JSON.stringify(r.body.post?.media));
const withImage = r.body.post.id;
const mediaUrl = r.body.post.media.url;

// multer читает имя файла как latin1: без переразбора «Закат.png» приходил
// кракозябрами. Ошибка жила здесь незамеченной, пока её не поймал тест вложений.
r = await a('/posts', { method: 'POST', body: upload(PNG_1PX, 'Закат над рекой.png', 'image/png', 'media') });
check('русское имя файла в посте не искажено', r.body.post?.media?.name === 'Закат над рекой.png', JSON.stringify(r.body.post?.media));

raw = await fetch(BASE.replace('/api', '') + mediaUrl);
check('медиа отдаётся по ссылке', raw.status === 200, `${raw.status}`);

r = await a('/posts', { method: 'POST', body: upload(MP4_HEAD, 'clip.mp4', 'video/mp4', 'media', { body: '' }) });
check('пост из одного видео, без текста', r.status === 201 && r.body.post?.media?.type === 'video', `${r.status} ${JSON.stringify(r.body.post?.media)}`);
check('пустой текст сохранён пустым', r.body.post?.body === '', JSON.stringify(r.body.post?.body));

r = await a('/posts', { method: 'POST', body: upload(MP3_HEAD, 'track.mp3', 'audio/mpeg', 'media', { body: 'Трек' }) });
check('пост с аудио создан', r.status === 201 && r.body.post?.media?.type === 'audio', `${r.status} ${JSON.stringify(r.body.post?.media)}`);

r = await a('/posts', { method: 'POST', body: upload(NOT_MEDIA, 'evil.mp4', 'video/mp4', 'media', { body: 'взлом' }) });
check('подделка формата в посте отклонена', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await a('/posts', { method: 'POST', body: JSON.stringify({ body: '' }) });
check('пустой пост без медиа по-прежнему нельзя', r.status === 400, `${r.status}`);

r = await anon('/posts');
const seenImage = r.body.posts.find(p => p.id === withImage);
check('медиа приходит в ленте', seenImage?.media?.url === mediaUrl, JSON.stringify(seenImage?.media));
check('аватар автора приходит в ленте', typeof seenImage?.author?.avatarUrl === 'string', JSON.stringify(seenImage?.author));

console.log('\n— уборка файлов —');
r = await a(`/posts/${withImage}`, { method: 'DELETE' });
check('пост с медиа удалён', r.status === 200, `${r.status}`);
raw = await fetch(BASE.replace('/api', '') + mediaUrl);
check('файл удалён с диска вместе с постом', raw.status === 404, `${raw.status}`);

r = await a('/users/me/avatar', { method: 'DELETE' });
check('аватар снят', r.status === 200 && r.body.user?.avatarUrl === null, JSON.stringify(r.body.user?.avatarUrl));
raw = await fetch(BASE.replace('/api', '') + avatarUrl);
check('файл аватара удалён с диска', raw.status === 404, `${raw.status}`);

console.log('\n— личные сообщения —');
r = await anon(`/messages`);
check('аноним не видит диалоги', r.status === 401, `${r.status}`);

r = await a(`/messages/${userA}`, { method: 'POST', body: JSON.stringify({ body: 'сам себе' }) });
check('себе — можно: это «Избранное»', r.status === 201, `${r.status}`);
await a(`/messages/${userA}/${r.body.message.id}`, { method: 'DELETE' });

r = await a(`/messages/net_takogo_${stamp}`, { method: 'POST', body: JSON.stringify({ body: 'привет' }) });
check('письмо несуществующему = 404', r.status === 404, `${r.status}`);

r = await a(`/messages/${userB}`, { method: 'POST', body: JSON.stringify({ body: 'Борис, привет. Это первое сообщение.' }) });
check('сообщение отправлено', r.status === 201, JSON.stringify(r.body));
const msg1 = r.body.message.id;

r = await a(`/messages/${userB}`, { method: 'POST', body: JSON.stringify({ body: '  ' }) });
check('пустое сообщение отклонено', r.status === 400, `${r.status}`);

r = await a(`/messages/${userB}`, { method: 'POST', body: JSON.stringify({ body: 'я'.repeat(1001) }) });
check('сообщение >1000 символов отклонено', r.status === 400, `${r.status}`);

r = await b(`/messages/${userA}`, { method: 'POST', body: JSON.stringify({ body: 'Привет, Алиса. Отвечаю.' }) });
check('ответ отправлен', r.status === 201, `${r.status}`);

r = await a(`/messages/${userB}`);
check('переписка видна обоим участникам', r.body.messages?.length === 2, JSON.stringify(r.body.messages?.length));
check('порядок — старые сверху', r.body.messages[0].id === msg1, JSON.stringify(r.body.messages.map(m => m.id)));
check('в переписке есть собеседник', r.body.user?.username === userB, JSON.stringify(r.body.user));

console.log('\n— приватность переписки —');
// «c» (Карл) не участник диалога a↔b и не должен видеть ни одного сообщения.
r = await c(`/messages/${userA}`);
check('посторонний не видит чужую переписку', r.body.messages?.length === 0, JSON.stringify(r.body.messages));
r = await c(`/messages/${userB}`);
check('посторонний не видит её и со второй стороны', r.body.messages?.length === 0, JSON.stringify(r.body.messages));

r = await c('/messages');
check('у постороннего пустой список диалогов', r.body.conversations?.length === 0, JSON.stringify(r.body.conversations));

console.log('\n— непрочитанное —');
r = await b('/messages');
check('диалог виден в списке', r.body.conversations?.length === 1, JSON.stringify(r.body.conversations?.length));
check('собеседник в диалоге — отправитель', r.body.conversations[0]?.user?.username === userA, JSON.stringify(r.body.conversations[0]?.user));
check('входящее посчитано непрочитанным', r.body.unreadTotal === 1, `${r.body.unreadTotal}`);
check('последнее сообщение — самое свежее', r.body.conversations[0]?.lastMessage?.body === 'Привет, Алиса. Отвечаю.', JSON.stringify(r.body.conversations[0]?.lastMessage?.body));

r = await b(`/messages/${userA}/read`, { method: 'PUT' });
check('диалог отмечен прочитанным', r.status === 200 && r.body.unreadTotal === 0, JSON.stringify(r.body));

r = await b('/messages');
check('счётчик обнулился', r.body.unreadTotal === 0, `${r.body.unreadTotal}`);

r = await c(`/messages/${userA}/read`, { method: 'PUT' });
check('чужая пометка прочтения ничего не ломает', r.status === 200 && r.body.unreadTotal === 0, JSON.stringify(r.body));
r = await a('/messages');
check('она не тронула чужие сообщения', r.body.unreadTotal === 1, `${r.body.unreadTotal}`);

console.log('\n— пагинация переписки —');
for (let i = 1; i <= 32; i++) {
  await a(`/messages/${userB}`, { method: 'POST', body: JSON.stringify({ body: `Сообщение ${i}` }) });
}
r = await a(`/messages/${userB}`);
check('первая страница = 30 сообщений', r.body.messages?.length === 30, `${r.body.messages?.length}`);
check('есть nextCursor', typeof r.body.nextCursor === 'number', `${r.body.nextCursor}`);
const firstPageIds = r.body.messages.map(m => m.id);

r = await a(`/messages/${userB}?cursor=${r.body.nextCursor}`);
check('вторая страница — более старые', r.body.messages.every(m => !firstPageIds.includes(m.id)), JSON.stringify(r.body.messages.map(m => m.id)));


console.log('\n— восстановление пароля —');
r = await anon('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: `net_takogo_${stamp}@example.test` }) });
const unknownMsg = r.body.message;
check('несуществующий email — тоже 200, без утечки', r.status === 200 && typeof unknownMsg === 'string', JSON.stringify(r.body));

r = await anon('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: `${userA}@example.test` }) });
check('существующий email — тот же ответ', r.status === 200 && r.body.message === unknownMsg, JSON.stringify(r.body));

r = await anon('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: 'мусор' }) });
check('битый email в forgot-password отклонён', r.status === 400, `${r.status}`);

r = await anon('/auth/reset-password/net-takogo-tokena');
check('несуществующий токен — valid:false', r.status === 200 && r.body.valid === false, JSON.stringify(r.body));

const token = lastResetToken(`${userA}@example.test`);
if (!token) {
  check('токен сброса прочитан из БД (нужен DB_PATH)', false, 'DB_PATH не задан — часть проверок восстановления пропущена');
} else {
  r = await anon(`/auth/reset-password/${token}`);
  check('свежий токен — valid:true', r.status === 200 && r.body.valid === true, JSON.stringify(r.body));

  r = await anon('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password: 'korotk' }) });
  check('слишком короткий новый пароль отклонён', r.status === 400, `${r.status}`);

  r = await anon('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password: 'novyparol123' }) });
  check('пароль сброшен', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);

  r = await anon('/auth/login', { method: 'POST', body: JSON.stringify({ username: userA, password: 'novyparol123' }) });
  check('вход по новому паролю работает', r.status === 200, `${r.status}`);

  r = await anon('/auth/login', { method: 'POST', body: JSON.stringify({ username: userA, password: 'parol12345' }) });
  check('старый пароль больше не подходит', r.status === 401, `${r.status}`);

  r = await a('/auth/me');
  check('старая сессия отозвана после сброса пароля', r.body.user === null, JSON.stringify(r.body));

  r = await anon('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password: 'eshhaparol123' }) });
  check('повторное использование токена отклонено', r.status === 400, `${r.status}`);

  r = await anon(`/auth/reset-password/${token}`);
  check('использованный токен — valid:false', r.body.valid === false, JSON.stringify(r.body));
}

console.log('\n— выход —');
r = await a('/auth/logout', { method: 'POST' });
check('logout 200', r.status === 200);
r = await a('/auth/me');
check('сессия недействительна после выхода', r.body.user === null, JSON.stringify(r.body));

console.log('\n— прочее —');
r = await anon('/net-takogo-endpointa');
check('несуществующий API = 404 JSON', r.status === 404 && !!r.body.error, `${r.status}`);

/* ═══════════════════════════════════════════════════════════════════════════
 * Уведомления, блокировки, жалобы и групповые чаты.
 *
 * Секции работают на собственных аккаунтах и на собственном «госте»: клиент
 * `anon` выше к этому моменту уже вошёл как userA — проверка входа по новому
 * паролю оставила ему рабочую куку, и брать его для проверок 401 нельзя.
 * ═══════════════════════════════════════════════════════════════════════════ */

const guest = makeClient();
const n = makeClient(); // Ника — получатель событий
const o = makeClient(); // Олег — источник событий
const p = makeClient(); // Павел — третье лицо, не связанное ни с кем
const d = makeClient(); // Дина — посторонняя, её место в чатах — снаружи

const userN = `nika_${stamp}`;
const userO = `oleg_${stamp}`;
const userP = `pavel_${stamp}`;
const userD = `dina_${stamp}`;

const signUp = (client, name, displayName) => legacySignUp(client, name, displayName);

console.log('\n— уведомления —');
r = await signUp(n, userN, 'Ника');
check('Ника зарегистрирована', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));
r = await signUp(o, userO, 'Олег');
check('Олег зарегистрирован', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));
r = await signUp(p, userP, 'Павел');
check('Павел зарегистрирован', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));
r = await signUp(d, userD, 'Дина');
check('Дина зарегистрирована', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));

r = await guest('/notifications');
check('лента событий требует входа', r.status === 401, `${r.status}`);
r = await guest('/badges');
check('счётчики требуют входа', r.status === 401, `${r.status}`);
r = await guest('/notifications/read', { method: 'PUT' });
check('погашение событий требует входа', r.status === 401, `${r.status}`);

r = await n('/posts', { method: 'POST', body: JSON.stringify({ body: 'Запись Ники, вокруг которой соберутся события' }) });
const postN = r.body.post.id;
check('пост Ники создан', r.status === 201, JSON.stringify(r.body));

// Уведомление о лайке ведёт на /p/:id, поэтому одиночный пост проверяется здесь же.
r = await guest(`/posts/${postN}`);
check('одиночный пост доступен без входа', r.status === 200 && r.body.post?.id === postN, `${r.status} ${JSON.stringify(r.body)}`);
check('одиночный пост сериализован как в ленте', r.body.post?.author?.username === userN
  && typeof r.body.post?.likeCount === 'number' && r.body.post?.likedByMe === false, JSON.stringify(r.body.post));
r = await guest('/posts/999999');
check('несуществующий одиночный пост = 404', r.status === 404, `${r.status}`);
r = await guest('/posts/musor');
check('нечисловой id поста = 404, а не 500', r.status === 404, `${r.status}`);
r = await guest(`/posts/${postN}/comments`);
check('маршрут /posts/:id не перехватил тред комментариев', r.status === 200 && Array.isArray(r.body.comments), `${r.status}`);

r = await n(`/posts/${postN}/like`, { method: 'PUT' });
check('свой лайк принят', r.status === 200, `${r.status}`);
r = await n('/notifications');
check('свой лайк события не создаёт', r.body.notifications?.length === 0 && r.body.unread === 0, JSON.stringify(r.body));

r = await o(`/posts/${postN}/like`, { method: 'PUT' });
check('чужой лайк принят', r.status === 200, `${r.status}`);
r = await n('/notifications');
let ev = r.body.notifications?.[0];
check('лайк создал событие', r.body.notifications?.length === 1 && ev?.kind === 'like', JSON.stringify(r.body.notifications));
check('в событии указан актор', ev?.actor?.username === userO, JSON.stringify(ev?.actor));
check('в событии о лайке есть пост', ev?.post?.id === postN, JSON.stringify(ev?.post));
check('у лайка нет комментария и чата', ev?.comment === null && ev?.chat === null, JSON.stringify(ev));
check('событие непрочитано', ev?.readAt === null, JSON.stringify(ev?.readAt));
check('счётчик непрочитанных = 1', r.body.unread === 1, `${r.body.unread}`);

await o(`/posts/${postN}/like`, { method: 'PUT' });
r = await n('/notifications');
check('повторный лайк не создаёт второго события', r.body.notifications.length === 1, `${r.body.notifications.length}`);

await o(`/posts/${postN}/like`, { method: 'DELETE' });
r = await n('/notifications');
check('снятие лайка убирает непрочитанное событие', r.body.notifications.length === 0 && r.body.unread === 0, JSON.stringify(r.body));

r = await o(`/posts/${postN}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Хороший текст, Ника.' }) });
const cO = r.body.comment.id;
check('комментарий Олега создан', r.status === 201, JSON.stringify(r.body));
r = await n('/notifications');
ev = r.body.notifications.find(x => x.kind === 'comment');
check('комментарий создал событие', !!ev, JSON.stringify(r.body.notifications));
check('в событии о комментарии заполнены и пост, и комментарий', ev?.post?.id === postN && ev?.comment?.id === cO, JSON.stringify(ev));
check('excerpt комментария совпадает с текстом', ev?.comment?.excerpt === 'Хороший текст, Ника.', JSON.stringify(ev?.comment));

await n(`/posts/${postN}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Спасибо, Олег.' }) });
r = await n('/notifications');
check('свой комментарий события не создаёт', r.body.notifications.filter(x => x.kind === 'comment').length === 1, JSON.stringify(r.body.notifications.map(x => x.kind)));

r = await o(`/users/${userN}/follow`, { method: 'PUT' });
check('подписка оформлена', r.status === 200, `${r.status}`);
r = await n('/notifications');
ev = r.body.notifications.find(x => x.kind === 'follow');
check('подписка создала событие', ev?.actor?.username === userO, JSON.stringify(r.body.notifications.map(x => x.kind)));
check('у подписки нет предмета', ev?.post === null && ev?.comment === null && ev?.chat === null, JSON.stringify(ev));

await o(`/users/${userN}/follow`, { method: 'DELETE' });
r = await n('/notifications');
check('отписка убирает непрочитанное событие', !r.body.notifications.some(x => x.kind === 'follow'), JSON.stringify(r.body.notifications.map(x => x.kind)));
await o(`/users/${userN}/follow`, { method: 'PUT' });

r = await o(`/messages/${userN}`, { method: 'POST', body: JSON.stringify({ body: 'Ника, привет. Есть разговор.' }) });
check('ЛС отправлено', r.status === 201, `${r.status}`);
await o(`/messages/${userN}`, { method: 'POST', body: JSON.stringify({ body: 'И ещё одно, вдогонку.' }) });
r = await n('/notifications');
check('два сообщения схлопнулись в одно событие', r.body.notifications.filter(x => x.kind === 'message').length === 1, JSON.stringify(r.body.notifications.map(x => x.kind)));

r = await n('/badges');
check('badges отдаёт три числа', typeof r.body.messages === 'number' && typeof r.body.chats === 'number'
  && typeof r.body.notifications === 'number', JSON.stringify(r.body));
check('непрочитанные ЛС посчитаны', r.body.messages === 2, JSON.stringify(r.body));
check('групповых чатов пока нет', r.body.chats === 0, `${r.body.chats}`);
const badgeNotif = r.body.notifications;
r = await n('/notifications');
check('badges.notifications совпадает с unread ленты', badgeNotif === r.body.unread, `${badgeNotif} vs ${r.body.unread}`);

await n(`/messages/${userO}/read`, { method: 'PUT' });
r = await n('/notifications');
check('прочтение диалога гасит событие о сообщении',
  !r.body.notifications.some(x => x.kind === 'message' && x.readAt === null), JSON.stringify(r.body.notifications));

const foreignEvent = r.body.notifications[0].id;
r = await p(`/notifications/${foreignEvent}/read`, { method: 'PUT' });
check('чужое событие погасить нельзя (404)', r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);
r = await p('/notifications');
check('чужие события не видны в своей ленте', r.body.notifications.length === 0, JSON.stringify(r.body.notifications));
r = await n('/notifications/musor/read', { method: 'PUT' });
check('нечисловой id события = 404', r.status === 404, `${r.status}`);
r = await n('/notifications/999999/read', { method: 'PUT' });
check('несуществующее событие = 404', r.status === 404, `${r.status}`);

r = await n('/notifications');
const eventCount = r.body.notifications.length;
const unreadBefore = r.body.unread;
check('есть непрочитанные события', unreadBefore > 0, `${unreadBefore}`);
const oneUnread = r.body.notifications.find(x => x.readAt === null).id;
r = await n(`/notifications/${oneUnread}/read`, { method: 'PUT' });
check('одно событие погашено', r.status === 200 && r.body.unread === unreadBefore - 1, JSON.stringify(r.body));
r = await n(`/notifications/${oneUnread}/read`, { method: 'PUT' });
check('повторное погашение — не ошибка', r.status === 200 && r.body.unread === unreadBefore - 1, JSON.stringify(r.body));

r = await n('/notifications/read', { method: 'PUT' });
check('погашены все события', r.status === 200 && r.body.unread === 0, JSON.stringify(r.body));
r = await n('/notifications');
check('лента после погашения не укоротилась', r.body.notifications.length === eventCount, `${r.body.notifications.length} vs ${eventCount}`);
check('непрочитанных не осталось', r.body.unread === 0 && r.body.notifications.every(x => x.readAt !== null), JSON.stringify(r.body.unread));
r = await n('/badges');
check('счётчик событий обнулился', r.body.notifications === 0, `${r.body.notifications}`);

console.log('\n— блокировки —');
r = await o('/posts', { method: 'POST', body: JSON.stringify({ body: 'Запись Олега, которая должна исчезнуть' }) });
const postO = r.body.post.id;
r = await p('/posts', { method: 'POST', body: JSON.stringify({ body: 'Запись Павла для проверки треда' }) });
const postP = r.body.post.id;
await o(`/posts/${postP}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Комментарий Олега' }) });
await p(`/posts/${postP}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Комментарий Павла' }) });

r = await n(`/users/${userO}/follow`, { method: 'PUT' });
check('взаимная подписка оформлена', r.status === 200 && r.body.followedByMe === true, JSON.stringify(r.body));

r = await guest(`/users/${userO}/block`, { method: 'PUT' });
check('блокировка требует входа', r.status === 401, `${r.status}`);
r = await n(`/users/${userN}/block`, { method: 'PUT' });
check('заблокировать себя нельзя (400)', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await n(`/users/net_takogo_${stamp}/block`, { method: 'PUT' });
check('блокировка несуществующего = 404', r.status === 404, `${r.status}`);

r = await n(`/users/${userO}/block`, { method: 'PUT' });
check('блокировка выполнена', r.status === 200 && r.body.blockedByMe === true, JSON.stringify(r.body));
r = await n(`/users/${userO}/block`, { method: 'PUT' });
check('повторная блокировка идемпотентна', r.status === 200 && r.body.blockedByMe === true, JSON.stringify(r.body));

r = await n('/posts');
check('посты заблокированного пропали из ленты', !r.body.posts.some(x => x.id === postO), JSON.stringify(r.body.posts.map(x => x.id)));
r = await n(`/posts?author=${userO}`);
check('лента профиля заблокированного пуста', r.body.posts.length === 0, JSON.stringify(r.body.posts.map(x => x.id)));
r = await o('/posts');
check('правило симметрично: посты блокирующего скрыты и у второй стороны', !r.body.posts.some(x => x.id === postN), JSON.stringify(r.body.posts.map(x => x.id)));
r = await p('/posts');
check('третье лицо видит обе записи', r.body.posts.some(x => x.id === postO) && r.body.posts.some(x => x.id === postN), JSON.stringify(r.body.posts.map(x => x.id)));
r = await n(`/posts/${postO}`);
check('одиночный пост заблокированного = 404', r.status === 404, `${r.status}`);

r = await n(`/posts/${postP}/comments`);
check('комментарий заблокированного скрыт из чужого треда',
  r.body.comments.length === 1 && r.body.comments[0].author.username === userP, JSON.stringify(r.body.comments.map(x => x.author.username)));
r = await n(`/posts/${postP}`);
check('commentCount совпадает с длиной видимого треда', r.body.post?.commentCount === 1, `${r.body.post?.commentCount}`);
r = await p(`/posts/${postP}`);
check('у постороннего счётчик комментариев полный', r.body.post?.commentCount === 2, `${r.body.post?.commentCount}`);
r = await o(`/posts/${postN}/comments`, { method: 'POST', body: JSON.stringify({ body: 'не пройдёт' }) });
check('комментарий к посту блокирующего = 403', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
r = await n(`/posts/${postP}/comments`, { method: 'POST', body: JSON.stringify({ body: 'А к посту третьего лица можно' }) });
check('комментарий к посту третьего лица проходит', r.status === 201, `${r.status}`);

r = await n(`/users/search?q=${userO}`);
check('заблокированный пропал из поиска', !r.body.users.some(u => u.username === userO), JSON.stringify(r.body.users.map(u => u.username)));
r = await o(`/users/search?q=${userN}`);
check('и блокирующий пропал из поиска у него', !r.body.users.some(u => u.username === userN), JSON.stringify(r.body.users.map(u => u.username)));
r = await p(`/users/search?q=${userO}`);
check('у третьего лица поиск по-прежнему находит', r.body.users.some(u => u.username === userO), JSON.stringify(r.body.users.map(u => u.username)));

r = await n(`/messages/${userO}`, { method: 'POST', body: JSON.stringify({ body: 'после блокировки' }) });
check('ЛС от блокирующего = 403', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
const blockedMsg = r.body.error;
r = await o(`/messages/${userN}`, { method: 'POST', body: JSON.stringify({ body: 'после блокировки' }) });
check('ЛС в обратную сторону = 403 с тем же текстом', r.status === 403 && r.body.error === blockedMsg, `${r.status} ${r.body.error}`);

r = await n(`/users/${userO}`);
check('в профиле стоит blockedByMe', r.body.user?.blockedByMe === true && r.body.user?.blocksMe === false, JSON.stringify(r.body.user));
check('взаимные подписки сняты', r.body.user?.followedByMe === false && r.body.user?.followerCount === 0, JSON.stringify(r.body.user));
r = await o(`/users/${userN}`);
check('у второй стороны стоит blocksMe', r.body.user?.blocksMe === true && r.body.user?.blockedByMe === false, JSON.stringify(r.body.user));
check('его подписка тоже снята', r.body.user?.followedByMe === false, JSON.stringify(r.body.user?.followedByMe));
r = await guest(`/users/${userO}`);
check('у анонима оба флага блокировки false', r.body.user?.blockedByMe === false && r.body.user?.blocksMe === false, JSON.stringify(r.body.user));

r = await n(`/users/${userO}/follow`, { method: 'PUT' });
check('подписаться на заблокированного нельзя (400)', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await n('/messages');
const convO = r.body.conversations?.find(x => x.user.username === userO);
check('диалог с заблокированным помечен флагом', convO?.blocked === true, JSON.stringify(convO?.blocked));
r = await n(`/messages/${userO}`);
check('в треде тоже стоит blocked', r.body.blocked === true, JSON.stringify(r.body.blocked));
check('история переписки не удалена', r.body.messages?.length > 0, `${r.body.messages?.length}`);

r = await n('/users/me/blocks');
check('заблокированный есть в списке', r.body.users?.some(u => u.username === userO), JSON.stringify(r.body.users?.map(u => u.username)));
r = await o('/users/me/blocks');
check('у второй стороны список блокировок пуст', r.body.users?.length === 0, JSON.stringify(r.body.users));
r = await guest('/users/me/blocks');
check('список блокировок требует входа', r.status === 401, `${r.status}`);
r = await n('/users/me');
check('маршрут me/blocks не перехватил профиль «me»', r.status === 404, `${r.status}`);

r = await n(`/users/${userO}/block`, { method: 'DELETE' });
check('блокировка снята', r.status === 200 && r.body.blockedByMe === false, JSON.stringify(r.body));
r = await n(`/users/${userO}/block`, { method: 'DELETE' });
check('повторное снятие идемпотентно', r.status === 200 && r.body.blockedByMe === false, JSON.stringify(r.body));
r = await n('/posts');
check('посты вернулись в ленту', r.body.posts.some(x => x.id === postO), JSON.stringify(r.body.posts.map(x => x.id)));
r = await n(`/posts/${postO}`);
check('одиночный пост снова доступен', r.status === 200, `${r.status}`);
r = await n(`/posts/${postP}/comments`);
check('скрытый комментарий вернулся в тред', r.body.comments.some(x => x.author.username === userO), JSON.stringify(r.body.comments.map(x => x.author.username)));
r = await n(`/users/search?q=${userO}`);
check('поиск снова находит', r.body.users.some(u => u.username === userO), JSON.stringify(r.body.users.map(u => u.username)));
r = await n(`/messages/${userO}`, { method: 'POST', body: JSON.stringify({ body: 'Разобрались, пишу снова.' }) });
check('ЛС снова проходит', r.status === 201, `${r.status}`);
r = await n('/users/me/blocks');
check('список блокировок опустел', r.body.users?.length === 0, JSON.stringify(r.body.users));

console.log('\n— жалобы —');
r = await guest('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: postN, reason: 'spam' }) });
check('жалоба требует входа', r.status === 401, `${r.status}`);

r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: postN, reason: 'spam', note: 'реклама в ленте' }) });
check('жалоба на пост принята', r.status === 201 && r.body.ok === true && r.body.alreadyReported === false, `${r.status} ${JSON.stringify(r.body)}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: postN, reason: 'abuse' }) });
check('повторная жалоба идемпотентна', r.status === 201 && r.body.alreadyReported === true, `${r.status} ${JSON.stringify(r.body)}`);
r = await o('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: postN, reason: 'spam' }) });
check('жалоба другого человека на тот же объект — новая', r.status === 201 && r.body.alreadyReported === false, `${r.status} ${JSON.stringify(r.body)}`);

r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'comment', targetId: cO, reason: 'abuse' }) });
check('жалоба на комментарий принята', r.status === 201 && r.body.alreadyReported === false, `${r.status} ${JSON.stringify(r.body)}`);

r = await p(`/users/${userO}`);
const idO = r.body.user.id;
r = await p(`/users/${userP}`);
const idP = r.body.user.id;
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'user', targetId: idO, reason: 'other', note: 'ведёт себя грубо' }) });
check('жалоба на пользователя принята', r.status === 201 && r.body.alreadyReported === false, `${r.status} ${JSON.stringify(r.body)}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'user', targetId: idP, reason: 'other' }) });
check('жалоба на себя отклонена (400)', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: postN, reason: 'nepravilnaya' }) });
check('причина не из списка отклонена', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'stena', targetId: postN, reason: 'spam' }) });
check('неизвестный тип объекта отклонён', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: postN }) });
check('жалоба без причины отклонена', r.status === 400, `${r.status}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: 'musor', reason: 'spam' }) });
check('нечисловой id объекта отклонён', r.status === 400, `${r.status}`);
// parseInt("1e+21") дал бы 1 и увёл жалобу на объект №1 — здесь ждём отказ.
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: 1e21, reason: 'spam' }) });
check('id за границей целых отклонён, а не обрезан', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: postN, reason: 'spam', note: 'я'.repeat(301) }) });
check('комментарий к жалобе >300 символов отклонён', r.status === 400, `${r.status}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: 999999, reason: 'spam' }) });
check('жалоба на несуществующий пост = 404', r.status === 404, `${r.status}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'comment', targetId: 999999, reason: 'spam' }) });
check('жалоба на несуществующий комментарий = 404', r.status === 404, `${r.status}`);
r = await p('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'user', targetId: 999999, reason: 'spam' }) });
check('жалоба на несуществующего пользователя = 404', r.status === 404, `${r.status}`);

console.log('\n— групповые чаты —');
r = await guest('/chats');
check('чаты требуют входа', r.status === 401, `${r.status}`);

r = await n('/chats', { method: 'POST', body: JSON.stringify({ title: 'Поход выходного дня', members: [userO, userP] }) });
check('чат создан', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
const chatId = r.body.chat.id;
check('в чате трое', r.body.chat?.memberCount === 3 && r.body.chat?.members?.length === 3, JSON.stringify(r.body.chat?.memberCount));
check('создатель — владелец и первый в списке', r.body.chat?.iAmOwner === true && r.body.chat?.members[0].username === userN, JSON.stringify(r.body.chat?.members?.map(m => m.username)));
check('название сохранено', r.body.chat?.title === 'Поход выходного дня', JSON.stringify(r.body.chat?.title));

r = await n('/chats', { method: 'POST', body: JSON.stringify({ title: '   ', members: [userO] }) });
check('пустое название чата отклонено', r.status === 400, `${r.status}`);
r = await n('/chats', { method: 'POST', body: JSON.stringify({ title: 'я'.repeat(61), members: [userO] }) });
check('название чата >60 символов отклонено', r.status === 400, `${r.status}`);
r = await n('/chats', { method: 'POST', body: JSON.stringify({ title: 'Один в поле', members: [] }) });
check('чат в одиночку отклонён', r.status === 400, `${r.status}`);
r = await n('/chats', { method: 'POST', body: JSON.stringify({ title: 'Не массив', members: userO }) });
check('участники не массивом отклонены', r.status === 400, `${r.status}`);
r = await n('/chats', { method: 'POST', body: JSON.stringify({ title: 'Число вместо имени', members: [42] }) });
check('число вместо имени участника отклонено', r.status === 400, `${r.status}`);
r = await n('/chats', { method: 'POST', body: JSON.stringify({ title: 'Призрак', members: [`net_takogo_${stamp}`] }) });
check('несуществующий участник отклонён с указанием имени',
  r.status === 400 && r.body.error?.includes(`net_takogo_${stamp}`), `${r.status} ${JSON.stringify(r.body)}`);
r = await n('/chats', {
  method: 'POST',
  body: JSON.stringify({ title: 'Двадцать один', members: Array.from({ length: 20 }, (_, i) => `nobody${i}_${stamp}`) }),
});
check('21 участник отклонён по количеству, а не по именам',
  r.status === 400 && r.body.error?.includes('20'), `${r.status} ${JSON.stringify(r.body)}`);

r = await o('/chats');
check('чат виден участнику', r.body.chats?.some(x => x.id === chatId), JSON.stringify(r.body.chats?.map(x => x.id)));
r = await d('/chats');
check('у постороннего список чатов пуст', r.body.chats?.length === 0 && r.body.unreadTotal === 0, JSON.stringify(r.body));

r = await d(`/chats/${chatId}`);
check('посторонний не видит чат (404)', r.status === 404 && r.body.error === 'Чат не найден', `${r.status} ${JSON.stringify(r.body)}`);
r = await d(`/chats/${chatId}/messages`);
check('посторонний не читает переписку (404)', r.status === 404, `${r.status}`);
r = await d(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'подслушал' }) });
check('посторонний не пишет в чат (404)', r.status === 404, `${r.status}`);
r = await d(`/chats/${chatId}/read`, { method: 'PUT' });
check('посторонний не отмечает прочтение (404)', r.status === 404, `${r.status}`);
r = await d(`/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title: 'теперь мой' }) });
check('посторонний не переименовывает чат (404)', r.status === 404, `${r.status}`);
r = await d(`/chats/${chatId}`, { method: 'DELETE' });
check('посторонний не удаляет чат (404)', r.status === 404, `${r.status}`);
r = await d(`/chats/${chatId}/members`, { method: 'POST', body: JSON.stringify({ username: userD }) });
check('посторонний не добавляет себя в чат (404)', r.status === 404, `${r.status}`);
r = await d(`/chats/${chatId}/members/${userP}`, { method: 'DELETE' });
check('посторонний не удаляет участников (404)', r.status === 404, `${r.status}`);
r = await n('/chats/999999');
check('несуществующий чат = 404', r.status === 404, `${r.status}`);
r = await n('/chats/musor');
check('нечисловой id чата = 404, а не 500', r.status === 404, `${r.status}`);

r = await n(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ body: '   ' }) });
check('пустое сообщение чата отклонено', r.status === 400, `${r.status}`);
r = await n(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'я'.repeat(1001) }) });
check('сообщение чата >1000 символов отклонено', r.status === 400, `${r.status}`);
r = await n(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Выходим в субботу в семь.' }) });
check('сообщение в чат отправлено', r.status === 201 && r.body.message?.chatId === chatId, `${r.status} ${JSON.stringify(r.body)}`);
check('в сообщении чата есть автор', r.body.message?.author?.username === userN, JSON.stringify(r.body.message?.author));

// 33 реплики одного человека: и страница в 30, и схлопывание событий по чату.
for (let i = 1; i <= 33; i++) {
  await o(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ body: `Реплика ${i}` }) });
}

r = await p('/notifications');
const chatEvents = r.body.notifications.filter(x => x.kind === 'chat_message');
check('33 сообщения одного человека дали одно событие',
  chatEvents.filter(x => x.actor.username === userO).length === 1, JSON.stringify(chatEvents.map(x => x.actor.username)));
check('в событии о чате есть сам чат',
  chatEvents[0]?.chat?.id === chatId && chatEvents[0]?.chat?.title === 'Поход выходного дня', JSON.stringify(chatEvents[0]?.chat));
check('приглашение в чат пришло событием',
  r.body.notifications.some(x => x.kind === 'chat_invite' && x.chat?.id === chatId && x.actor?.username === userN),
  JSON.stringify(r.body.notifications.map(x => x.kind)));

r = await p(`/chats/${chatId}/messages`);
check('первая страница чата = 30 сообщений', r.body.messages?.length === 30, `${r.body.messages?.length}`);
check('порядок в чате — старые сверху', r.body.messages[0].id < r.body.messages.at(-1).id, JSON.stringify([r.body.messages[0].id, r.body.messages.at(-1).id]));
check('nextCursor = id самого старого на странице', r.body.nextCursor === r.body.messages[0].id, `${r.body.nextCursor} vs ${r.body.messages[0].id}`);
check('вместе с сообщениями приходит сам чат', r.body.chat?.id === chatId, JSON.stringify(r.body.chat?.id));
const chatPageIds = r.body.messages.map(m => m.id);
r = await p(`/chats/${chatId}/messages?cursor=${r.body.nextCursor}`);
check('вторая страница чата — более старые и без пересечений',
  r.body.messages.length === 4 && r.body.messages.every(m => !chatPageIds.includes(m.id)), JSON.stringify(r.body.messages.map(m => m.id)));
check('дальше страниц в чате нет', r.body.nextCursor === null, `${r.body.nextCursor}`);
r = await p(`/chats/${chatId}/messages?cursor=musor`);
check('мусорный курсор не ломает переписку', r.status === 200 && r.body.messages.length === 30, `${r.status} ${r.body.messages?.length}`);

r = await p('/chats');
let mine = r.body.chats.find(x => x.id === chatId);
check('непрочитанное в чате посчитано', mine?.unread === 34, `${mine?.unread}`);
check('unreadTotal — сумма по чатам', r.body.unreadTotal === 34, `${r.body.unreadTotal}`);
check('в превью — последнее сообщение', mine?.lastMessage?.body === 'Реплика 33', JSON.stringify(mine?.lastMessage?.body));
r = await p('/badges');
check('badges.chats совпадает с unreadTotal', r.body.chats === 34, `${r.body.chats}`);
r = await o('/chats');
check('свои сообщения в непрочитанное не идут', r.body.chats.find(x => x.id === chatId)?.unread === 1, JSON.stringify(r.body.chats.find(x => x.id === chatId)?.unread));

r = await p(`/chats/${chatId}/read`, { method: 'PUT' });
check('чат отмечен прочитанным', r.status === 200 && r.body.unread === 0, JSON.stringify(r.body));
r = await p('/badges');
check('счётчик чатов обнулился', r.body.chats === 0, `${r.body.chats}`);
r = await p('/notifications');
check('прочтение чата погасило событие о нём',
  !r.body.notifications.some(x => x.kind === 'chat_message' && x.readAt === null), JSON.stringify(r.body.notifications.filter(x => x.kind === 'chat_message').map(x => x.readAt)));
r = await p(`/chats/${chatId}/read`, { method: 'PUT' });
check('повторная отметка прочтения — не ошибка', r.status === 200 && r.body.unread === 0, JSON.stringify(r.body));

await n(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'И не забудьте термос.' }) });
r = await p('/chats');
check('новое сообщение снова поднимает счётчик', r.body.chats.find(x => x.id === chatId)?.unread === 1, JSON.stringify(r.body.chats.find(x => x.id === chatId)?.unread));

r = await o(`/chats/${chatId}/members`, { method: 'POST', body: JSON.stringify({ username: userD }) });
check('участника добавляет не только владелец', r.status === 201 && r.body.chat?.memberCount === 4, `${r.status} ${JSON.stringify(r.body.chat?.memberCount)}`);
r = await d(`/chats/${chatId}`);
check('добавленный получил доступ к чату', r.status === 200 && r.body.chat?.id === chatId, `${r.status}`);
r = await d('/notifications');
check('добавленному пришло событие chat_invite',
  r.body.notifications.some(x => x.kind === 'chat_invite' && x.chat?.id === chatId), JSON.stringify(r.body.notifications.map(x => x.kind)));
r = await o(`/chats/${chatId}/members`, { method: 'POST', body: JSON.stringify({ username: userD }) });
check('повторное добавление отклонено', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await o(`/chats/${chatId}/members`, { method: 'POST', body: JSON.stringify({ username: `net_takogo_${stamp}` }) });
check('добавление несуществующего отклонено', r.status === 400, `${r.status}`);
r = await o(`/chats/${chatId}/members`, { method: 'POST', body: JSON.stringify({ username: 42 }) });
check('имя участника не строкой отклонено', r.status === 400, `${r.status}`);

r = await o(`/chats/${chatId}/members/${userP}`, { method: 'DELETE' });
check('участник не может удалить другого (403)', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
r = await n(`/chats/${chatId}/members/${userD}`, { method: 'DELETE' });
check('владелец удалил участника', r.status === 200 && r.body.ok === true && r.body.left === undefined, JSON.stringify(r.body));
r = await d(`/chats/${chatId}`);
check('удалённый потерял доступ', r.status === 404, `${r.status}`);
r = await d('/notifications');
check('удалённому не осталось непрочитанных событий о чате',
  !r.body.notifications.some(x => x.chat?.id === chatId && x.readAt === null), JSON.stringify(r.body.notifications.map(x => [x.kind, x.readAt])));
r = await n(`/chats/${chatId}/members/${userD}`, { method: 'DELETE' });
check('удаление не-участника = 404 «Участник не найден»', r.status === 404 && r.body.error === 'Участник не найден', `${r.status} ${JSON.stringify(r.body)}`);

r = await o(`/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title: 'Не мой чат' }) });
check('переименовать может только владелец (403)', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
r = await n(`/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title: 'Поход в горы' }) });
check('владелец переименовал чат', r.status === 200 && r.body.chat?.title === 'Поход в горы', `${r.status} ${JSON.stringify(r.body.chat?.title)}`);
r = await n(`/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title: 'я'.repeat(61) }) });
check('длинное название при переименовании отклонено', r.status === 400, `${r.status}`);

// Блокировка внутри общей комнаты: реплики скрыты, человек в составе остаётся.
await p(`/users/${userO}/block`, { method: 'PUT' });
r = await p(`/chats/${chatId}/messages`);
check('сообщения заблокированного скрыты в чате', r.body.messages.every(m => m.author.username !== userO), JSON.stringify(r.body.messages.map(m => m.author.username)));
check('состав участников остался полным', r.body.chat?.memberCount === 3, `${r.body.chat?.memberCount}`);
r = await o(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Слышно меня?' }) });
check('заблокированный по-прежнему пишет в общий чат', r.status === 201, `${r.status}`);
r = await p('/chats');
check('его сообщение не попало в непрочитанное', r.body.chats.find(x => x.id === chatId)?.unread === 1, JSON.stringify(r.body.chats.find(x => x.id === chatId)?.unread));
r = await p('/chats', { method: 'POST', body: JSON.stringify({ title: 'Без него', members: [userO, userN] }) });
check('создать чат с заблокированным нельзя', r.status === 400 && r.body.error?.includes(userO), `${r.status} ${JSON.stringify(r.body)}`);
r = await p('/chats', { method: 'POST', body: JSON.stringify({ title: 'Вдвоём', members: [userN] }) });
check('чат на двоих создан', r.status === 201 && r.body.chat?.memberCount === 2, `${r.status} ${JSON.stringify(r.body)}`);
const pairChat = r.body.chat.id;
r = await p(`/chats/${pairChat}/members`, { method: 'POST', body: JSON.stringify({ username: userO }) });
check('добавить заблокированного в чат нельзя', r.status === 400 && r.body.error?.includes(userO), `${r.status} ${JSON.stringify(r.body)}`);
await p(`/users/${userO}/block`, { method: 'DELETE' });
r = await p(`/chats/${chatId}/messages`);
check('после разблокировки реплики вернулись', r.body.messages.some(m => m.author.username === userO), JSON.stringify(r.body.messages.map(m => m.author.username)));

// Граница «20 участников» на живых людях: ранний отказ по длине списка её не
// проверяет — этот путь идёт через базу и счёт уже созданных участников.
const bulk = [];
for (let i = 0; i < 17; i++) {
  const name = `m${i}_${stamp}`;
  await legacySignUp(makeClient(), name, `Участник ${i}`);
  bulk.push(name);
}
r = await n('/chats', { method: 'POST', body: JSON.stringify({ title: 'Ровно двадцать', members: [userO, userP, ...bulk] }) });
check('чат ровно на 20 участников создан', r.status === 201 && r.body.chat?.memberCount === 20, `${r.status} ${JSON.stringify(r.body.chat?.memberCount ?? r.body)}`);
const fullChat = r.body.chat?.id;
r = await n(`/chats/${fullChat}/members`, { method: 'POST', body: JSON.stringify({ username: userD }) });
check('21-й участник отклонён', r.status === 400 && r.body.error?.includes('20'), `${r.status} ${JSON.stringify(r.body)}`);

r = await n(`/chats/${chatId}/members/${userN}`, { method: 'DELETE' });
check('владелец вышел сам', r.status === 200 && r.body.left === true, JSON.stringify(r.body));
r = await n(`/chats/${chatId}`);
check('вышедший владелец потерял доступ', r.status === 404, `${r.status}`);
r = await o(`/chats/${chatId}`);
check('владение перешло участнику с самым ранним joined_at',
  r.status === 200 && r.body.chat?.iAmOwner === true && r.body.chat?.memberCount === 2, `${r.status} ${JSON.stringify(r.body.chat)}`);
r = await p(`/chats/${chatId}`);
check('второй оставшийся владельцем не стал', r.body.chat?.iAmOwner === false, JSON.stringify(r.body.chat?.iAmOwner));
r = await p(`/chats/${chatId}/members/${userP}`, { method: 'DELETE' });
check('участник вышел сам', r.status === 200 && r.body.left === true, JSON.stringify(r.body));
r = await p(`/chats/${chatId}`);
check('вышедший участник потерял доступ', r.status === 404, `${r.status}`);
r = await o(`/chats/${chatId}/members/${userO}`, { method: 'DELETE' });
check('последний участник вышел', r.status === 200 && r.body.left === true, JSON.stringify(r.body));
r = await o(`/chats/${chatId}`);
check('чат без участников удалён', r.status === 404, `${r.status}`);

r = await n(`/chats/${pairChat}`, { method: 'DELETE' });
check('удалить чат может только владелец (403)', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
r = await p(`/chats/${pairChat}`, { method: 'DELETE' });
check('владелец удалил чат', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
r = await p(`/chats/${pairChat}`);
check('удалённый чат больше не открывается', r.status === 404, `${r.status}`);
r = await n('/notifications');
check('события об удалённом чате ушли вместе с ним',
  !r.body.notifications.some(x => x.chat?.id === pairChat), JSON.stringify(r.body.notifications.filter(x => x.chat).map(x => x.chat.id)));

/* ═══════════════════════════════════════════════════════════════════════════
 * Этап 1: поиск по записям, архив по датам, закладки.
 *
 * Секции работают на своих аккаунтах и на клиенте `guest` (см. предупреждение
 * выше: `anon` к этому моменту уже вошёл, и брать его для проверок 401 нельзя).
 *
 * Запросы к поиску и к ленте всегда сужены либо меткой MARK/SER, либо именем
 * автора: обе строки содержат `stamp`, поэтому прогон не видит записей
 * предыдущих прогонов, оставшихся в той же базе.
 * ═══════════════════════════════════════════════════════════════════════════ */

// Даты записей через API не выставить — created_at ставит сервер. Архив без
// разных месяцев проверять нечем, поэтому даты правятся прямым UPDATE в той же
// базе, что видит сервер (тем же способом, что и токен сброса пароля выше).
// Без DB_PATH секция бессмысленна, и молчать об этом хуже, чем остановиться.
if (!process.env.DB_PATH) {
  console.log('\n  ОСТАНОВ: секциям этапа 1 нужен DB_PATH — тот же файл базы, что у сервера.');
  console.log('  Пример: $env:API_URL="http://127.0.0.1:3099"; $env:DB_PATH="$env:TEMP\\smoke.db"; npm run test:smoke');
  process.exit(1);
}

function setCreatedAt(postId, iso) {
  const wdb = new DatabaseSync(process.env.DB_PATH);
  try {
    wdb.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(iso, postId);
  } finally {
    wdb.close();
  }
}

const fed = makeClient();   // Фёдор — автор записей для поиска
const gal = makeClient();   // Галина — второй автор, её записи листаются страницами
const igr = makeClient();   // Игорь — третье лицо: чужие блокировки его не касаются
const mil = makeClient();   // Мила — автор архива, у её записей выставлены даты
const nul = makeClient();   // Нора — человек без единой записи

const userF = `fedor_${stamp}`;
const userG = `galina_${stamp}`;
const userI = `igor_${stamp}`;
const userM = `mila_${stamp}`;
const userNo = `nora_${stamp}`;

// Метка прогона: слово, которого нет ни в одной чужой записи. Кириллица и
// цифры для токенизатора unicode61 — один терм, разбиения не будет.
const MARK = `мтк${stamp}`;
const SER = `сер${stamp}`;

const post = async (client, body) => (await client('/posts', { method: 'POST', body: JSON.stringify({ body }) })).body.post.id;
const findQ = (client, q, extra = '') => client(`/search/posts?q=${encodeURIComponent(q)}${extra}`);
const idsOf = (res) => (res.body.posts ?? []).map((x) => x.id);
const hasId = (res, id) => idsOf(res).includes(id);
const sorted = (arr) => [...arr].sort((x, y) => x - y);

console.log('\n— поиск по записям —');
r = await signUp(fed, userF, 'Фёдор');
check('Фёдор зарегистрирован', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));
r = await signUp(gal, userG, 'Галина');
check('Галина зарегистрирована', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));
r = await signUp(igr, userI, 'Игорь');
check('Игорь зарегистрирован', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));

const pFilm = await post(fed, `Плёнка и проявка, ${MARK}`);
const pFilm2 = await post(fed, `Отдал плёнку в проявку вчера, ${MARK}`);
const pBoris = await post(fed, `Борис поехал в Бишкек, ${MARK}`);
const pGal = await post(gal, `Борис прислал открытку, ${MARK}`);

r = await findQ(fed, MARK);
check('поиск по метке находит все четыре записи прогона',
  r.status === 200 && idsOf(r).length === 4 && [pFilm, pFilm2, pBoris, pGal].every((id) => hasId(r, id)),
  `${r.status} ${JSON.stringify(idsOf(r))}`);
check('порядок — новые сверху (p.id DESC)',
  idsOf(r).every((id, i, arr) => i === 0 || arr[i - 1] > id), JSON.stringify(idsOf(r)));

r = await findQ(fed, `борис ${MARK}`);
const borisIds = sorted(idsOf(r));
check('нижний регистр находит «Борис»', borisIds.length === 2 && borisIds[0] === pBoris && borisIds[1] === pGal, JSON.stringify(borisIds));
r = await findQ(fed, `БОРИС ${MARK}`);
check('верхний регистр даёт тот же результат', JSON.stringify(sorted(idsOf(r))) === JSON.stringify(borisIds), JSON.stringify(idsOf(r)));
r = await findQ(fed, `Борис ${MARK}`);
check('смешанный регистр даёт тот же результат', JSON.stringify(sorted(idsOf(r))) === JSON.stringify(borisIds), JSON.stringify(idsOf(r)));

r = await findQ(fed, `пленк ${MARK}`);
check('«пленк» находит «Плёнка» и «плёнку» — ё свёрнуто', idsOf(r).length === 2 && hasId(r, pFilm) && hasId(r, pFilm2), JSON.stringify(idsOf(r)));
r = await findQ(fed, `плёнк ${MARK}`);
check('«плёнк» даёт ровно то же', idsOf(r).length === 2 && hasId(r, pFilm) && hasId(r, pFilm2), JSON.stringify(idsOf(r)));
r = await findQ(fed, `ПЛЁНК ${MARK}`);
check('«ПЛЁНК» даёт ровно то же', idsOf(r).length === 2 && hasId(r, pFilm) && hasId(r, pFilm2), JSON.stringify(idsOf(r)));

r = await findQ(fed, `проявк ${MARK}`);
check('префикс «проявк» находит «проявка» и «проявку»', idsOf(r).length === 2 && hasId(r, pFilm) && hasId(r, pFilm2), JSON.stringify(idsOf(r)));
// Цена отказа от стеммера, названная в отчёте BE-03: ищется начало слова, а не
// словоформа. «пленка» — не префикс слова «плёнку», поэтому находится только
// первая запись. Это договорённость, а не поломка, и она закреплена здесь.
r = await findQ(fed, `пленка ${MARK}`);
check('«пленка» не находит «плёнку» — поиск префиксный', idsOf(r).length === 1 && hasId(r, pFilm), JSON.stringify(idsOf(r)));
check('в найденном тексте осталось оригинальное «ё»', r.body.posts[0].body.includes('Плёнка'), r.body.posts[0].body);
r = await findQ(fed, `пленках ${MARK}`);
check('слово длиннее записанного не находит ничего', idsOf(r).length === 0, JSON.stringify(idsOf(r)));

r = await findQ(fed, `борис бишкек ${MARK}`);
check('два терма — это И: найдена только запись с обоими', idsOf(r).length === 1 && hasId(r, pBoris), JSON.stringify(idsOf(r)));
r = await findQ(fed, `борис пленк ${MARK}`);
check('слова из разных записей не складываются в ИЛИ', idsOf(r).length === 0, JSON.stringify(idsOf(r)));

r = await findQ(fed, `бишкек ${MARK}`);
check('ключи ответа ровно posts/nextCursor/query',
  JSON.stringify(Object.keys(r.body).sort()) === '["nextCursor","posts","query"]', JSON.stringify(Object.keys(r.body)));
check('query возвращает то, по чему искали', r.body.query === `бишкек ${MARK}`, JSON.stringify(r.body.query));
check('nextCursor на короткой выдаче — null', r.body.nextCursor === null, JSON.stringify(r.body.nextCursor));
const foundPost = r.body.posts[0] ?? {};
check('форма поста совпадает с лентой',
  ['id', 'body', 'createdAt', 'likeCount', 'commentCount', 'likedByMe', 'bookmarkedByMe', 'author'].every((k) => k in foundPost),
  JSON.stringify(Object.keys(foundPost)));
check('сниппет сервером не отдаётся', !('snippet' in foundPost), JSON.stringify(Object.keys(foundPost)));

r = await findQ(fed, 'я'.repeat(300));
check('слишком длинный запрос обрезан до 100 символов', r.status === 200 && r.body.query.length === 100, `${r.status} ${r.body.query?.length}`);

r = await findQ(fed, MARK, `&author=${userG}`);
check('author= сужает выдачу', idsOf(r).length === 1 && hasId(r, pGal), JSON.stringify(idsOf(r)));
r = await findQ(fed, MARK, `&author=${userG.toUpperCase()}`);
check('author= не чувствителен к регистру', idsOf(r).length === 1 && hasId(r, pGal), JSON.stringify(idsOf(r)));
r = await findQ(fed, MARK, `&author=net_takogo_${stamp}`);
check('несуществующий автор — пустой список, а не 404', r.status === 200 && idsOf(r).length === 0, `${r.status} ${JSON.stringify(idsOf(r))}`);

r = await findQ(guest, MARK);
check('гость может искать', r.status === 200 && idsOf(r).length === 4, `${r.status} ${JSON.stringify(idsOf(r))}`);
check('у гостя likedByMe false', r.body.posts.every((x) => x.likedByMe === false), JSON.stringify(r.body.posts.map((x) => x.likedByMe)));
check('у гостя bookmarkedByMe false', r.body.posts.every((x) => x.bookmarkedByMe === false), JSON.stringify(r.body.posts.map((x) => x.bookmarkedByMe)));

// Мусор в строке поиска — обычное состояние поля ввода, а не атака: запрос
// уходит на каждый символ. Ни один из них не имеет права дать 500 — сырой
// текст в MATCH не попадает, выражение собирает ftsQuery().
const junkQueries = ['"', 'a-b', '*', 'привет OR', 'NEAR(', '((', "'", '\\', '%', '{}[]', '^', 'AND', 'OR', 'NOT', '-борис', 'борис NEAR елка', 'борис*', '"незакрытая', '!!!', '***', '', '   ', ' '.repeat(500), 'борис '.repeat(60)];
for (const q of junkQueries) {
  r = await findQ(fed, q);
  check(`мусорный запрос ${JSON.stringify(q.length > 12 ? `${q.slice(0, 12)}…` : q)} → 200`,
    r.status === 200 && Array.isArray(r.body.posts), `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
}
r = await fed('/search/posts');
check('поиск без параметра q → 200 и пустой список', r.status === 200 && r.body.posts.length === 0, `${r.status} ${JSON.stringify(r.body)}`);
r = await fed(`/search/posts?q=${encodeURIComponent(MARK)}&q=${encodeURIComponent(MARK)}`);
check('повтор ?q= не роняет запрос', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);

r = await findQ(fed, MARK, '&cursor=abc');
check('мусорный курсор — первая страница', r.status === 200 && idsOf(r).length === 4, `${r.status} ${JSON.stringify(idsOf(r))}`);
r = await findQ(fed, MARK, '&cursor=-5');
check('отрицательный курсор — первая страница', r.status === 200 && idsOf(r).length === 4, `${r.status} ${JSON.stringify(idsOf(r))}`);
r = await findQ(fed, MARK, `&cursor=${pBoris}`);
check('курсор отдаёт строго более старые записи', idsOf(r).length === 2 && idsOf(r).every((id) => id < pBoris), JSON.stringify(idsOf(r)));

// 25 записей с общим словом: страница поиска — 20, как во всех лентах проекта.
// Эти же записи ниже листаются закладками.
const serPosts = [];
for (let i = 1; i <= 25; i++) serPosts.push(await post(gal, `Серия ${i}, ${SER}`));
r = await findQ(fed, SER);
const sPage1 = idsOf(r);
check('первая страница поиска — 20 записей', sPage1.length === 20, `${sPage1.length}`);
check('nextCursor первой страницы — id последней записи', r.body.nextCursor === sPage1.at(-1), `${r.body.nextCursor} vs ${sPage1.at(-1)}`);
r = await findQ(fed, SER, `&cursor=${r.body.nextCursor}`);
const sPage2 = idsOf(r);
check('вторая страница — оставшиеся 5', sPage2.length === 5, `${sPage2.length}`);
check('nextCursor второй страницы — null', r.body.nextCursor === null, JSON.stringify(r.body.nextCursor));
check('дублей между страницами нет', sPage2.every((id) => !sPage1.includes(id)), JSON.stringify(sPage2.filter((id) => sPage1.includes(id))));
check('две страницы покрывают все 25 записей',
  serPosts.every((id) => sPage1.includes(id) || sPage2.includes(id)), `${sPage1.length + sPage2.length}`);

r = await fed(`/users/${userG}/block`, { method: 'PUT' });
check('Фёдор заблокировал Галину', r.status === 200 && r.body.blockedByMe === true, JSON.stringify(r.body));
r = await findQ(fed, MARK);
check('поиск не показывает записи заблокированного', !hasId(r, pGal) && idsOf(r).length === 3, JSON.stringify(idsOf(r)));
r = await findQ(fed, MARK, `&author=${userG}`);
check('через author= блокировка не обходится', idsOf(r).length === 0, JSON.stringify(idsOf(r)));
r = await findQ(gal, MARK);
check('правило симметрично: заблокированная не находит записи блокирующего',
  idsOf(r).length === 1 && hasId(r, pGal), JSON.stringify(idsOf(r)));
r = await findQ(igr, MARK);
check('третье лицо по-прежнему находит все четыре', idsOf(r).length === 4, JSON.stringify(idsOf(r)));
r = await findQ(guest, MARK);
check('гостя чужая блокировка не касается', idsOf(r).length === 4, JSON.stringify(idsOf(r)));
r = await fed(`/users/${userG}/block`, { method: 'DELETE' });
check('блокировка снята', r.status === 200 && r.body.blockedByMe === false, JSON.stringify(r.body));
r = await findQ(fed, MARK);
check('записи вернулись в выдачу', idsOf(r).length === 4 && hasId(r, pGal), JSON.stringify(idsOf(r)));

const pFresh = await post(fed, `Свежая запись про негатив, ${MARK}`);
r = await findQ(fed, `негатив ${MARK}`);
check('новая запись ищется сразу — триггер INSERT', idsOf(r).length === 1 && hasId(r, pFresh), JSON.stringify(idsOf(r)));
await fed(`/posts/${pFresh}`, { method: 'DELETE' });
r = await findQ(fed, `негатив ${MARK}`);
check('удалённая запись сразу уходит из индекса — триггер DELETE', idsOf(r).length === 0, JSON.stringify(idsOf(r)));

console.log('\n— архив по датам —');
r = await signUp(mil, userM, 'Мила');
check('Мила зарегистрирована', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));
r = await signUp(nul, userNo, 'Нора');
check('Нора зарегистрирована', r.status === 200 && Boolean(r.body.user), JSON.stringify(r.body));

// Раскладка: 3 записи в мае 2026, 1 в ноябре 2025, 2 в марте 2024.
const archPlan = [
  ['2026-05-07T09:00:00.000Z', 'Май, первая'],
  ['2026-05-08T09:00:00.000Z', 'Май, вторая'],
  ['2026-05-09T09:00:00.000Z', 'Май, третья'],
  ['2025-11-02T09:00:00.000Z', 'Ноябрь, единственная'],
  ['2024-03-05T09:00:00.000Z', 'Март, первая'],
  ['2024-03-20T09:00:00.000Z', 'Март, вторая'],
];
const archIds = [];
for (const [iso, text] of archPlan) {
  const id = await post(mil, `${text}, ${MARK}`);
  setCreatedAt(id, iso);
  archIds.push(id);
}
r = await mil(`/posts?author=${userM}&period=2026-05`);
check('прямой UPDATE дат виден серверу', r.body.posts.length === 3, JSON.stringify(r.body.posts.map((x) => x.createdAt)));

r = await mil(`/users/${userM}/archive`);
check('архив 200', r.status === 200, `${r.status}`);
check('ключи ответа ровно months/total', JSON.stringify(Object.keys(r.body).sort()) === '["months","total"]', JSON.stringify(Object.keys(r.body)));
const months = r.body.months ?? [];
check('в архиве три непустых месяца', months.length === 3, JSON.stringify(months));
check('месяцы новые сверху', months.map((m) => m.month).join(',') === '2026-05,2025-11,2024-03', JSON.stringify(months.map((m) => m.month)));
check('числа по месяцам верные', months.map((m) => m.count).join(',') === '3,1,2', JSON.stringify(months.map((m) => m.count)));
check('пустых месяцев в списке нет', months.every((m) => m.count > 0), JSON.stringify(months));
check('total равен сумме count', r.body.total === months.reduce((s, m) => s + m.count, 0) && r.body.total === 6, `${r.body.total}`);
r = await mil(`/users/${userM}`);
check('total совпадает с postCount профиля', r.body.user?.postCount === 6, `${r.body.user?.postCount}`);

// Главная проверка архива: число в панели обязано совпасть с тем, что реально
// откроется по клику. «В мае 3 записи» над пустой лентой — самый заметный
// способ сломать доверие к экрану.
for (const m of months) {
  r = await mil(`/posts?author=${userM}&period=${m.month}`);
  check(`месяц ${m.month}: лента отдаёт ровно ${m.count} записей`, r.body.posts.length === m.count, `${r.body.posts.length}`);
  check(`месяц ${m.month}: все записи из этого месяца`,
    r.body.posts.every((x) => x.createdAt.startsWith(m.month)), JSON.stringify(r.body.posts.map((x) => x.createdAt)));
}

r = await mil(`/posts?author=${userM}&period=2026`);
check('период-год 2026 → 3 записи', r.body.posts.length === 3, `${r.body.posts.length}`);
r = await mil(`/posts?author=${userM}&period=2024`);
check('период-год 2024 → 2 записи', r.body.posts.length === 2, `${r.body.posts.length}`);
r = await mil(`/posts?author=${userM}&period=2030`);
check('год без записей → пустая лента, а не ошибка', r.status === 200 && r.body.posts.length === 0, `${r.status}`);
r = await mil(`/posts?author=${userM}`);
check('без периода видны все шесть', r.body.posts.length === 6, `${r.body.posts.length}`);
r = await mil(`/posts?author=${userM}&period=`);
check('пустой ?period= — снятый фильтр, а не 400', r.status === 200 && r.body.posts.length === 6, `${r.status} ${r.body.posts?.length}`);
r = await mil('/posts?period=2024-03');
check('период работает и без author', r.body.posts.filter((x) => archIds.includes(x.id)).length === 2, JSON.stringify(r.body.posts.map((x) => x.id)));
r = await mil(`/posts?author=${userM}&period=2026-05&cursor=${archIds[1]}`);
check('период работает вместе с курсором', r.body.posts.length === 1 && r.body.posts[0].id === archIds[0], JSON.stringify(r.body.posts.map((x) => x.id)));
r = await igr(`/users/${userM}/follow`, { method: 'PUT' });
check('Игорь подписался на Милу', r.status === 200 && r.body.followedByMe === true, JSON.stringify(r.body));
r = await igr('/posts?feed=following&period=2026-05');
check('период работает вместе с feed=following', r.body.posts.length === 3, JSON.stringify(r.body.posts.map((x) => x.id)));
r = await guest('/posts?feed=following&period=2026-05');
check('feed=following гостю по-прежнему 401', r.status === 401, `${r.status}`);
r = await guest(`/posts?author=${userM}&period=2026-05`);
check('период доступен гостю', r.status === 200 && r.body.posts.length === 3, `${r.status}`);

const badPeriods = ['13', 'abc', '2026-13', '2026-00', '2026-1', '20261', '2026-', '-2026', '2026-09-11', "'", 'null', '2026 OR 1=1', '202', '26-05', '2026/05'];
for (const bad of badPeriods) {
  r = await mil(`/posts?author=${userM}&period=${encodeURIComponent(bad)}`);
  check(`период «${bad}» → 400`, r.status === 400 && r.body.error === 'Некорректный период', `${r.status} ${JSON.stringify(r.body)}`);
}
// Пробелы по краям — след копирования из адресной строки, а не мусор: период
// обрезается и работает. Проверяется здесь, чтобы правка регулярки не сделала
// из этого случая 400 незаметно.
r = await mil(`/posts?author=${userM}&period=${encodeURIComponent(' 2026-05 ')}`);
check('период с пробелами по краям обрезается, а не отвергается', r.status === 200 && r.body.posts.length === 3, `${r.status} ${r.body.posts?.length}`);

r = await guest(`/users/${userM}/archive`);
check('архив доступен гостю', r.status === 200 && r.body.total === 6, `${r.status} ${r.body.total}`);
r = await fed(`/users/${userM.toUpperCase()}/archive`);
check('имя в архиве не чувствительно к регистру', r.status === 200 && r.body.total === 6, `${r.status} ${r.body.total}`);
r = await fed(`/users/net_takogo_${stamp}/archive`);
check('архив несуществующего = 404', r.status === 404, `${r.status}`);
check('текст ошибки тот же, что у профиля', r.body.error === 'Пользователь не найден', JSON.stringify(r.body));
r = await nul(`/users/${userNo}/archive`);
check('у автора без записей архив пуст', r.status === 200 && r.body.months.length === 0 && r.body.total === 0, JSON.stringify(r.body));
r = await mil('/users/me/archive');
check('служебное имя «me» архивом не перехвачено', r.status === 404, `${r.status}`);

const pIgr = await post(igr, `Запись Игоря, ${MARK}`);
check('у Игоря появилась своя запись', Number.isInteger(pIgr), `${pIgr}`);
r = await igr(`/users/${userM}/block`, { method: 'PUT' });
check('Игорь заблокировал Милу', r.status === 200 && r.body.blockedByMe === true, JSON.stringify(r.body));
r = await igr(`/users/${userM}/archive`);
check('архив заблокированного пуст', r.body.months.length === 0 && r.body.total === 0, JSON.stringify(r.body));
r = await igr(`/users/${userM}`);
check('postCount там же обнулился — числа сходятся', r.body.user?.postCount === 0, `${r.body.user?.postCount}`);
r = await mil(`/users/${userI}/archive`);
check('правило симметрично: архив блокирующего пуст с другой стороны', r.body.total === 0, JSON.stringify(r.body));
r = await igr(`/posts?author=${userM}&period=2026-05`);
check('лента по периоду у заблокированного пуста', r.body.posts.length === 0, JSON.stringify(r.body.posts.map((x) => x.id)));
r = await findQ(igr, `май ${MARK}`);
check('через поиск блокировка тоже не обходится', idsOf(r).length === 0, JSON.stringify(idsOf(r)));
r = await fed(`/users/${userM}/archive`);
check('третье лицо видит архив целиком', r.body.total === 6, JSON.stringify(r.body));
r = await guest(`/users/${userM}/archive`);
check('гостя чужая блокировка не касается', r.body.total === 6, JSON.stringify(r.body));
r = await igr(`/users/${userM}/block`, { method: 'DELETE' });
check('блокировка снята', r.status === 200 && r.body.blockedByMe === false, JSON.stringify(r.body));
r = await igr(`/users/${userM}/archive`);
check('архив вернулся полностью', r.body.total === 6 && r.body.months.length === 3, JSON.stringify(r.body));
r = await mil(`/users/${userI}/archive`);
check('и с другой стороны тоже', r.body.total === 1 && r.body.months[0]?.count === 1, JSON.stringify(r.body));

console.log('\n— закладки —');
r = await guest(`/posts/${pGal}/bookmark`, { method: 'PUT' });
check('сохранить запись без входа нельзя (401)', r.status === 401, `${r.status}`);
r = await guest(`/posts/${pGal}/bookmark`, { method: 'DELETE' });
check('снять закладку без входа нельзя (401)', r.status === 401, `${r.status}`);
r = await guest('/bookmarks');
check('список закладок требует входа (401)', r.status === 401, `${r.status}`);

r = await fed(`/posts/${pGal}/bookmark`, { method: 'PUT' });
check('запись сохранена', r.status === 200 && r.body.bookmarkedByMe === true, `${r.status} ${JSON.stringify(r.body)}`);
r = await fed(`/posts/${pGal}/bookmark`, { method: 'PUT' });
check('повторное сохранение идемпотентно', r.status === 200 && r.body.bookmarkedByMe === true, `${r.status} ${JSON.stringify(r.body)}`);
r = await fed('/bookmarks');
check('ключи списка ровно posts/nextCursor', JSON.stringify(Object.keys(r.body).sort()) === '["nextCursor","posts"]', JSON.stringify(Object.keys(r.body)));
check('сохранённая запись в списке', idsOf(r).length === 1 && hasId(r, pGal), JSON.stringify(idsOf(r)));
check('в списке закладок bookmarkedByMe = true', r.body.posts[0]?.bookmarkedByMe === true, JSON.stringify(r.body.posts[0]?.bookmarkedByMe));
check('id закладки наружу не течёт', !('bookmarkId' in (r.body.posts[0] ?? {})) && !('bookmark_id' in (r.body.posts[0] ?? {})), JSON.stringify(Object.keys(r.body.posts[0] ?? {})));

r = await fed('/posts');
check('поле bookmarkedByMe есть у каждой записи общей ленты',
  r.body.posts.length > 0 && r.body.posts.every((x) => typeof x.bookmarkedByMe === 'boolean'),
  JSON.stringify(r.body.posts.map((x) => x.bookmarkedByMe).slice(0, 5)));
// Сохранённая запись — самая старая у Галины и на первую страницу общей ленты
// уже не попадает, поэтому лента профиля с курсором, а не `/posts` без фильтров.
r = await fed(`/posts?author=${userG}&cursor=${serPosts[0]}`);
check('bookmarkedByMe = true у сохранённой записи в ленте', r.body.posts.find((x) => x.id === pGal)?.bookmarkedByMe === true, JSON.stringify(r.body.posts.map((x) => [x.id, x.bookmarkedByMe])));
r = await fed(`/posts?author=${userF}`);
check('у несохранённых записей в ленте флаг false', r.body.posts.find((x) => x.id === pBoris)?.bookmarkedByMe === false, JSON.stringify(r.body.posts.map((x) => [x.id, x.bookmarkedByMe])));
r = await fed(`/posts/${pGal}`);
check('bookmarkedByMe приходит в одиночной записи', r.body.post?.bookmarkedByMe === true, JSON.stringify(r.body.post?.bookmarkedByMe));
r = await findQ(fed, MARK);
check('bookmarkedByMe приходит в поиске', r.body.posts.find((x) => x.id === pGal)?.bookmarkedByMe === true, JSON.stringify(idsOf(r)));
r = await mil(`/posts?author=${userM}&period=2026-05`);
check('bookmarkedByMe приходит и в ленте по периоду',
  r.body.posts.length === 3 && r.body.posts.every((x) => x.bookmarkedByMe === false),
  JSON.stringify(r.body.posts.map((x) => x.bookmarkedByMe)));
r = await gal(`/posts/${pGal}`);
check('автор чужую закладку на своей записи не видит', r.body.post?.bookmarkedByMe === false, JSON.stringify(r.body.post?.bookmarkedByMe));
r = await igr(`/posts/${pGal}`);
check('третье лицо чужую закладку не видит', r.body.post?.bookmarkedByMe === false, JSON.stringify(r.body.post?.bookmarkedByMe));
r = await guest(`/posts/${pGal}`);
check('у гостя bookmarkedByMe = false', r.body.post?.bookmarkedByMe === false, JSON.stringify(r.body.post?.bookmarkedByMe));
r = await gal('/bookmarks');
check('чужие закладки в свой список не попадают', idsOf(r).length === 0, JSON.stringify(idsOf(r)));
r = await gal('/notifications');
check('о закладке автору не сообщают', !JSON.stringify(r.body).includes('bookmark'), JSON.stringify(r.body).slice(0, 120));

for (const bad of ['0', 'abc', '-5']) {
  r = await fed(`/posts/${bad}/bookmark`, { method: 'PUT' });
  check(`PUT с id «${bad}» → 400`, r.status === 400 && r.body.error === 'Некорректный id', `${r.status} ${JSON.stringify(r.body)}`);
  r = await fed(`/posts/${bad}/bookmark`, { method: 'DELETE' });
  check(`DELETE с id «${bad}» → 400`, r.status === 400 && r.body.error === 'Некорректный id', `${r.status} ${JSON.stringify(r.body)}`);
}
r = await fed('/posts/99999999/bookmark', { method: 'PUT' });
check('PUT на несуществующую запись → 404', r.status === 404 && r.body.error === 'Пост не найден', `${r.status} ${JSON.stringify(r.body)}`);
r = await fed('/posts/99999999/bookmark', { method: 'DELETE' });
check('DELETE на несуществующую запись → 404', r.status === 404 && r.body.error === 'Пост не найден', `${r.status} ${JSON.stringify(r.body)}`);

// Порядок «недавно сохранённые сверху» держится на id закладки, а не на id
// записи: сохранённая последней старая запись обязана оказаться первой.
r = await fed(`/posts/${pFilm}/bookmark`, { method: 'PUT' });
check('старая запись сохранена последней', r.status === 200, `${r.status}`);
r = await fed('/bookmarks');
check('последняя сохранённая — сверху, хотя запись самая старая', idsOf(r)[0] === pFilm && idsOf(r)[1] === pGal, JSON.stringify(idsOf(r)));
r = await fed(`/posts/${pGal}/bookmark`, { method: 'PUT' });
check('повторный PUT прошёл', r.status === 200, `${r.status}`);
r = await fed('/bookmarks');
check('повтор не поднимает запись наверх — id закладки не менялся', idsOf(r)[0] === pFilm && idsOf(r)[1] === pGal, JSON.stringify(idsOf(r)));

r = await fed(`/posts/${pGal}/bookmark`, { method: 'DELETE' });
check('закладка снята', r.status === 200 && r.body.bookmarkedByMe === false, `${r.status} ${JSON.stringify(r.body)}`);
r = await fed(`/posts/${pGal}/bookmark`, { method: 'DELETE' });
check('повторное снятие — не ошибка', r.status === 200 && r.body.bookmarkedByMe === false, `${r.status} ${JSON.stringify(r.body)}`);
r = await fed('/bookmarks');
check('снятая закладка ушла из списка', !hasId(r, pGal) && idsOf(r).length === 1, JSON.stringify(idsOf(r)));
r = await fed(`/posts/${pGal}`);
check('флаг в ленте вернулся в false', r.body.post?.bookmarkedByMe === false, JSON.stringify(r.body.post?.bookmarkedByMe));

r = await fed(`/posts/${pBoris}/bookmark`, { method: 'PUT' });
check('закладка на свою запись разрешена', r.status === 200 && r.body.bookmarkedByMe === true, `${r.status} ${JSON.stringify(r.body)}`);
r = await fed('/bookmarks');
check('своя запись видна в своём списке', hasId(r, pBoris), JSON.stringify(idsOf(r)));

const pDoomed = await post(fed, `Запись под снос, ${MARK}`);
await fed(`/posts/${pDoomed}/bookmark`, { method: 'PUT' });
r = await fed('/bookmarks');
check('запись под снос сохранена', hasId(r, pDoomed), JSON.stringify(idsOf(r)));
await fed(`/posts/${pDoomed}`, { method: 'DELETE' });
r = await fed('/bookmarks');
check('удаление записи уносит закладку (каскад)', !hasId(r, pDoomed), JSON.stringify(idsOf(r)));
check('остальные закладки на месте', idsOf(r).length === 2, JSON.stringify(idsOf(r)));

// Игорь листает страницами: его список — ровно 25 записей серии и ничего больше.
for (const id of serPosts) await igr(`/posts/${id}/bookmark`, { method: 'PUT' });
r = await igr('/bookmarks');
const bPage1 = idsOf(r);
check('первая страница закладок — 20 записей', bPage1.length === 20, `${bPage1.length}`);
check('сверху — сохранённая последней', bPage1[0] === serPosts.at(-1), `${bPage1[0]} vs ${serPosts.at(-1)}`);
const bCursor = r.body.nextCursor;
check('nextCursor списка — id закладки, а не записи', bCursor !== null && bCursor !== bPage1.at(-1), `${bCursor} vs ${bPage1.at(-1)}`);
r = await igr(`/bookmarks?cursor=${bCursor}`);
const bPage2 = idsOf(r);
check('вторая страница — оставшиеся 5', bPage2.length === 5, `${bPage2.length}`);
check('nextCursor второй страницы — null', r.body.nextCursor === null, JSON.stringify(r.body.nextCursor));
check('дублей между страницами нет', bPage2.every((id) => !bPage1.includes(id)), JSON.stringify(bPage2.filter((id) => bPage1.includes(id))));
check('две страницы покрывают все 25 закладок',
  serPosts.every((id) => bPage1.includes(id) || bPage2.includes(id)), `${bPage1.length + bPage2.length}`);
check('порядок обратен порядку сохранения',
  JSON.stringify([...bPage1, ...bPage2]) === JSON.stringify([...serPosts].reverse()), JSON.stringify([...bPage1, ...bPage2].slice(0, 5)));
r = await igr('/bookmarks?cursor=abc');
check('мусорный курсор списка — первая страница', r.status === 200 && idsOf(r).length === 20, `${r.status} ${idsOf(r).length}`);
r = await igr('/bookmarks?cursor=-5');
check('отрицательный курсор списка — первая страница', r.status === 200 && idsOf(r).length === 20, `${r.status} ${idsOf(r).length}`);

r = await igr(`/users/${userG}/block`, { method: 'PUT' });
check('Игорь заблокировал автора сохранённых записей', r.status === 200 && r.body.blockedByMe === true, JSON.stringify(r.body));
r = await igr('/bookmarks');
check('записи заблокированного пропали из списка', idsOf(r).length === 0, JSON.stringify(idsOf(r)));
r = await igr(`/posts/${serPosts[0]}/bookmark`, { method: 'PUT' });
check('сохранить скрытую блокировкой запись нельзя (404)', r.status === 404 && r.body.error === 'Пост не найден', `${r.status} ${JSON.stringify(r.body)}`);
// Осознанное исключение BE-03: снять закладку можно и со скрытой записи —
// иначе сохранённое до блокировки застряло бы в списке навсегда.
r = await igr(`/posts/${serPosts[0]}/bookmark`, { method: 'DELETE' });
check('снять закладку со скрытой записи можно (200)', r.status === 200 && r.body.bookmarkedByMe === false, `${r.status} ${JSON.stringify(r.body)}`);
r = await igr(`/users/${userG}/block`, { method: 'DELETE' });
check('блокировка снята', r.status === 200 && r.body.blockedByMe === false, JSON.stringify(r.body));
r = await igr('/bookmarks');
const bBack = idsOf(r).concat(idsOf(await igr(`/bookmarks?cursor=${r.body.nextCursor}`)));
check('закладки вернулись — строки пережили блокировку', bBack.length === 24, `${bBack.length}`);
check('снятая во время блокировки не воскресла', !bBack.includes(serPosts[0]), JSON.stringify(bBack.slice(-3)));
r = await gal('/bookmarks');
check('у автора записей чужие закладки по-прежнему не видны', idsOf(r).length === 0, JSON.stringify(idsOf(r)));

console.log('\n— в сети и галочки прочтения —');
const vera = makeClient();
const yan = makeClient();
const userV = `vera_${stamp}`;
const userY = `yan_${stamp}`;
await legacySignUp(vera, userV, 'Вера');
await legacySignUp(yan, userY, 'Ян');

// Свежесть: запрос с сессией только что прошёл, значит «был в сети» — секунды
// назад. Пять минут — запас на медленную машину, а не допуск логики.
const fresh = (iso) => typeof iso === 'string' && Date.now() - Date.parse(iso) < 5 * 60_000;

await vera(`/messages/${userY}`, { method: 'POST', body: JSON.stringify({ body: 'Ян, привет!' }) });
r = await yan(`/messages/${userV}`);
check('в переписке есть время визита собеседника', fresh(r.body.user?.lastSeenAt), JSON.stringify(r.body.user));
r = await yan('/messages');
check('и в списке диалогов тоже', fresh(r.body.conversations?.[0]?.user?.lastSeenAt), JSON.stringify(r.body.conversations?.[0]?.user));
// `guest`, а не `anon`: тот к этому месту уже входил в аккаунт в проверках
// сброса пароля и анонимом больше не является (см. README, «Тесты»).
r = await guest(`/messages/${userV}`);
check('аноним время визита не получает (401)', r.status === 401, `${r.status}`);

r = await yan(`/users/${userV}/block`, { method: 'PUT' });
check('Ян заблокировал Веру', r.status === 200, JSON.stringify(r.body));
r = await vera(`/messages/${userY}`);
check('заблокированная не видит, когда Ян был в сети', r.body.user && r.body.user.lastSeenAt === null, JSON.stringify(r.body.user));
r = await yan(`/messages/${userV}`);
check('и заблокировавший не видит — правило симметрично', r.body.user && r.body.user.lastSeenAt === null, JSON.stringify(r.body.user));
r = await yan('/messages');
check('в списке диалогов при блокировке тоже пусто', r.body.conversations?.[0]?.user?.lastSeenAt === null, JSON.stringify(r.body.conversations?.[0]?.user));
await yan(`/users/${userV}/block`, { method: 'DELETE' });
r = await vera(`/messages/${userY}`);
check('после разблокировки время визита вернулось', fresh(r.body.user?.lastSeenAt), JSON.stringify(r.body.user));

r = await vera('/chats', { method: 'POST', body: JSON.stringify({ title: 'Галочки', members: [userY] }) });
check('чат для галочек создан', r.status === 201, JSON.stringify(r.body));
const tickChat = r.body.chat.id;
r = await vera(`/chats/${tickChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Кто прочитал?' }) });
const tickMsg = r.body.message.id;
r = await vera(`/chats/${tickChat}/messages`);
check('пока никто не прочитал — readUpTo ниже сообщения', typeof r.body.readUpTo === 'number' && r.body.readUpTo < tickMsg, JSON.stringify(r.body.readUpTo));
check('у участников есть время визита', r.body.chat?.members?.every((m) => fresh(m.lastSeenAt)), JSON.stringify(r.body.chat?.members));
await yan(`/chats/${tickChat}/read`, { method: 'PUT' });
r = await vera(`/chats/${tickChat}/messages`);
check('после прочтения Яном — readUpTo дошёл до сообщения', r.body.readUpTo >= tickMsg, `${r.body.readUpTo} vs ${tickMsg}`);
r = await vera('/chats');
const tickSummary = r.body.chats?.find((ch) => ch.id === tickChat);
check('readUpTo есть и в списке чатов', tickSummary?.readUpTo >= tickMsg, JSON.stringify(tickSummary?.readUpTo));
// Своя ватерлиния в readUpTo не входит: иначе своё сообщение считалось бы
// прочитанным сразу после отправки, ведь автор его, разумеется, видел.
r = await yan(`/chats/${tickChat}/messages`);
check('у Яна своя ватерлиния не считается чужим прочтением', r.body.readUpTo < tickMsg, `${r.body.readUpTo} vs ${tickMsg}`);

await yan(`/users/${userV}/block`, { method: 'PUT' });
r = await yan(`/chats/${tickChat}/messages`);
const veraInChat = r.body.chat?.members?.find((m) => m.username === userV);
check('в чате при блокировке время визита скрыто', veraInChat && veraInChat.lastSeenAt === null, JSON.stringify(veraInChat));
await yan(`/users/${userV}/block`, { method: 'DELETE' });

console.log('\n— действия с сообщениями —');
const kira = makeClient();
const lev = makeClient();
const mia = makeClient();
const userKi = `kira_${stamp}`;
const userLe = `lev_${stamp}`;
const userMi = `mia_${stamp}`;
await signUp(kira, userKi, 'Кира');
await signUp(lev, userLe, 'Лев');
await signUp(mia, userMi, 'Мия');

const dmSend = (client, to, payload) =>
  client(`/messages/${to}`, { method: 'POST', body: JSON.stringify(payload) });
const dmMsg = (res, id) => res.body.messages?.find((m) => m.id === id);

// Ответ с цитатой.
r = await dmSend(kira, userLe, { body: 'Лев, во сколько встречаемся? Я бы ближе к семи.' });
const km1 = r.body.message.id;
check('сообщение без ответа — replyTo: null, реакций нет', r.body.message.replyTo === null && r.body.message.reactions?.length === 0, JSON.stringify(r.body.message));
r = await dmSend(lev, userKi, { body: 'В семь отлично.', replyTo: km1 });
const lr1 = r.body.message?.id;
check('ответ на сообщение пары принят', r.status === 201 && r.body.message.replyTo?.id === km1, `${r.status} ${JSON.stringify(r.body)}`);
check('в цитате автор и начало текста', r.body.message.replyTo?.author?.displayName === 'Кира' && r.body.message.replyTo?.body.startsWith('Лев, во сколько'), JSON.stringify(r.body.message.replyTo));
r = await dmSend(lev, userKi, { body: 'чужое', replyTo: msg1 });
check('ответ на сообщение чужой пары — 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await dmSend(lev, userKi, { body: 'мусор', replyTo: 'abc' });
check('мусорный replyTo — 400', r.status === 400, `${r.status}`);
r = await lev(`/messages/${userKi}`);
check('цитата приходит и в переписке', dmMsg(r, lr1)?.replyTo?.id === km1, JSON.stringify(dmMsg(r, lr1)));

// Правка.
r = await lev(`/messages/${userKi}/${lr1}`, { method: 'PATCH', body: JSON.stringify({ body: 'В семь пятнадцать, если можно.' }) });
check('правка своего — 200 и пометка editedAt', r.status === 200 && r.body.message.body === 'В семь пятнадцать, если можно.' && typeof r.body.message.editedAt === 'string', `${r.status} ${JSON.stringify(r.body)}`);
check('правка не теряет цитату', r.body.message?.replyTo?.id === km1, JSON.stringify(r.body.message?.replyTo));
r = await kira(`/messages/${userLe}/${lr1}`, { method: 'PATCH', body: JSON.stringify({ body: 'подменил' }) });
check('чужое править нельзя — 403', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
r = await mia(`/messages/${userKi}/${lr1}`, { method: 'PATCH', body: JSON.stringify({ body: 'посторонний' }) });
check('посторонний не находит сообщение чужой пары — 404', r.status === 404, `${r.status}`);
r = await dmSend(kira, userLe, { body: 'Без изменений' });
const kSame = r.body.message.id;
r = await kira(`/messages/${userLe}/${kSame}`, { method: 'PATCH', body: JSON.stringify({ body: 'Без изменений' }) });
check('тот же текст — не правка, editedAt остаётся null', r.status === 200 && r.body.message.editedAt === null, JSON.stringify(r.body.message));
r = await kira(`/messages/${userLe}/${kSame}`, { method: 'PATCH', body: JSON.stringify({ body: '  ' }) });
check('пустая правка — 400', r.status === 400, `${r.status}`);
{
  const wdb = new DatabaseSync(process.env.DB_PATH);
  try {
    wdb.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 49 * 3600_000).toISOString(), kSame);
  } finally {
    wdb.close();
  }
}
r = await kira(`/messages/${userLe}/${kSame}`, { method: 'PATCH', body: JSON.stringify({ body: 'Через двое суток' }) });
check('правка старше 48 часов — 403', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);

// Реакции.
const react = (client, path, emoji) => client(`${path}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji }) });
r = await react(kira, `/messages/${userLe}/${lr1}`, '👍');
check('реакция поставлена', r.status === 200 && JSON.stringify(r.body.message.reactions) === JSON.stringify([{ emoji: '👍', count: 1, mine: true }]), `${r.status} ${JSON.stringify(r.body.message?.reactions)}`);
r = await react(lev, `/messages/${userKi}/${lr1}`, '❤️');
check('вторая реакция от другого — две строки', r.body.message?.reactions?.length === 2, JSON.stringify(r.body.message?.reactions));
r = await react(kira, `/messages/${userLe}/${lr1}`, '❤️');
check('новая реакция заменяет прежнюю — одна на человека', JSON.stringify(r.body.message?.reactions) === JSON.stringify([{ emoji: '❤️', count: 2, mine: true }]), JSON.stringify(r.body.message?.reactions));
r = await react(kira, `/messages/${userLe}/${lr1}`, '💩');
check('реакция не из набора — 400', r.status === 400, `${r.status}`);
r = await react(mia, `/messages/${userKi}/${lr1}`, '👍');
check('посторонний реагировать не может — 404', r.status === 404, `${r.status}`);
r = await kira(`/messages/${userLe}/${lr1}/reaction`, { method: 'DELETE' });
check('снять свою реакцию', r.status === 200 && JSON.stringify(r.body.message.reactions) === JSON.stringify([{ emoji: '❤️', count: 1, mine: false }]), JSON.stringify(r.body.message?.reactions));

// Удаление.
r = await dmSend(kira, userLe, { body: 'Это сообщение я удалю.' });
const kDel = r.body.message.id;
r = await dmSend(lev, userKi, { body: 'А я на него отвечу.', replyTo: kDel });
const lOnDel = r.body.message.id;
r = await lev(`/messages/${userKi}/${kDel}`, { method: 'DELETE' });
check('чужое удалить нельзя — 403', r.status === 403, `${r.status}`);
r = await kira(`/messages/${userLe}/${kDel}`, { method: 'DELETE' });
check('своё удалено', r.status === 200, `${r.status}`);
r = await lev(`/messages/${userKi}`);
check('у собеседника оно тоже пропало', !dmMsg(r, kDel), JSON.stringify(r.body.messages?.map((m) => m.id)));
check('ответ на удалённое остался и показывает «удалено»', dmMsg(r, lOnDel)?.replyTo?.deleted === true, JSON.stringify(dmMsg(r, lOnDel)));
r = await kira(`/messages/${userLe}/${kDel}`, { method: 'DELETE' });
check('повторное удаление — 404', r.status === 404, `${r.status}`);

// «Печатает…».
await kira(`/messages/${userLe}/typing`, { method: 'PUT' });
r = await lev(`/messages/${userKi}`);
check('собеседник видит «печатает…»', r.body.typing === true, JSON.stringify(r.body.typing));
r = await kira(`/messages/${userLe}`);
check('себя «печатающим» не видно', r.body.typing === false, JSON.stringify(r.body.typing));
await dmSend(kira, userLe, { body: 'Дописала.' });
r = await lev(`/messages/${userKi}`);
check('после отправки «печатает…» гаснет сразу', r.body.typing === false, JSON.stringify(r.body.typing));

// Блокировка.
await lev(`/users/${userKi}/block`, { method: 'PUT' });
r = await react(kira, `/messages/${userLe}/${lr1}`, '🔥');
check('при блокировке реакция — 403', r.status === 403, `${r.status}`);
r = await dmSend(kira, userLe, { body: 'Последнее до блокировки было раньше.' });
check('и отправка — 403', r.status === 403, `${r.status}`);
r = await kira(`/messages/${userLe}/typing`, { method: 'PUT' });
check('«печатает…» при блокировке отвечает как обычно', r.status === 200, `${r.status}`);
r = await lev(`/messages/${userKi}`);
check('но собеседник его не видит', r.body.typing === false, JSON.stringify(r.body.typing));
check('и реакций заблокированной не видно', dmMsg(r, lr1)?.reactions?.every((x) => x.mine), JSON.stringify(dmMsg(r, lr1)?.reactions));
r = await kira(`/messages/${userLe}/${km1}`, { method: 'DELETE' });
check('своё удалить можно и при блокировке', r.status === 200, `${r.status}`);
await lev(`/users/${userKi}/block`, { method: 'DELETE' });

// Групповой чат.
r = await kira('/chats', { method: 'POST', body: JSON.stringify({ title: 'Действия', members: [userLe, userMi] }) });
const actChat = r.body.chat.id;
const chatSend = (client, payload) =>
  client(`/chats/${actChat}/messages`, { method: 'POST', body: JSON.stringify(payload) });
r = await chatSend(lev, { body: 'Берём два термоса или один?' });
const lc1 = r.body.message.id;
r = await chatSend(mia, { body: 'Два, путь долгий.', replyTo: lc1 });
const mc1 = r.body.message?.id;
check('ответ в чате — цитата с автором', r.status === 201 && r.body.message.replyTo?.author?.displayName === 'Лев', `${r.status} ${JSON.stringify(r.body)}`);
r = await chatSend(mia, { body: 'мимо', replyTo: lr1 });
check('ответ на сообщение из ЛС в чате — 400', r.status === 400, `${r.status}`);
r = await mia(`/chats/${actChat}/messages/${lc1}`, { method: 'PATCH', body: JSON.stringify({ body: 'три' }) });
check('в чате чужое править нельзя — 403', r.status === 403, `${r.status}`);
r = await lev(`/chats/${actChat}/messages/${lc1}`, { method: 'PATCH', body: JSON.stringify({ body: 'Берём два термоса.' }) });
check('своё в чате правится', r.status === 200 && r.body.message.editedAt && r.body.message.body === 'Берём два термоса.', JSON.stringify(r.body.message));
r = await react(mia, `/chats/${actChat}/messages/${lc1}`, '🔥');
check('реакция в чате', r.status === 200 && r.body.message.reactions?.[0]?.emoji === '🔥', `${r.status} ${JSON.stringify(r.body)}`);
r = await lev(`/chats/${actChat}/messages`);
const levSees = r.body.messages?.find((m) => m.id === lc1);
check('другой участник видит её без отметки «моя»', JSON.stringify(levSees?.reactions) === JSON.stringify([{ emoji: '🔥', count: 1, mine: false }]), JSON.stringify(levSees?.reactions));
r = await mia(`/chats/${actChat}/messages/${lc1}`, { method: 'DELETE' });
check('участник не удаляет чужое — 403', r.status === 403, `${r.status}`);
r = await kira(`/chats/${actChat}/messages/${mc1}`, { method: 'DELETE' });
check('владелец чата удаляет любое', r.status === 200, `${r.status}`);
r = await lev(`/chats/${actChat}/messages`);
check('удалённое пропало у всех', !r.body.messages?.some((m) => m.id === mc1), JSON.stringify(r.body.messages?.map((m) => m.id)));

await mia(`/chats/${actChat}/typing`, { method: 'PUT' });
r = await lev(`/chats/${actChat}/messages`);
check('в чате видно, кто печатает', r.body.typing?.length === 1 && r.body.typing[0].displayName === 'Мия', JSON.stringify(r.body.typing));
r = await mia(`/chats/${actChat}/messages`);
check('себя в «печатает…» нет', r.body.typing?.length === 0, JSON.stringify(r.body.typing));
// Ян — вошедший, но не участник этого чата (`a` к этому месту уже вышел).
r = await yan(`/chats/${actChat}/typing`, { method: 'PUT' });
check('посторонний «печатать» в чужой чат не может — 404', r.status === 404, `${r.status}`);

await lev(`/users/${userMi}/block`, { method: 'PUT' });
r = await lev(`/chats/${actChat}/messages`);
const levBlocked = r.body.messages?.find((m) => m.id === lc1);
check('при блокировке реакция заблокированной не считается', levBlocked?.reactions?.length === 0, JSON.stringify(levBlocked?.reactions));
check('и её «печатает…» не видно', r.body.typing?.length === 0, JSON.stringify(r.body.typing));
await lev(`/users/${userMi}/block`, { method: 'DELETE' });

// Пересылка.
r = await chatSend(kira, { forward: { from: 'dm', id: lr1 } });
check('пересылка из ЛС в чат', r.status === 201 && r.body.message.body === 'В семь пятнадцать, если можно.' && r.body.message.forwardedFrom?.username === userLe, `${r.status} ${JSON.stringify(r.body)}`);
const fwd1 = r.body.message.id;
r = await dmSend(mia, userKi, { forward: { from: 'chat', id: fwd1 } });
check('пересылка пересланного указывает на первоисточник', r.status === 201 && r.body.message.forwardedFrom?.username === userLe, `${r.status} ${JSON.stringify(r.body)}`);
r = await dmSend(mia, userKi, { forward: { from: 'dm', id: lr1 } });
check('переслать из чужой ЛС нельзя — 404', r.status === 404, `${r.status}`);
r = await dmSend(mia, userKi, { forward: { from: 'nowhere', id: 1 } });
check('мусорная пересылка — 400', r.status === 400, `${r.status}`);
r = await kira(`/chats/${actChat}/messages/${fwd1}`, { method: 'PATCH', body: JSON.stringify({ body: 'правлю чужие слова' }) });
check('пересланное не правится — 403', r.status === 403, `${r.status}`);

console.log('\n— вложения в переписке —');
// Сигнатуры настоящие, содержимое — заполнитель: сервер решает по первым
// байтам, а проигрывать или показывать эти файлы тест не собирается.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const PDF = Buffer.from(`%PDF-1.4\n${'x'.repeat(120)}`);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(120, 3)]);
const HTML = Buffer.from(`<html><body><script>alert(1)</script>${' '.repeat(80)}</body></html>`);

function withFile(buf, name, type, fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  for (const [k, val] of Object.entries(fields)) fd.append(k, String(val));
  return fd;
}
const dmPost = (client, to, fd) => client(`/messages/${to}`, { method: 'POST', body: fd });
const chatPost = (client, chatId, fd) => client(`/chats/${chatId}/messages`, { method: 'POST', body: fd });

r = await dmPost(kira, userLe, withFile(PNG, 'закат.png', 'image/png', { body: 'Смотри, что вышло' }));
const photoMsg = r.body.message;
check('фото с подписью отправлено', r.status === 201 && photoMsg?.attachment?.kind === 'image' && photoMsg.body === 'Смотри, что вышло', `${r.status} ${JSON.stringify(r.body)}`);
check('ссылка ведёт на /api/attachments, а не в открытый /uploads', photoMsg?.attachment?.url === `/api/attachments/dm/${photoMsg?.id}`, JSON.stringify(photoMsg?.attachment));

raw = await lev.raw(photoMsg.attachment.url);
let bytes = Buffer.from(await raw.arrayBuffer());
check('собеседник получает файл', raw.status === 200 && bytes.equals(PNG), `${raw.status} ${bytes.length}`);
check('тип — по содержимому, показ — на месте', raw.headers.get('content-type')?.startsWith('image/png') && raw.headers.get('content-disposition')?.startsWith('inline'), `${raw.headers.get('content-type')} ${raw.headers.get('content-disposition')}`);
check('кеш только частный', raw.headers.get('cache-control')?.includes('private'), raw.headers.get('cache-control'));
raw = await mia.raw(photoMsg.attachment.url);
check('посторонний файл не получает — 404', raw.status === 404, `${raw.status}`);
raw = await guest.raw(photoMsg.attachment.url);
check('гость — 401', raw.status === 401, `${raw.status}`);

r = await dmPost(kira, userLe, withFile(PNG, 'без подписи.png', 'image/png'));
const bare = r.body.message;
check('фото без подписи — можно', r.status === 201 && bare?.body === '' && bare?.attachment, `${r.status} ${JSON.stringify(r.body)}`);
r = await kira(`/messages/${userLe}`, { method: 'POST', body: new FormData() });
check('ни текста, ни файла — 400', r.status === 400, `${r.status}`);
r = await dmPost(kira, userLe, withFile(HTML, 'photo.png', 'image/png'));
check('HTML под видом картинки — 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await dmSend(lev, userKi, { body: 'А это что?', replyTo: bare.id });
check('ответ на фото без подписи цитирует «Фото»', r.status === 201 && r.body.message?.replyTo?.body === 'Фото', `${r.status} ${JSON.stringify(r.body.message?.replyTo)}`);

r = await kira(`/messages/${userLe}/${photoMsg.id}`, { method: 'PATCH', body: JSON.stringify({ body: '' }) });
check('подпись у фото можно убрать правкой', r.status === 200 && r.body.message?.body === '' && r.body.message?.editedAt, `${r.status} ${JSON.stringify(r.body)}`);

r = await dmPost(kira, userLe, withFile(PDF, 'Договор аренды.pdf', 'application/pdf'));
const docMsg = r.body.message;
check('документ — вид file, русское имя цело', r.status === 201 && docMsg?.attachment?.kind === 'file' && docMsg.attachment.name === 'Договор аренды.pdf', `${r.status} ${JSON.stringify(docMsg?.attachment)}`);
raw = await lev.raw(docMsg.attachment.url);
check('документ отдаётся только скачиванием', raw.status === 200 && raw.headers.get('content-disposition') === `attachment; filename*=UTF-8''${encodeURIComponent('Договор аренды.pdf')}`, raw.headers.get('content-disposition'));
r = await lev('/messages');
const withKira = r.body.conversations?.find((c) => c.user.username === userKi);
check('в списке диалогов у превью есть вложение', withKira?.lastMessage?.attachment?.kind === 'file', JSON.stringify(withKira?.lastMessage));

// Голосовое.
r = await dmPost(kira, userLe, withFile(WEBM, 'voice.webm', 'audio/webm', { voice: 1, duration: 4, wave: '0135797531' }));
const voiceMsg = r.body.message;
check('голосовое: вид voice, тип audio/webm, длительность и волна', r.status === 201 && voiceMsg?.attachment?.kind === 'voice' && voiceMsg.attachment.mime === 'audio/webm' && voiceMsg.attachment.duration === 4 && voiceMsg.attachment.wave === '0135797531', `${r.status} ${JSON.stringify(voiceMsg?.attachment)}`);
check('у голосового нет имени файла', voiceMsg?.attachment?.name === null, JSON.stringify(voiceMsg?.attachment));
r = await dmPost(kira, userLe, withFile(WEBM, 'v.webm', 'audio/webm', { voice: 1, duration: 0 }));
check('голосовое нулевой длины — 400', r.status === 400, `${r.status}`);
r = await dmPost(kira, userLe, withFile(WEBM, 'v.webm', 'audio/webm', { voice: 1, duration: 999 }));
check('голосовое длиннее пяти минут — 400', r.status === 400, `${r.status}`);
r = await dmPost(kira, userLe, withFile(WEBM, 'v.webm', 'audio/webm', { voice: 1, duration: 3, wave: '<b>' }));
check('мусорная волна — 400', r.status === 400, `${r.status}`);
r = await dmPost(kira, userLe, withFile(PNG, 'v.png', 'image/png', { voice: 1, duration: 3 }));
check('картинка вместо голосового — 400', r.status === 400, `${r.status}`);

// Пересылка и удаление.
r = await chatSend(kira, { forward: { from: 'dm', id: bare.id } });
const fwdPhoto = r.body.message;
check('пересланное фото — со своим вложением в чате', r.status === 201 && fwdPhoto?.attachment?.url === `/api/attachments/chat/${fwdPhoto?.id}`, `${r.status} ${JSON.stringify(r.body)}`);
raw = await mia.raw(fwdPhoto.attachment.url);
check('участник чата видит пересланное фото', raw.status === 200, `${raw.status}`);
r = await kira(`/messages/${userLe}/${bare.id}`, { method: 'DELETE' });
raw = await lev.raw(bare.attachment.url);
check('после удаления сообщения файл недоступен — 404', r.status === 200 && raw.status === 404, `${r.status} ${raw.status}`);
raw = await mia.raw(fwdPhoto.attachment.url);
check('а пересланная копия жива', raw.status === 200, `${raw.status}`);

// Групповой чат.
r = await chatPost(lev, actChat, withFile(PNG, 'стол.png', 'image/png', { body: 'Вот стол для проявки' }));
const chatPhoto = r.body.message;
check('фото в чат', r.status === 201 && chatPhoto?.attachment?.kind === 'image', `${r.status} ${JSON.stringify(r.body)}`);
raw = await mia.raw(chatPhoto.attachment.url);
check('участник чата получает файл', raw.status === 200, `${raw.status}`);
raw = await yan.raw(chatPhoto.attachment.url);
check('не участник — 404', raw.status === 404, `${raw.status}`);
await mia(`/users/${userLe}/block`, { method: 'PUT' });
raw = await mia.raw(chatPhoto.attachment.url);
check('заблокировавшая автора файл не получает', raw.status === 404, `${raw.status}`);
await mia(`/users/${userLe}/block`, { method: 'DELETE' });
r = await lev(`/chats/${actChat}/messages/${chatPhoto.id}`, { method: 'DELETE' });
raw = await kira.raw(chatPhoto.attachment.url);
check('удалённое в чате — файл недоступен', r.status === 200 && raw.status === 404, `${r.status} ${raw.status}`);

console.log('\n— каналы —');
const chHandle = `plenka_${stamp}`;
const chCreate = (client, payload) => client('/channels', { method: 'POST', body: JSON.stringify(payload) });

r = await chCreate(kira, { title: 'Плёнка и свет', handle: `@${chHandle.toUpperCase()}`, description: 'Заметки о проявке' });
const ch = r.body.channel;
check('канал создан, адрес приведён к нижнему регистру без @', r.status === 201 && ch?.handle === chHandle, `${r.status} ${JSON.stringify(r.body)}`);
check('владелец подписан сразу', ch?.subscribed === true && ch?.subscriberCount === 1 && ch?.iAmOwner === true, JSON.stringify(ch));
r = await chCreate(lev, { title: 'Дубль', handle: chHandle });
check('занятый адрес — 409', r.status === 409, `${r.status}`);
r = await chCreate(lev, { title: 'Кривой', handle: '1abc' });
check('адрес с цифры — 400', r.status === 400, `${r.status}`);
r = await chCreate(lev, { title: 'Кривой', handle: 'search' });
check('адрес search зарезервирован — 400', r.status === 400, `${r.status}`);
r = await chCreate(lev, { title: '', handle: `empty_${stamp}` });
check('пустое название — 400', r.status === 400, `${r.status}`);

const chPost = (client, payload) =>
  client(`/channels/${chHandle}/posts`, { method: 'POST', body: payload instanceof FormData ? payload : JSON.stringify(payload) });
r = await chPost(kira, { body: 'Первая публикация: как не засветить плёнку при зарядке бачка.' });
const p1 = r.body.post;
check('владелец публикует', r.status === 201 && p1?.body.startsWith('Первая') && p1.views === 0, `${r.status} ${JSON.stringify(r.body)}`);
r = await chPost(lev, { body: 'чужая публикация' });
check('не владелец публиковать не может — 403', r.status === 403, `${r.status}`);

r = await lev(`/channels/search?q=${encodeURIComponent('ПЛЁНКА')}`);
check('поиск находит канал по названию без учёта регистра и ё', r.body.channels?.some((c) => c.handle === chHandle), JSON.stringify(r.body.channels?.map((c) => c.handle)));
r = await lev(`/channels/search?q=${encodeURIComponent('@' + chHandle.slice(0, 8))}`);
check('и по адресу с @', r.body.channels?.some((c) => c.handle === chHandle), JSON.stringify(r.body.channels?.map((c) => c.handle)));

r = await lev(`/channels/${chHandle}`);
check('канал открыт и неподписанному', r.status === 200 && r.body.channel?.subscribed === false, JSON.stringify(r.body));
r = await guest(`/channels/${chHandle}`);
check('гостю — 401', r.status === 401, `${r.status}`);
r = await lev(`/channels/nety_takogo_${stamp}`);
check('несуществующий канал — 404', r.status === 404, `${r.status}`);

r = await lev(`/channels/${chHandle}/subscription`, { method: 'PUT' });
check('подписка', r.status === 200 && r.body.channel?.subscribed === true && r.body.channel.subscriberCount === 2, JSON.stringify(r.body.channel));
r = await lev(`/channels/${chHandle}/subscription`, { method: 'PUT' });
check('повторная подписка ничего не удваивает', r.body.channel?.subscriberCount === 2, JSON.stringify(r.body.channel));
r = await lev('/channels');
let levCh = r.body.channels?.find((c) => c.handle === chHandle);
check('подписка начинается без старого «непрочитанного»', levCh?.unread === 0, JSON.stringify(levCh));

r = await chPost(kira, withFile(PNG, 'бачок.png', 'image/png', { body: 'Вот бачок' }));
const p2 = r.body.post;
check('публикация с фото', r.status === 201 && p2?.attachment?.url === `/api/attachments/channel/${p2?.id}`, `${r.status} ${JSON.stringify(r.body)}`);
raw = await yan.raw(p2.attachment.url);
check('вложение канала видно любому вошедшему', raw.status === 200, `${raw.status}`);
raw = await guest.raw(p2.attachment.url);
check('гостю — 401', raw.status === 401, `${raw.status}`);

r = await lev('/channels');
levCh = r.body.channels?.find((c) => c.handle === chHandle);
check('новая публикация — непрочитанная у подписчика', levCh?.unread === 1 && levCh.lastPost?.id === p2.id, JSON.stringify(levCh));
r = await lev('/badges');
check('и в общем счётчике', r.body.channels >= 1, JSON.stringify(r.body));
r = await kira('/channels');
check('у владельца своё не непрочитанное', r.body.channels?.find((c) => c.handle === chHandle)?.unread === 0, JSON.stringify(r.body.channels));
await lev(`/channels/${chHandle}/read`, { method: 'PUT' });
r = await lev('/channels');
check('прочитано — счётчик обнулён', r.body.channels?.find((c) => c.handle === chHandle)?.unread === 0, JSON.stringify(r.body.channels));

// Просмотры — по одному на человека.
await lev(`/channels/${chHandle}/posts`);
await lev(`/channels/${chHandle}/posts`);
r = await mia(`/channels/${chHandle}/posts`);
const viewed = r.body.posts?.find((p) => p.id === p1.id);
check("просмотры считают людей, а не обновления", viewed?.views === 2, JSON.stringify(viewed));

// Реакции.
r = await lev(`/channels/${chHandle}/posts/${p1.id}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji: '🔥' }) });
check('реакция на публикацию', r.status === 200 && JSON.stringify(r.body.post?.reactions) === JSON.stringify([{ emoji: '🔥', count: 1, mine: true }]), `${r.status} ${JSON.stringify(r.body.post?.reactions)}`);
r = await mia(`/channels/${chHandle}/posts/${p1.id}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji: '🔥' }) });
check('вторая такая же — счётчик 2', r.body.post?.reactions?.[0]?.count === 2, JSON.stringify(r.body.post?.reactions));

// Правка и удаление — владелец.
r = await lev(`/channels/${chHandle}/posts/${p1.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'подмена' }) });
check('не владелец не правит — 403', r.status === 403, `${r.status}`);
r = await kira(`/channels/${chHandle}/posts/${p1.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'Первая публикация: как не засветить плёнку.' }) });
check('владелец правит, пометка «изменено»', r.status === 200 && r.body.post?.editedAt && r.body.post.views === 2, JSON.stringify(r.body.post));

// Комментарии.
const comment = (client, postId, body) =>
  client(`/channels/${chHandle}/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
r = await comment(lev, p1.id, 'А если бачок пластиковый?');
const c1 = r.body.comment;
check('комментарий', r.status === 201 && c1?.author?.username === userLe, `${r.status} ${JSON.stringify(r.body)}`);
r = await comment(mia, p1.id, 'Тогда так же, только без спешки.');
const c2 = r.body.comment;
r = await comment(mia, p1.id, '  ');
check('пустой комментарий — 400', r.status === 400, `${r.status}`);
r = await yan(`/channels/${chHandle}/posts/${p1.id}/comments`);
check('ветка — старые сверху, у публикации счётчик', r.body.comments?.map((c) => c.id).join() === `${c1.id},${c2.id}` && r.body.post?.commentCount === 2, JSON.stringify(r.body));
r = await lev(`/channels/${chHandle}/posts/${p1.id}/comments/${c2.id}`, { method: 'DELETE' });
check('чужой комментарий удалить нельзя — 403', r.status === 403, `${r.status}`);

await lev(`/users/${userMi}/block`, { method: 'PUT' });
r = await lev(`/channels/${chHandle}/posts/${p1.id}/comments`);
check('при блокировке её комментарии не видны', r.body.comments?.every((c) => c.author.username !== userMi) && r.body.post?.commentCount === 1, JSON.stringify(r.body));
check('и её реакция не считается', r.body.post?.reactions?.[0]?.count === 1, JSON.stringify(r.body.post?.reactions));
await lev(`/users/${userMi}/block`, { method: 'DELETE' });

await kira(`/users/${userY}/block`, { method: 'PUT' });
r = await comment(yan, p1.id, 'меня заблокировали');
check('заблокированный владельцем не комментирует — 403', r.status === 403, `${r.status}`);
r = await yan(`/channels/${chHandle}/posts/${p1.id}/comments`);
check('и видит это заранее — canComment: false', r.body.canComment === false, JSON.stringify(r.body.canComment));
await kira(`/users/${userY}/block`, { method: 'DELETE' });

r = await kira(`/channels/${chHandle}/posts/${p1.id}/comments/${c2.id}`, { method: 'DELETE' });
check('владелец канала удаляет любой комментарий', r.status === 200, `${r.status}`);

// Пересылка из канала.
r = await dmSend(lev, userMi, { forward: { from: 'channel', id: p2.id } });
check('пересылка публикации в ЛС — «из канала», с копией фото', r.status === 201 && r.body.message?.forwardedFrom?.kind === 'channel' && r.body.message.forwardedFrom.handle === chHandle && r.body.message.attachment?.kind === 'image', `${r.status} ${JSON.stringify(r.body.message)}`);
const fromChannel = r.body.message;
r = await chatSend(mia, { forward: { from: 'dm', id: fromChannel.id } });
check('пересылка пересланного из канала указывает на канал', r.status === 201 && r.body.message?.forwardedFrom?.kind === 'channel', `${r.status} ${JSON.stringify(r.body.message?.forwardedFrom)}`);
r = await lev(`/messages/${userMi}/${fromChannel.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'правлю канал' }) });
check('пересланное из канала не правится — 403', r.status === 403, `${r.status}`);
r = await dmSend(lev, userMi, { forward: { from: 'channel', id: 999999999 } });
check('несуществующая публикация — 404', r.status === 404, `${r.status}`);

// Отписка и удаление.
r = await kira(`/channels/${chHandle}/subscription`, { method: 'DELETE' });
check('владелец не отписывается от своего — 400', r.status === 400, `${r.status}`);
r = await lev(`/channels/${chHandle}/subscription`, { method: 'DELETE' });
check('отписка', r.status === 200 && r.body.channel?.subscribed === false && r.body.channel.subscriberCount === 1, JSON.stringify(r.body.channel));
r = await lev(`/channels/${chHandle}`, { method: 'DELETE' });
check('чужой канал не удалить — 403', r.status === 403, `${r.status}`);
r = await kira(`/channels/${chHandle}`, { method: 'DELETE' });
raw = await lev.raw(p2.attachment.url);
check('канал удалён вместе с файлами', r.status === 200 && raw.status === 404, `${r.status} ${raw.status}`);
r = await mia(`/messages/${userLe}`);
const orphanFwd = r.body.messages?.find((m) => m.id === fromChannel.id);
check('пересланное осталось, подпись канала пропала, фото живо', orphanFwd && orphanFwd.forwardedFrom === null && orphanFwd.attachment, JSON.stringify(orphanFwd));

console.log('\n— закреплённые и приглушённые чаты —');
const pref = (client, kind, target, body) =>
  client(`/prefs/${kind}/${target}`, { method: 'PUT', body: JSON.stringify(body) });
const badges = async (client) => (await client('/badges')).body;
const unreadEvents = async (client) => (await client('/notifications')).body.unread;

r = await pref(lev, 'dm', userKi, { pinned: true });
check('закрепить личку', r.status === 200 && r.body.pinned === true && r.body.muted === false, `${r.status} ${JSON.stringify(r.body)}`);
r = await lev('/messages');
const levKira = r.body.conversations?.find((c) => c.user.username === userKi);
check('в списке у неё время закрепления', typeof levKira?.pinnedAt === 'string' && levKira.muted === false, JSON.stringify(levKira));
const pinnedOnce = levKira.pinnedAt;
await pref(lev, 'dm', userKi, { pinned: true });
r = await lev('/messages');
check('повторное «закрепить» не сдвигает порядок', r.body.conversations?.find((c) => c.user.username === userKi)?.pinnedAt === pinnedOnce, 'сдвинулось');

// Приглушённая личка: непрочитанное есть, но не в общем счётчике и без событий.
r = await pref(mia, 'dm', userLe, { muted: true });
check('приглушить личку', r.body.muted === true && r.body.pinned === false, JSON.stringify(r.body));
let before = await badges(mia);
let eventsBefore = await unreadEvents(mia);
await dmSend(lev, userMi, { body: 'Это приглушено' });
let after = await badges(mia);
check('приглушённая личка не растит общий счётчик', after.messages === before.messages, `${before.messages} → ${after.messages}`);
check('и не создаёт событий', (await unreadEvents(mia)) === eventsBefore, 'событие появилось');
r = await mia('/messages');
const miaLev = r.body.conversations?.find((c) => c.user.username === userLe);
check('в самом списке непрочитанное видно, с пометкой muted', miaLev?.unread >= 1 && miaLev.muted === true, JSON.stringify(miaLev));
r = await mia(`/messages/${userLe}/read`, { method: 'PUT' });
check('unreadTotal после прочтения тоже без приглушённых', typeof r.body.unreadTotal === 'number', JSON.stringify(r.body));
await pref(mia, 'dm', userLe, { muted: false });
before = await badges(mia);
await dmSend(lev, userMi, { body: 'А это уже слышно' });
after = await badges(mia);
check('включили звук — снова в счётчике', after.messages === before.messages + 1, `${before.messages} → ${after.messages}`);
await mia(`/messages/${userLe}/read`, { method: 'PUT' });

// Групповой чат.
await pref(lev, 'chat', actChat, { muted: true });
before = await badges(lev);
eventsBefore = await unreadEvents(lev);
await chatSend(mia, { body: 'В приглушённый чат' });
after = await badges(lev);
check('приглушённый чат не растит счётчик', after.chats === before.chats, `${before.chats} → ${after.chats}`);
check('и не создаёт событий', (await unreadEvents(lev)) === eventsBefore, 'событие появилось');
r = await lev('/chats');
const levAct = r.body.chats?.find((c) => c.id === actChat);
check('в списке чатов — unread и muted', levAct?.unread >= 1 && levAct.muted === true, JSON.stringify({ unread: levAct?.unread, muted: levAct?.muted }));

// Канал.
const prefHandle = `prefs_${stamp}`;
await chCreate(kira, { title: 'Для настроек', handle: prefHandle });
await lev(`/channels/${prefHandle}/subscription`, { method: 'PUT' });
await pref(lev, 'channel', prefHandle, { muted: true });
before = await badges(lev);
await kira(`/channels/${prefHandle}/posts`, { method: 'POST', body: JSON.stringify({ body: 'Тихая публикация' }) });
after = await badges(lev);
check('приглушённый канал не растит счётчик', after.channels === before.channels, `${before.channels} → ${after.channels}`);
r = await lev('/channels');
check('в списке каналов — muted', r.body.channels?.find((c) => c.handle === prefHandle)?.muted === true, JSON.stringify(r.body.channels?.map((c) => [c.handle, c.muted])));

// Доступ и ввод.
r = await pref(yan, 'chat', actChat, { pinned: true });
check('чужой чат — 404', r.status === 404, `${r.status}`);
r = await pref(yan, 'channel', prefHandle, { pinned: true });
check('канал без подписки — 404', r.status === 404, `${r.status}`);
r = await pref(lev, 'dm', userLe, { muted: false });
check('себе — можно: «Избранное» тоже чат в списке', r.status === 200, `${r.status}`);
r = await pref(lev, 'group', actChat, { pinned: true });
check('неизвестный вид — 404', r.status === 404, `${r.status}`);
r = await pref(lev, 'dm', userKi, { pinned: 'yes' });
check('не булево — 400', r.status === 400, `${r.status}`);

// Лимит — пять закреплённых.
for (const name of [userMi, userY, userV, userA]) await pref(lev, 'dm', name, { pinned: true });
r = await pref(lev, 'chat', actChat, { pinned: true });
check('шестой закреплённый — 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
await pref(lev, 'dm', userA, { pinned: false });
r = await pref(lev, 'chat', actChat, { pinned: true });
check('открепили один — место освободилось', r.status === 200 && r.body.pinned === true && r.body.muted === true, `${r.status} ${JSON.stringify(r.body)}`);

// Ушёл из чата — настройки не висят в лимите.
await pref(mia, 'chat', actChat, { pinned: true });
const miaId = (await mia('/auth/me')).body.user.id;
await mia(`/chats/${actChat}/members/${userMi}`, { method: 'DELETE' });
{
  const rdb = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
  try {
    const left = rdb.prepare("SELECT COUNT(*) AS c FROM chat_prefs WHERE user_id = ? AND kind = 'chat' AND target_id = ?").get(miaId, actChat).c;
    check('после выхода из чата его настройки удалены', left === 0, `${left}`);
  } finally {
    rdb.close();
  }
}

console.log('\n— закреплённые сообщения —');
r = await dmSend(kira, userLe, { body: 'Адрес мастерской: Литейная, 12, второй двор.' });
const pinMe = r.body.message.id;
r = await lev(`/messages/${userKi}/${pinMe}/pin`, { method: 'PUT' });
check('в ЛС закрепить может и получатель', r.status === 200 && r.body.pinned?.id === pinMe && r.body.pinned.body.startsWith('Адрес'), `${r.status} ${JSON.stringify(r.body)}`);
r = await kira(`/messages/${userLe}`);
check('закреплённое видно обоим', r.body.pinned?.id === pinMe, JSON.stringify(r.body.pinned));
r = await mia(`/messages/${userKi}/${pinMe}/pin`, { method: 'PUT' });
check('посторонний закрепить не может — 404', r.status === 404, `${r.status}`);
r = await dmPost(kira, userLe, withFile(PNG, 'схема.png', 'image/png'));
const pinPhoto = r.body.message.id;
await kira(`/messages/${userLe}/${pinPhoto}/pin`, { method: 'PUT' });
r = await lev(`/messages/${userKi}`);
check('второе закрепление — рядом с первым, свежее сверху; фото без подписи — «Фото»',
  r.body.pinned?.id === pinPhoto && r.body.pinned.body === 'Фото' && r.body.pinned.attachmentKind === 'image'
  && r.body.pins?.map((x) => x.id).join() === `${pinPhoto},${pinMe}`, JSON.stringify(r.body.pins));
await kira(`/messages/${userLe}/${pinPhoto}`, { method: 'DELETE' });
r = await lev(`/messages/${userKi}`);
check('удалили закреплённое — осталось прежнее', r.body.pinned?.id === pinMe && r.body.pins?.length === 1, JSON.stringify(r.body.pins));
r = await dmSend(lev, userKi, { body: 'Второй адрес — на всякий случай' });
const pinSecond = r.body.message.id;
await lev(`/messages/${userKi}/${pinSecond}/pin`, { method: 'PUT' });
r = await kira(`/messages/${userLe}/${pinSecond}/pin`, { method: 'DELETE' });
check('открепить одно — остальные на месте', r.status === 200 && r.body.pins?.map((x) => x.id).join() === `${pinMe}` && r.body.pinned?.id === pinMe, JSON.stringify(r.body));
r = await kira(`/messages/${userLe}/abc/pin`, { method: 'DELETE' });
check('открепить не номер — 404', r.status === 404, `${r.status}`);
// Лимит — двадцать закреплённых на переписку.
const manyPins = [];
for (let i = 0; i < 20; i++) manyPins.push((await dmSend(kira, userLe, { body: `Закреп ${i}` })).body.message.id);
for (const id of manyPins.slice(0, 19)) await kira(`/messages/${userLe}/${id}/pin`, { method: 'PUT' });
r = await kira(`/messages/${userLe}/${manyPins[19]}/pin`, { method: 'PUT' });
check('двадцать первое закрепление — 400', r.status === 400 && /открепите/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
r = await kira(`/messages/${userLe}/${pinMe}/pin`, { method: 'PUT' });
check('повторно закрепить уже закреплённое — можно и на пределе', r.status === 200 && r.body.pins?.length === 20, `${r.status} ${r.body.pins?.length}`);
await lev(`/messages/${userKi}/${pinMe}/pin`, { method: 'PUT' });
r = await kira(`/messages/${userLe}/pin`, { method: 'DELETE' });
check('открепить', r.status === 200, `${r.status}`);
r = await lev(`/messages/${userKi}`);
check('после открепления — null', r.body.pinned === null, JSON.stringify(r.body.pinned));
await lev(`/users/${userKi}/block`, { method: 'PUT' });
r = await kira(`/messages/${userLe}/${pinMe}/pin`, { method: 'PUT' });
check('при блокировке закрепить — 403', r.status === 403, `${r.status}`);
await lev(`/users/${userKi}/block`, { method: 'DELETE' });

// Группа: закрепляет владелец.
r = await kira('/chats', { method: 'POST', body: JSON.stringify({ title: 'Закрепы', members: [userLe] }) });
const pinChat = r.body.chat.id;
r = await lev(`/chats/${pinChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Сбор в 10:00 у проходной' }) });
const chatPinMsg = r.body.message.id;
r = await lev(`/chats/${pinChat}/messages/${chatPinMsg}/pin`, { method: 'PUT' });
check('в группе участник не закрепляет — 403', r.status === 403, `${r.status}`);
r = await kira(`/chats/${pinChat}/messages/${chatPinMsg}/pin`, { method: 'PUT' });
check('владелец закрепляет', r.status === 200 && r.body.pinned?.id === chatPinMsg, `${r.status} ${JSON.stringify(r.body)}`);
r = await lev(`/chats/${pinChat}/messages`);
check('участник видит закреплённое', r.body.pinned?.body === 'Сбор в 10:00 у проходной', JSON.stringify(r.body.pinned));
r = await lev(`/chats/${pinChat}/pin`, { method: 'DELETE' });
check('участник не открепляет — 403', r.status === 403, `${r.status}`);
r = await lev(`/chats/${pinChat}/messages/${chatPinMsg}/pin`, { method: 'DELETE' });
check('и по одному — тоже 403', r.status === 403, `${r.status}`);
r = await kira(`/chats/${pinChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'И второе: обед в час' }) });
const chatPin2 = r.body.message.id;
await kira(`/chats/${pinChat}/messages/${chatPin2}/pin`, { method: 'PUT' });
r = await lev(`/chats/${pinChat}/messages`);
check('в группе закреплённых два', r.body.pins?.map((x) => x.id).join() === `${chatPin2},${chatPinMsg}`, JSON.stringify(r.body.pins));
r = await kira(`/chats/${pinChat}/messages/${chatPin2}/pin`, { method: 'DELETE' });
check('владелец открепляет одно', r.status === 200 && r.body.pins?.map((x) => x.id).join() === `${chatPinMsg}`, JSON.stringify(r.body));
await kira(`/users/${userLe}/block`, { method: 'PUT' });
r = await kira(`/chats/${pinChat}/messages`);
check('закреплённое от заблокированного не показывается', r.body.pinned === null, JSON.stringify(r.body.pinned));
await kira(`/users/${userLe}/block`, { method: 'DELETE' });

// Канал.
const pinHandle = `pins_${stamp}`;
await chCreate(kira, { title: 'Закреп в канале', handle: pinHandle });
r = await kira(`/channels/${pinHandle}/posts`, { method: 'POST', body: JSON.stringify({ body: 'Правила канала: без спойлеров.' }) });
const rulesPost = r.body.post.id;
r = await kira(`/channels/${pinHandle}/posts/${rulesPost}/pin`, { method: 'PUT' });
check('владелец канала закрепляет публикацию', r.status === 200 && r.body.pinned?.id === rulesPost, `${r.status} ${JSON.stringify(r.body)}`);
r = await yan(`/channels/${pinHandle}/posts`);
check('читатель видит закреплённую', r.body.pinned?.id === rulesPost, JSON.stringify(r.body.pinned));
r = await yan(`/channels/${pinHandle}/pin`, { method: 'DELETE' });
check('читатель не открепляет — 403', r.status === 403, `${r.status}`);
r = await kira(`/channels/${pinHandle}/posts`, { method: 'POST', body: JSON.stringify({ body: 'Расписание эфиров' }) });
const schedulePost = r.body.post.id;
r = await kira(`/channels/${pinHandle}/posts/${schedulePost}/pin`, { method: 'PUT' });
check('в канале — две закреплённые', r.body.pins?.length === 2 && r.body.pinned?.id === schedulePost, JSON.stringify(r.body.pins));
r = await yan(`/channels/${pinHandle}/posts/${schedulePost}/pin`, { method: 'DELETE' });
check('читатель не открепляет и одну', r.status === 403, `${r.status}`);
r = await kira(`/channels/${pinHandle}/posts/${schedulePost}/pin`, { method: 'DELETE' });
check('владелец открепляет одну', r.status === 200 && r.body.pins?.map((x) => x.id).join() === `${rulesPost}`, JSON.stringify(r.body));
await kira(`/channels/${pinHandle}/posts/${rulesPost}`, { method: 'DELETE' });
r = await yan(`/channels/${pinHandle}/posts`);
check('удалили публикацию — закрепа нет', r.body.pinned === null, JSON.stringify(r.body.pinned));

console.log('\n— поиск внутри переписки —');
const inSearch = (client, path, q) => client(`${path}/search?q=${encodeURIComponent(q)}`);
await dmSend(kira, userLe, { body: 'Плёнку Ilford проявляем в субботу.' });
await dmSend(lev, userKi, { body: 'А Kodak — в воскресенье.' });
r = await inSearch(lev, `/messages/${userKi}`, 'ПЛЕНКУ');
check('регистр и ё не важны', r.status === 200 && r.body.results?.[0]?.body.startsWith('Плёнку Ilford'), `${r.status} ${JSON.stringify(r.body)}`);
check('у результата автор', r.body.results?.[0]?.author?.displayName === 'Кира', JSON.stringify(r.body.results?.[0]));
r = await inSearch(lev, `/messages/${userKi}`, 'плёнку воскресенье');
check('все слова должны встретиться', r.body.results?.length === 0, JSON.stringify(r.body.results));
r = await inSearch(kira, `/messages/${userLe}`, 'договор');
check('ищется и имя файла, с подписью вложения', r.body.results?.some((x) => x.body === 'Договор аренды.pdf'), JSON.stringify(r.body.results));
r = await inSearch(mia, `/messages/${userKi}`, 'Ilford');
check('чужая переписка не ищется — у постороннего пусто', r.status === 200 && r.body.results?.length === 0, JSON.stringify(r.body));
r = await inSearch(lev, `/messages/${userKi}`, '***');
check('мусорный запрос — пусто, не 500', r.status === 200 && r.body.results?.length === 0, `${r.status}`);
r = await inSearch(lev, `/messages/${userKi}`, 'я'.repeat(101));
check('запрос длиннее 100 — 400', r.status === 400, `${r.status}`);

await chatSend(lev, { body: 'Проявитель Родинал заканчивается' });
r = await inSearch(kira, `/chats/${actChat}`, 'родинал');
check('поиск по чату', r.status === 200 && r.body.results?.[0]?.author?.displayName === 'Лев', `${r.status} ${JSON.stringify(r.body)}`);
r = await inSearch(yan, `/chats/${actChat}`, 'родинал');
check('не участник — 404', r.status === 404, `${r.status}`);
await kira(`/users/${userLe}/block`, { method: 'PUT' });
r = await inSearch(kira, `/chats/${actChat}`, 'родинал');
check('реплики заблокированного не находятся', r.body.results?.length === 0, JSON.stringify(r.body.results));
await kira(`/users/${userLe}/block`, { method: 'DELETE' });

await kira(`/channels/${pinHandle}/posts`, { method: 'POST', body: JSON.stringify({ body: 'Сканер Epson V600 — впечатления' }) });
r = await inSearch(yan, `/channels/${pinHandle}`, 'epson');
check('поиск по каналу — любому вошедшему', r.status === 200 && r.body.results?.[0]?.body.startsWith('Сканер Epson'), `${r.status} ${JSON.stringify(r.body)}`);

console.log('\n— видеосообщения —');
r = await dmPost(kira, userLe, withFile(WEBM, 'note.webm', 'video/webm', { videonote: 1, duration: 12 }));
const noteMsg = r.body.message;
check('«кружок»: вид videonote, тип video/webm, длительность, без имени', r.status === 201 && noteMsg?.attachment?.kind === 'videonote' && noteMsg.attachment.mime === 'video/webm' && noteMsg.attachment.duration === 12 && noteMsg.attachment.name === null, `${r.status} ${JSON.stringify(noteMsg?.attachment)}`);
raw = await lev.raw(noteMsg.attachment.url);
check('отдаётся видео и показывается на месте', raw.status === 200 && raw.headers.get('content-type')?.startsWith('video/webm') && raw.headers.get('content-disposition')?.startsWith('inline'), `${raw.status} ${raw.headers.get('content-type')}`);
raw = await lev.raw(noteMsg.attachment.url, { Range: 'bytes=0-9' });
bytes = Buffer.from(await raw.arrayBuffer());
check('перемотка: Range отдаёт кусок — 206 и ровно 10 байт', raw.status === 206 && bytes.length === 10, `${raw.status} ${bytes.length}`);
r = await dmPost(kira, userLe, withFile(WEBM, 'n.webm', 'video/webm', { videonote: 1, duration: 61 }));
check('длиннее минуты — 400', r.status === 400, `${r.status}`);
r = await dmPost(kira, userLe, withFile(WEBM, 'n.webm', 'video/webm', { videonote: 1, duration: 0 }));
check('ноль секунд — 400', r.status === 400, `${r.status}`);
r = await dmPost(kira, userLe, withFile(PNG, 'n.png', 'image/png', { videonote: 1, duration: 5 }));
check('картинка вместо видео — 400', r.status === 400, `${r.status}`);
r = await dmPost(kira, userLe, withFile(WEBM, 'n.webm', 'video/webm', { videonote: 1, voice: 1, duration: 5 }));
check('и голосовое, и видео сразу — 400', r.status === 400, `${r.status}`);
r = await dmSend(lev, userKi, { body: 'Классный кружок!', replyTo: noteMsg.id });
check('ответ на «кружок» цитирует «Видеосообщение»', r.body.message?.replyTo?.body === 'Видеосообщение', JSON.stringify(r.body.message?.replyTo));
r = await chatPost(kira, actChat, withFile(WEBM, 'n.webm', 'video/webm', { videonote: 1, duration: 3 }));
check('«кружок» в группу', r.status === 201 && r.body.message?.attachment?.kind === 'videonote', `${r.status}`);

console.log('\n— папки чатов —');
const folderPost = (client, body) => client('/folders', { method: 'POST', body: JSON.stringify(body) });
r = await folderPost(lev, { title: 'Личное', types: ['dm'], excludeMuted: true });
const personal = r.body.folder;
check('папка по виду чатов', r.status === 201 && personal?.types.join() === 'dm' && personal.excludeMuted === true && personal.include.length === 0, `${r.status} ${JSON.stringify(r.body)}`);
r = await folderPost(lev, { title: 'Плёнка', include: [{ kind: 'chat', id: actChat }, { kind: 'channel', id: 999 }] });
const film = r.body.folder;
check('папка из выбранных чатов', r.status === 201 && film?.include.length === 2 && film.types.length === 0, `${r.status} ${JSON.stringify(r.body)}`);
r = await folderPost(lev, { title: 'Пустая' });
check('пустая папка — 400', r.status === 400, `${r.status}`);
r = await folderPost(lev, { title: 'Очень длинное имя папки', types: ['dm'] });
check('имя длиннее 12 — 400', r.status === 400, `${r.status}`);
r = await folderPost(lev, { title: 'Боты', types: ['bot'] });
check('неизвестный вид — 400', r.status === 400, `${r.status}`);
r = await folderPost(lev, { title: 'Кривая', include: [{ kind: 'chat', id: 'x' }] });
check('кривой чат в списке — 400', r.status === 400, `${r.status}`);

r = await lev(`/folders/${personal.id}`, { method: 'PATCH', body: JSON.stringify({ exclude: [{ kind: 'dm', id: miaId }], include: [{ kind: 'dm', id: miaId }] }) });
check('исключение побеждает добавление', r.status === 200 && r.body.folder?.exclude.some((x) => x.id === miaId) && !r.body.folder.include.some((x) => x.id === miaId), `${r.status} ${JSON.stringify(r.body)}`);
r = await lev(`/folders/${personal.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Люди' }) });
check('правка имени не трогает остальное', r.body.folder?.title === 'Люди' && r.body.folder.types.join() === 'dm' && r.body.folder.exclude.length === 1, JSON.stringify(r.body.folder));
r = await lev(`/folders/${film.id}`, { method: 'PATCH', body: JSON.stringify({ include: [] }) });
check('правка, после которой папка пуста, — 400 и без изменений', r.status === 400, `${r.status}`);
r = await lev('/folders');
check('после отказа чаты папки на месте', r.body.folders?.find((f) => f.id === film.id)?.include.length === 2, JSON.stringify(r.body.folders));
check('порядок — порядок создания', r.body.folders?.map((f) => f.id).join() === `${personal.id},${film.id}`, JSON.stringify(r.body.folders?.map((f) => f.id)));

r = await lev('/folders/order', { method: 'PUT', body: JSON.stringify({ ids: [film.id, personal.id] }) });
check('новый порядок', r.status === 200 && r.body.folders?.map((f) => f.id).join() === `${film.id},${personal.id}`, `${r.status} ${JSON.stringify(r.body)}`);
r = await lev('/folders/order', { method: 'PUT', body: JSON.stringify({ ids: [film.id] }) });
check('порядок без одной папки — 400', r.status === 400, `${r.status}`);

r = await kira('/folders');
check('чужих папок не видно', r.body.folders?.length === 0, JSON.stringify(r.body.folders));
r = await kira(`/folders/${film.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Моя' }) });
check('чужую папку не править — 404', r.status === 404, `${r.status}`);
r = await kira(`/folders/${film.id}`, { method: 'DELETE' });
check('и не удалить — 404', r.status === 404, `${r.status}`);

for (let i = 0; i < 8; i++) await folderPost(lev, { title: `Папка ${i}`, types: ['chat'] });
r = await folderPost(lev, { title: 'Одиннадцатая', types: ['chat'] });
check('одиннадцатая папка — 400', r.status === 400, `${r.status}`);
r = await lev(`/folders/${film.id}`, { method: 'DELETE' });
check('удалить свою', r.status === 200, `${r.status}`);
r = await folderPost(lev, { title: 'Снова место', types: ['channel'] });
check('после удаления место освободилось', r.status === 201, `${r.status}`);

console.log('\n— Избранное —');
const sam = makeClient();
const userSa = `sam_${stamp}`;
await signUp(sam, userSa, 'Сэм');
r = await sam(`/messages/${userSa}`, { method: 'POST', body: JSON.stringify({ body: 'Купить: плёнка, фиксаж, проявитель' }) });
check('сообщение себе — сразу прочитано', r.status === 201 && r.body.message?.readAt != null, `${r.status} ${JSON.stringify(r.body.message)}`);
const savedMsg = r.body.message.id;
r = await sam('/messages');
const savedRow = r.body.conversations?.find((c) => c.user.username === userSa);
check('«Избранное» в списке без непрочитанного', savedRow?.unread === 0 && r.body.unreadTotal === 0, JSON.stringify(r.body));
r = await sam('/notifications');
check('себе — без события', !r.body.notifications?.some((x) => x.kind === 'message'), JSON.stringify(r.body.notifications?.map((x) => x.kind)));
r = await dmSend(kira, userSa, { body: 'Проявка в субботу, приходи' });
r = await sam(`/messages/${userSa}`, { method: 'POST', body: JSON.stringify({ forward: { from: 'dm', id: r.body.message.id } }) });
check('переслать в «Избранное»', r.status === 201 && r.body.message?.forwardedFrom?.username === userKi, `${r.status} ${JSON.stringify(r.body.message?.forwardedFrom)}`);
r = await dmPost(sam, userSa, withFile(PNG_1PX, 'чек.png', 'image/png'));
check('файл в «Избранное»', r.status === 201 && r.body.message?.attachment?.kind === 'image', `${r.status}`);
r = await sam(`/messages/${userSa}/${savedMsg}/pin`, { method: 'PUT' });
check('закрепить в «Избранном»', r.status === 200 && r.body.pinned?.id === savedMsg, `${r.status}`);
r = await sam(`/messages/${userSa}/search?q=фиксаж`);
check('поиск по «Избранному»', r.body.results?.length === 1 && r.body.results[0].id === savedMsg, JSON.stringify(r.body));
r = await pref(sam, 'dm', userSa, { pinned: true });
check('«Избранное» закрепляется в списке', r.status === 200 && r.body.pinned === true, `${r.status}`);
r = await sam(`/messages/${userSa}`);
check('в «Избранном» три сообщения и никакого «печатает»', r.body.typing === false && r.body.messages?.length === 3, JSON.stringify(r.body.messages?.length));

console.log('\n— кто видит время захода —');
const tom = makeClient();
const una = makeClient();
const userTo = `tom_${stamp}`;
const userUn = `una_${stamp}`;
await signUp(tom, userTo, 'Том');
await signUp(una, userUn, 'Уна');
await dmSend(tom, userUn, { body: 'Привет!' });
const seenBy = async (client, other) => (await client(`/messages/${other}`)).body.user;
const privacy = (client, lastSeen) => client('/account/privacy', { method: 'PUT', body: JSON.stringify({ lastSeen }) });

r = await guest('/account');
check('настройки — гостю 401', r.status === 401, `${r.status}`);
r = await tom('/account');
check('настройки: почта и «всем»', r.status === 200 && r.body.email === `${userTo}@example.test` && r.body.lastSeen === 'all', JSON.stringify(r.body));
let lastSeen = await seenBy(una, userTo);
check('по умолчанию время видно', typeof lastSeen?.lastSeenAt === 'string' && lastSeen.seenRecently === false, JSON.stringify(lastSeen));
r = await privacy(tom, 'nobody');
check('«никому» сохранено', r.status === 200 && r.body.lastSeen === 'nobody', `${r.status}`);
lastSeen = await seenBy(una, userTo);
check('«никому» — вместо времени «недавно»', lastSeen.lastSeenAt === null && lastSeen.seenRecently === true, JSON.stringify(lastSeen));
lastSeen = await seenBy(tom, userUn);
check('правило взаимное: спрятавший не видит чужое', lastSeen.lastSeenAt === null && lastSeen.seenRecently === true, JSON.stringify(lastSeen));
r = await tom('/messages');
check('и в списке чатов тоже', r.body.conversations?.find((c) => c.user.username === userUn)?.user.lastSeenAt === null, '');
await privacy(tom, 'follows');
lastSeen = await seenBy(una, userTo);
check('«подпискам» — не подписан, не видно', lastSeen.lastSeenAt === null, JSON.stringify(lastSeen));
await tom(`/users/${userUn}/follow`, { method: 'PUT' });
lastSeen = await seenBy(una, userTo);
check('«подпискам» — на кого подписан, тот видит', typeof lastSeen.lastSeenAt === 'string', JSON.stringify(lastSeen));
lastSeen = await seenBy(tom, userUn);
check('и сам видит его', typeof lastSeen.lastSeenAt === 'string', JSON.stringify(lastSeen));
r = await tom('/chats', { method: 'POST', body: JSON.stringify({ title: 'Тихий чат', members: [userUn] }) });
const quietChat = r.body.chat?.id;
await privacy(tom, 'nobody');
r = await una(`/chats/${quietChat}`);
const tomInChat = r.body.chat?.members?.find((m) => m.username === userTo);
check('в группе правило то же', tomInChat?.lastSeenAt === null && tomInChat?.seenRecently === true, JSON.stringify(tomInChat));
r = await privacy(tom, 'friends');
check('неизвестный вариант — 400', r.status === 400, `${r.status}`);
await privacy(tom, 'all');

console.log('\n— пароль и сеансы —');
const tom2 = makeClient();
const login = (client, password, username = userTo) =>
  client('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
await login(tom2, 'parol12345');
r = await tom('/account/sessions');
const sessions = r.body.sessions ?? [];
check('два сеанса, текущий первым', sessions.length === 2 && sessions[0].current && !sessions[1].current, JSON.stringify(sessions));
check('токенов в ответе нет', sessions.every((s) => !('token' in s) && Number.isInteger(s.id)), JSON.stringify(sessions));
r = await tom(`/account/sessions/${sessions[0].id}`, { method: 'DELETE' });
check('текущий так не закончить — 400', r.status === 400, `${r.status}`);
r = await una(`/account/sessions/${sessions[1].id}`, { method: 'DELETE' });
check('чужой сеанс — 404', r.status === 404, `${r.status}`);
r = await tom(`/account/sessions/${sessions[1].id}`, { method: 'DELETE' });
check('закончить другой сеанс', r.status === 200, `${r.status}`);
r = await tom2('/auth/me');
check('там больше не вошли', r.body.user === null, JSON.stringify(r.body));

await login(tom2, 'parol12345');
const changePwd = (currentPassword, newPassword) =>
  tom('/account/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) });
r = await changePwd('ne-tot-parol', 'novyi-parol-1');
check('неверный текущий пароль — 403', r.status === 403, `${r.status}`);
r = await changePwd('parol12345', 'korotk');
check('короткий новый — 400', r.status === 400, `${r.status}`);
r = await changePwd('parol12345', 'parol12345');
check('тот же самый — 400', r.status === 400, `${r.status}`);
r = await changePwd('parol12345', 'novyi-parol-1');
check('пароль сменён, другой сеанс закрыт', r.status === 200 && r.body.ended === 1, `${r.status} ${JSON.stringify(r.body)}`);
r = await tom('/auth/me');
check('текущий сеанс остался', r.body.user?.username === userTo, JSON.stringify(r.body));
r = await tom2('/auth/me');
check('другой — нет', r.body.user === null, JSON.stringify(r.body));
r = await login(makeClient(), 'parol12345');
check('старый пароль не входит', r.status === 401, `${r.status}`);
r = await login(tom2, 'novyi-parol-1');
check('новый входит', r.status === 200, `${r.status}`);
r = await tom('/account/sessions', { method: 'DELETE' });
check('завершить все другие', r.status === 200 && r.body.ended === 1, JSON.stringify(r.body));

console.log('\n— удаление аккаунта —');
const vic = makeClient();
const userVi = `vika_${stamp}`;
await signUp(vic, userVi, 'Вика');
await vic('/users/me/avatar', { method: 'PUT', body: upload(PNG_1PX, 'me.png', 'image/png', 'avatar') });
r = await vic('/posts', { method: 'POST', body: upload(PNG_1PX, 'p.png', 'image/png', 'media', { body: `Прощальная запись ${stamp}` }) });
const vicPost = r.body.post;
r = await dmPost(vic, userUn, withFile(PNG_1PX, 'v.png', 'image/png'));
const vicAttach = r.body.message?.attachment?.url;
await dmSend(una, userVi, { body: 'Ответ Вике' });
r = await vic('/chats', { method: 'POST', body: JSON.stringify({ title: 'Вика и Уна', members: [userUn] }) });
const sharedChat = r.body.chat.id;
await vic(`/chats/${sharedChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Моя реплика' }) });
await una(`/chats/${sharedChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Реплика Уны' }) });
r = await vic('/chats', { method: 'POST', body: JSON.stringify({ title: 'Вика одна', members: [userUn] }) });
const lonelyChat = r.body.chat.id;
await una(`/chats/${lonelyChat}/members/${userUn}`, { method: 'DELETE' });
const vicHandle = `vika_ch_${stamp}`;
const vicChannel = await chCreate(vic, { title: 'Канал Вики', handle: vicHandle });
await una(`/channels/${vicHandle}/subscription`, { method: 'PUT' });
const unaPrefs = [await pref(una, 'dm', userVi, { pinned: true }), await pref(una, 'channel', vicHandle, { pinned: true })];
const lonelyPref = await pref(vic, 'chat', lonelyChat, { pinned: true });
const vicMe = (await vic('/auth/me')).body.user;
const mediaBefore = await fetch(BASE.replace('/api', '') + vicPost?.media?.url);
const attachBefore = await una.raw(vicAttach);
check('подготовка: запись с файлом, вложение, группы, канал, настройки', mediaBefore.status === 200 && attachBefore.status === 200 && vicChannel.status === 201 && unaPrefs.every((x) => x.status === 200) && lonelyPref.status === 200 && Boolean(vicMe?.avatarUrl), `${mediaBefore.status} ${attachBefore.status} ${vicChannel.status} ${unaPrefs.map((x) => x.status)} ${lonelyPref.status}`);
r = await una(`/search/posts?q=${encodeURIComponent(`Прощальная ${stamp}`)}`);
check('до удаления её запись находится', r.body.posts?.length === 1, JSON.stringify(r.body));

r = await vic('/account', { method: 'DELETE', body: JSON.stringify({ password: 'ne-tot' }) });
check('без верного пароля — 403', r.status === 403, `${r.status}`);
r = await vic('/account', { method: 'DELETE', body: JSON.stringify({ password: 'parol12345' }) });
check('аккаунт удалён', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
r = await vic('/auth/me');
check('сеанс закрыт', r.body.user === null, JSON.stringify(r.body));
r = await login(makeClient(), 'parol12345', userVi);
check('войти больше нельзя', r.status === 401, `${r.status}`);
r = await una(`/users/${userVi}`);
check('профиля нет', r.status === 404, `${r.status}`);
r = await una(`/posts/${vicPost.id}`);
check('записи нет', r.status === 404, `${r.status}`);
r = await fetch(BASE.replace('/api', '') + vicPost.media.url);
check('файл записи удалён', r.status === 404, `${r.status}`);
r = await fetch(BASE.replace('/api', '') + vicMe.avatarUrl);
check('аватар удалён', r.status === 404, `${r.status}`);
r = await una.raw(vicAttach);
check('вложение ЛС недоступно', r.status === 404, `${r.status}`);
r = await una('/messages');
check('переписка с ней ушла из списка', !r.body.conversations?.some((c) => c.user.username === userVi), '');
r = await una(`/chats/${sharedChat}`);
check('общая группа осталась и перешла Уне', r.status === 200 && r.body.chat?.ownerId !== vicMe.id && r.body.chat?.members?.length === 1, `${r.status} ${JSON.stringify(r.body.chat?.ownerId)}`);
r = await una(`/chats/${sharedChat}/messages`);
check('её реплики ушли, чужие — на месте', r.body.messages?.length === 1 && r.body.messages[0].body === 'Реплика Уны', JSON.stringify(r.body.messages?.map((m) => m.body)));
r = await una(`/channels/${vicHandle}`);
check('её канал удалён', r.status === 404, `${r.status}`);
r = await una(`/search/posts?q=${encodeURIComponent(`Прощальная ${stamp}`)}`);
check('поиск её записей не находит', r.status === 200 && r.body.posts?.length === 0, `${r.status} ${JSON.stringify(r.body)}`);
{
  const rdb = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
  try {
    const lonely = rdb.prepare('SELECT COUNT(*) AS c FROM chats WHERE id = ?').get(lonelyChat).c;
    const prefsLeft = rdb.prepare(`
      SELECT COUNT(*) AS c FROM chat_prefs
      WHERE (kind = 'dm' AND target_id = ?) OR (kind = 'chat' AND target_id = ?)
         OR (kind = 'channel' AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = chat_prefs.target_id))
    `).get(vicMe.id, lonelyChat).c;
    check('чат, где она была одна, удалён', lonely === 0, `${lonely}`);
    check('чужие настройки про неё и её каналы убраны', prefsLeft === 0, `${prefsLeft}`);
  } finally {
    rdb.close();
  }
}

console.log('\n— упоминания —');
const pia = makeClient();
const ron = makeClient();
const sol = makeClient();
const userPi = `pia_${stamp}`;
const userRo = `ron_${stamp}`;
const userSo = `sol_${stamp}`;
await signUp(pia, userPi, 'Пия');
await signUp(ron, userRo, 'Рон');
await signUp(sol, userSo, 'Соль');
r = await pia('/chats', { method: 'POST', body: JSON.stringify({ title: 'Проявка', members: [userRo, userSo] }) });
const mChat = r.body.chat.id;
const mSend = (client, body) => client(`/chats/${mChat}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
const mentionsOf = async (client) => (await client('/chats')).body.chats?.find((c) => c.id === mChat)?.mentions;
const mentionEvents = async (client) => (await client('/notifications')).body.notifications?.filter((x) => x.kind === 'mention') ?? [];

await pref(ron, 'chat', mChat, { muted: true });
r = await mSend(pia, `@${userRo.toUpperCase()}, принесёшь фиксаж? А ты, @${userSo}, — бачок. Почта pia@${userRo}.ru не в счёт.`);
const m1 = r.body.message.id;
check('упоминание в чате отправлено', r.status === 201, `${r.status}`);
check('у упомянутого — «@» в списке', (await mentionsOf(ron)) === 1 && (await mentionsOf(sol)) === 1, `${await mentionsOf(ron)} ${await mentionsOf(sol)}`);
check('у автора — нет', (await mentionsOf(pia)) === 0, `${await mentionsOf(pia)}`);
let evs = await mentionEvents(ron);
check('приглушённому упоминание всё равно приходит', evs.length === 1 && evs[0].message?.id === m1 && evs[0].chat?.id === mChat, JSON.stringify(evs));
check('в событии — цитата сообщения', evs[0]?.message?.excerpt?.startsWith(`@${userRo.toUpperCase()}`), JSON.stringify(evs[0]?.message));
evs = (await ron('/notifications')).body.notifications?.filter((x) => x.kind === 'chat_message') ?? [];
check('а обычного события о сообщении у приглушённого нет', evs.length === 0, JSON.stringify(evs.map((x) => x.kind)));

r = await mSend(pia, `@nobody_${stamp} и @${userPi} — никто из них не участник-другой`);
check('несуществующий и сам автор — без упоминаний', (await mentionsOf(pia)) === 0 && (await mentionEvents(pia)).length === 0, '');

r = await pia(`/chats/${mChat}/messages/${m1}`, { method: 'PATCH', body: JSON.stringify({ body: `@${userRo}, принесёшь фиксаж? И бачок тоже.` }) });
check('правка: у убранного из текста упоминание погасло', (await mentionsOf(sol)) === 0 && (await mentionEvents(sol)).length === 0, `${await mentionsOf(sol)}`);
check('правка: оставшийся не получил второго события', (await mentionEvents(ron)).length === 1 && (await mentionsOf(ron)) === 1, '');

r = await ron(`/chats/${mChat}/messages`);
check('для кнопки «@» — непрочитанные упоминания с первой страницей', JSON.stringify(r.body.unreadMentions) === JSON.stringify([m1]), JSON.stringify(r.body.unreadMentions));
r = await ron(`/chats/${mChat}/messages?cursor=${m1 + 1000}`);
check('на следующих страницах их нет', !('unreadMentions' in r.body), JSON.stringify(Object.keys(r.body)));
r = await pia(`/chats/${mChat}/messages`);
check('у автора — пусто', JSON.stringify(r.body.unreadMentions) === '[]', JSON.stringify(r.body.unreadMentions));
await ron(`/chats/${mChat}/read`, { method: 'PUT' });
check('прочитал — и для «@» пусто', JSON.stringify((await ron(`/chats/${mChat}/messages`)).body.unreadMentions) === '[]', '');
check('прочитал чат — «@» пропал', (await mentionsOf(ron)) === 0, `${await mentionsOf(ron)}`);
evs = await mentionEvents(ron);
check('и событие упоминания прочитано', evs.length === 1 && evs[0].readAt != null, JSON.stringify(evs));

await sol(`/users/${userPi}/block`, { method: 'PUT' });
await mSend(pia, `@${userSo}, ты тут?`);
check('заблокировавшему упоминание не приходит', (await mentionsOf(sol)) === 0 && (await mentionEvents(sol)).length === 0, '');

r = await mSend(pia, `Пересылаю: @${userRo}`);
r = await pia(`/chats/${mChat}/messages`, { method: 'POST', body: JSON.stringify({ forward: { from: 'chat', id: r.body.message.id } }) });
check('в пересланном упоминания не зовут', r.status === 201 && (await mentionEvents(ron)).length === 2, `${r.status} ${(await mentionEvents(ron)).length}`);
const mLast = (await pia(`/chats/${mChat}/messages`)).body.messages.at(-2);
await pia(`/chats/${mChat}/messages/${mLast.id}`, { method: 'DELETE' });
check('удалили сообщение — упоминание и событие ушли', (await mentionsOf(ron)) === 0 && (await mentionEvents(ron)).length === 1, `${await mentionsOf(ron)} ${(await mentionEvents(ron)).length}`);

console.log('\n— опросы —');
// Пия, Рон и Соль из «упоминаний»: Соль заблокировала Пию, поэтому опросы — в новом чате Пии и Рона.
r = await pia('/chats', { method: 'POST', body: JSON.stringify({ title: 'Выбор плёнки', members: [userRo] }) });
const pChat = r.body.chat.id;
const pollPost = (client, poll) => client(`/chats/${pChat}/messages`, { method: 'POST', body: JSON.stringify({ poll }) });
const vote = (client, pollId, options) => client(`/polls/${pollId}/vote`, { method: 'PUT', body: JSON.stringify({ options }) });

r = await guest('/polls/1/vote', { method: 'PUT', body: JSON.stringify({ options: [] }) });
check('голос гостя — 401', r.status === 401, `${r.status}`);
r = await pollPost(pia, { question: 'Какую плёнку берём?', options: ['Kodak Gold', 'Ilford HP5', 'Fomapan'] });
const poll1 = r.body.message?.poll;
const pollMsg = r.body.message?.id;
check('опрос в группе создан: вопрос — текст сообщения', r.status === 201 && r.body.message.body === 'Какую плёнку берём?' && poll1?.options.length === 3, `${r.status} ${JSON.stringify(r.body)}`);
check('по умолчанию анонимный, один ответ, автору видны нули', poll1?.anonymous === true && poll1.multiple === false && poll1.options.every((o) => o.votes === 0) && poll1.canClose === true, JSON.stringify(poll1));

for (const [bodyPoll, name] of [
  [{ question: '', options: ['a', 'b'] }, 'без вопроса'],
  [{ question: 'Один?', options: ['только'] }, 'один вариант'],
  [{ question: 'Много?', options: Array.from({ length: 11 }, (_, i) => `в${i}`) }, 'одиннадцать вариантов'],
  [{ question: 'Повтор?', options: ['Да', 'да'] }, 'повтор варианта'],
  [{ question: 'Флаг?', options: ['a', 'b'], multiple: 'yes' }, 'кривой флаг'],
]) {
  r = await pollPost(pia, bodyPoll);
  check(`опрос: ${name} — 400`, r.status === 400, `${r.status}`);
}

r = await ron(`/chats/${pChat}/messages`);
let seenPoll = r.body.messages?.find((m) => m.id === pollMsg)?.poll;
check('до голоса участник не видит результатов', seenPoll && seenPoll.options.every((o) => o.votes === null) && seenPoll.canClose === false, JSON.stringify(seenPoll));
r = await vote(ron, poll1.id, [poll1.options[0].id, poll1.options[1].id]);
check('два ответа в опросе с одним — 400', r.status === 400, `${r.status}`);
r = await vote(ron, poll1.id, [999999]);
check('чужой вариант — 400', r.status === 400, `${r.status}`);
r = await vote(ron, poll1.id, [poll1.options[1].id]);
check('голос принят, результаты открылись', r.status === 200 && r.body.poll.options[1].votes === 1 && r.body.poll.total === 1 && r.body.poll.myVotes[0] === poll1.options[1].id, JSON.stringify(r.body));
check('в анонимном — без имён', r.body.poll.options.every((o) => o.voters.length === 0), JSON.stringify(r.body.poll));
r = await vote(ron, poll1.id, [poll1.options[2].id]);
check('переголосовать — голос заменяется', r.body.poll.options[1].votes === 0 && r.body.poll.options[2].votes === 1 && r.body.poll.total === 1, JSON.stringify(r.body.poll));
r = await vote(ron, poll1.id, []);
check('отозвать голос — результаты снова скрыты', r.status === 200 && r.body.poll.myVotes.length === 0 && r.body.poll.options.every((o) => o.votes === null), JSON.stringify(r.body.poll));
r = await vote(sol, poll1.id, [poll1.options[0].id]);
check('не участник — 404', r.status === 404, `${r.status}`);

r = await pollPost(pia, { question: 'Когда встречаемся?', options: ['Суббота', 'Воскресенье'], multiple: true, anonymous: false });
const poll2 = r.body.message.poll;
r = await vote(ron, poll2.id, [poll2.options[0].id, poll2.options[1].id]);
check('несколько ответов и открытое голосование — видно, кто за что', r.status === 200 && r.body.poll.options.every((o) => o.votes === 1 && o.voters[0]?.username === userRo), JSON.stringify(r.body.poll));
r = await vote(pia, poll2.id, [poll2.options[0].id]);
check('считаются люди, а не голоса', r.body.poll.total === 2 && r.body.poll.options[0].votes === 2, JSON.stringify(r.body.poll));

r = await ron(`/polls/${poll2.id}/close`, { method: 'PUT' });
check('завершить чужой опрос — 403', r.status === 403, `${r.status}`);
r = await pia(`/polls/${poll2.id}/close`, { method: 'PUT' });
check('автор завершил опрос', r.status === 200 && r.body.poll.closed === true && r.body.poll.canClose === false, JSON.stringify(r.body.poll));
r = await vote(ron, poll2.id, [poll2.options[1].id]);
check('в завершённом голосовать нельзя', r.status === 400, `${r.status}`);

r = await pia(`/chats/${pChat}/messages/${pollMsg}`, { method: 'PATCH', body: JSON.stringify({ body: 'Другой вопрос' }) });
check('опрос не редактируется', r.status === 403, `${r.status}`);
r = await ron(`/chats/${pChat}/messages`, { method: 'POST', body: JSON.stringify({ forward: { from: 'chat', id: pollMsg } }) });
check('опрос не пересылается', r.status === 400, `${r.status}`);
r = await ron('/chats');
check('в списке чатов у превью есть опрос', r.body.chats?.find((c) => c.id === pChat)?.lastMessage?.poll?.closed === true, '');

r = await chCreate(pia, { title: 'Опросы Пии', handle: `pia_polls_${stamp}` });
const pollHandle = r.body.channel?.handle;
r = await pia(`/channels/${pollHandle}/posts`, { method: 'POST', body: JSON.stringify({ poll: { question: 'Что снимать дальше?', options: ['Город', 'Портреты'] } }) });
const chPoll = r.body.post?.poll;
check('опрос в канале — от владельца', r.status === 201 && chPoll?.options.length === 2 && chPoll.canClose === true, `${r.status} ${JSON.stringify(r.body)}`);
r = await vote(ron, chPoll.id, [chPoll.options[1].id]);
check('в канале голосует любой читатель', r.status === 200 && r.body.poll.options[1].votes === 1, `${r.status}`);

await pia(`/chats/${pChat}/messages/${pollMsg}`, { method: 'DELETE' });
r = await vote(ron, poll1.id, [poll1.options[0].id]);
check('удалили сообщение — опроса нет', r.status === 404, `${r.status}`);

console.log('\n— отложенные сообщения —');
// Сервер для прогона поднят с SCHEDULE_TICK_MS=500 — планировщик ходит дважды в секунду.
const later = (ms) => new Date(Date.now() + ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const schedule = (client, payload) => client('/scheduled', { method: 'POST', body: JSON.stringify(payload) });
const queued = async (client, kind, target) =>
  (await client(`/scheduled?kind=${kind}&target=${encodeURIComponent(target)}`)).body.scheduled ?? [];
const dmBodies = async (client, other) => (await client(`/messages/${other}`)).body.messages?.map((m) => m.body) ?? [];

r = await guest('/scheduled?kind=dm&target=x');
check('гостю — 401', r.status === 401, `${r.status}`);
r = await schedule(pia, { kind: 'dm', target: userRo, body: 'Не забудь фиксаж!', sendAt: later(60 * 60_000) });
const s1 = r.body.scheduled;
check('отложено в личку', r.status === 201 && s1?.body === 'Не забудь фиксаж!' && s1.kind === 'dm', `${r.status} ${JSON.stringify(r.body)}`);
check('в очереди у автора', (await queued(pia, 'dm', userRo)).some((x) => x.id === s1.id), '');
check('получатель ещё ничего не видит', !(await dmBodies(ron, userPi)).includes('Не забудь фиксаж!'), '');

for (const [payload, name, code] of [
  [{ kind: 'dm', target: userRo, body: 'x', sendAt: later(-60_000) }, 'время в прошлом', 400],
  [{ kind: 'dm', target: userRo, body: 'x', sendAt: later(400 * 864e5) }, 'дальше года', 400],
  [{ kind: 'dm', target: userRo, body: 'x', sendAt: 'завтра' }, 'кривое время', 400],
  [{ kind: 'dm', target: userRo, body: '   ', sendAt: later(60_000) }, 'пустой текст', 400],
  [{ kind: 'sms', target: userRo, body: 'x', sendAt: later(60_000) }, 'неизвестный вид', 400],
  [{ kind: 'dm', target: `nobody_${stamp}`, body: 'x', sendAt: later(60_000) }, 'несуществующему', 404],
  [{ kind: 'chat', target: mChat, body: 'x', sendAt: later(60_000) }, 'в чужой чат', 404],
]) {
  r = await schedule(name === 'в чужой чат' ? tom : pia, payload);
  check(`отложить: ${name} — ${code}`, r.status === code, `${r.status}`);
}
r = await schedule(ron, { kind: 'channel', target: pollHandle, body: 'x', sendAt: later(60_000) });
check('в чужой канал — 404', r.status === 404, `${r.status}`);

r = await pia(`/scheduled/${s1.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'Не забудь фиксаж и бачок!' }) });
check('текст изменён, время то же', r.status === 200 && r.body.scheduled.body === 'Не забудь фиксаж и бачок!' && r.body.scheduled.sendAt === s1.sendAt, JSON.stringify(r.body));
r = await ron(`/scheduled/${s1.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'взлом' }) });
check('чужое не править — 404', r.status === 404, `${r.status}`);
r = await ron(`/scheduled/${s1.id}`, { method: 'DELETE' });
check('и не удалить — 404', r.status === 404, `${r.status}`);
r = await ron(`/scheduled/${s1.id}/send`, { method: 'POST' });
check('и не отправить — 404', r.status === 404, `${r.status}`);

r = await pia(`/scheduled/${s1.id}/send`, { method: 'POST' });
check('«отправить сейчас»', r.status === 200 && Number.isInteger(r.body.messageId), `${r.status}`);
check('получатель видит сообщение', (await dmBodies(ron, userPi)).includes('Не забудь фиксаж и бачок!'), '');
check('очередь пуста', (await queued(pia, 'dm', userRo)).length === 0, '');

await schedule(pia, { kind: 'dm', target: userRo, body: 'Сработал планировщик', sendAt: later(700) });
r = await schedule(pia, { kind: 'dm', target: userRo, body: 'Удалю до отправки', sendAt: later(700) });
await pia(`/scheduled/${r.body.scheduled.id}`, { method: 'DELETE' });
await sleep(2000);
let got = await dmBodies(ron, userPi);
check('планировщик отправил в срок', got.includes('Сработал планировщик'), JSON.stringify(got.slice(-3)));
check('удалённое не ушло', !got.includes('Удалю до отправки'), '');
check('у получателя — событие о сообщении', (await ron('/notifications')).body.notifications?.some((x) => x.kind === 'message' && x.actor.username === userPi), '');

await schedule(pia, { kind: 'chat', target: pChat, body: `@${userRo}, завтра в десять!`, sendAt: later(700) });
await schedule(pia, { kind: 'channel', target: pollHandle, body: 'Анонс по расписанию', sendAt: later(700) });
await schedule(pia, { kind: 'dm', target: userPi, body: 'Напоминание себе', sendAt: later(700) });
await sleep(2000);
r = await ron(`/chats/${pChat}/messages`);
check('в группу ушло, с упоминанием', r.body.messages?.at(-1)?.body === `@${userRo}, завтра в десять!` && (await ron('/chats')).body.chats.find((c) => c.id === pChat)?.mentions === 1, '');
r = await ron(`/channels/${pollHandle}/posts`);
check('в канал ушло', r.body.posts?.at(-1)?.body === 'Анонс по расписанию', JSON.stringify(r.body.posts?.map((x) => x.body)));
r = await pia(`/messages/${userPi}`);
check('в «Избранное» — сразу прочитано', r.body.messages?.at(-1)?.body === 'Напоминание себе' && r.body.messages.at(-1).readAt != null, '');

// Доступ проверяется при отправке: заблокировали — сообщение отменяется.
await schedule(pia, { kind: 'dm', target: userRo, body: 'Не должно дойти', sendAt: later(700) });
r = await schedule(pia, { kind: 'dm', target: userRo, body: 'И это тоже', sendAt: later(60 * 60_000) });
const s2 = r.body.scheduled.id;
await ron(`/users/${userPi}/block`, { method: 'PUT' });
await sleep(2000);
check('после блокировки не дошло', !(await dmBodies(ron, userPi)).includes('Не должно дойти'), '');
r = await pia(`/scheduled/${s2}/send`, { method: 'POST' });
check('«отправить сейчас» при блокировке — 403, очередь чиста', r.status === 403 && (await pia(`/scheduled/${s2}`, { method: 'DELETE' })).status === 404, `${r.status}`);
await ron(`/users/${userPi}/block`, { method: 'DELETE' });

console.log('\n— стикеры —');
const stick = (client, path, payload) => client(path, { method: 'POST', body: JSON.stringify(payload) });

r = await stick(pia, `/messages/${userRo}`, { sticker: 'plenka/hi' });
const st1 = r.body.message;
check('стикер в личку', r.status === 201 && st1?.sticker === 'plenka/hi' && st1.body === '', `${r.status} ${JSON.stringify(r.body)}`);
r = await ron(`/messages/${userPi}`);
check('получатель видит стикер', r.body.messages?.some((m) => m.id === st1.id && m.sticker === 'plenka/hi'), '');
r = await stick(pia, `/messages/${userRo}`, { sticker: 'plenka/nope' });
check('чужой стикер — 400', r.status === 400, `${r.status}`);
r = await stick(pia, `/messages/${userRo}`, { sticker: '../../etc/passwd' });
check('имя-путь — 400', r.status === 400, `${r.status}`);
r = await stick(pia, `/messages/${userRo}`, { sticker: 'plenka/ok', body: 'и текст' });
check('стикер с текстом — 400', r.status === 400, `${r.status}`);
r = await pia(`/messages/${userRo}/${st1.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'правка' }) });
check('стикер не правится', r.status === 403, `${r.status}`);

r = await ron(`/messages/${userPi}`, { method: 'POST', body: JSON.stringify({ body: 'Мне нравится!', replyTo: st1.id }) });
check('ответ на стикер цитирует «Стикер»', r.body.message?.replyTo?.body === 'Стикер', JSON.stringify(r.body.message?.replyTo));

r = await stick(pia, `/chats/${pChat}/messages`, { sticker: 'mood/party' });
const st2 = r.body.message;
check('стикер в группу', r.status === 201 && st2?.sticker === 'mood/party', `${r.status}`);
r = await ron(`/chats/${pChat}/messages`, { method: 'POST', body: JSON.stringify({ forward: { from: 'chat', id: st2.id } }) });
check('пересланный стикер остаётся стикером', r.status === 201 && r.body.message?.sticker === 'mood/party' && r.body.message.forwardedFrom?.username === userPi, `${r.status} ${JSON.stringify(r.body.message)}`);
r = await ron(`/messages/${userRo}`, { method: 'POST', body: JSON.stringify({ forward: { from: 'chat', id: st2.id } }) });
check('и в «Избранное» — тоже', r.status === 201 && r.body.message?.sticker === 'mood/party', `${r.status}`);
r = await ron(`/messages/${userPi}`);
check('обычные сообщения — без стикера', r.body.messages?.filter((m) => !m.sticker).every((m) => m.sticker === null), '');

console.log('\n— живой поток событий —');
/** Слушает /api/events клиента: копит события, умеет ждать нужное. */
async function listen(client) {
  const res = await client.raw('/api/events');
  const events = [];
  const state = { status: res.status, closed: false, events };
  if (res.status !== 200) return state;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {
      // оборвали сами — это и есть конец
    }
    state.closed = true;
  })();
  state.stop = () => reader.cancel().catch(() => undefined);
  state.waitFor = async (pred, ms = 1500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const found = events.find(pred);
      if (found) return found;
      await sleep(25);
    }
    return null;
  };
  state.waitClosed = async (ms = 1500) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !state.closed) await sleep(25);
    return state.closed;
  };
  return state;
}

const piaId = (await pia('/auth/me')).body.user.id;
let stream = await listen(guest);
check('поток гостю — 401', stream.status === 401, `${stream.status}`);

const ronLive = await listen(ron);
const solLive = await listen(sol);
check('поток открылся и поздоровался', ronLive.status === 200 && Boolean(await ronLive.waitFor((e) => e.t === 'ready')), `${ronLive.status}`);

await dmSend(pia, userRo, { body: 'Ты тут?' });
check('новое сообщение — толчок «переписка с Пией»', Boolean(await ronLive.waitFor((e) => e.t === 'dm' && e.with === piaId)), JSON.stringify(ronLive.events));
check('и толчок счётчиков — появилось событие', Boolean(await ronLive.waitFor((e) => e.t === 'badges')), '');

ronLive.events.length = 0;
await pia(`/messages/${userRo}/typing`, { method: 'PUT' });
check('«печатает…» — тоже толчок', Boolean(await ronLive.waitFor((e) => e.t === 'dm' && e.with === piaId)), '');

ronLive.events.length = 0;
await pia(`/chats/${pChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Сбор в десять' }) });
check('сообщение в группе — толчок участнику', Boolean(await ronLive.waitFor((e) => e.t === 'chat' && e.id === pChat)), JSON.stringify(ronLive.events));
check('не участнику — ничего', !(await solLive.waitFor((e) => e.t === 'chat' && e.id === pChat, 400)), '');

ronLive.events.length = 0;
r = await pia(`/chats/${pChat}/messages`, { method: 'POST', body: JSON.stringify({ body: '' }) });
check('неудачный запрос никого не толкает', r.status === 400 && !(await ronLive.waitFor((e) => e.t === 'chat', 400)), `${r.status}`);

await pia(`/chats/${pChat}/members/${userRo}`, { method: 'DELETE' });
check('убранный из группы узнаёт об этом', Boolean(await ronLive.waitFor((e) => e.t === 'chat' && e.id === pChat)), '');

const ron2 = makeClient();
await ron2('/auth/login', { method: 'POST', body: JSON.stringify({ username: userRo, password: 'parol12345' }) });
const ron2Live = await listen(ron2);
await ron2Live.waitFor((e) => e.t === 'ready');
await ron('/account/sessions', { method: 'DELETE' });
check('завершили сеанс — его поток закрыт', await ron2Live.waitClosed(), '');
await ron('/auth/logout', { method: 'POST' });
check('вышли — поток закрыт', await ronLive.waitClosed(), '');
solLive.stop();

console.log('\n— push-уведомления —');
// Своя «служба доставки» на localhost: принимает письмо сервера и
// расшифровывает его ключом подписчика (aes128gcm, RFC 8291), как браузер.
const { createServer } = await import('node:http');
const { createECDH, createDecipheriv, hkdfSync } = await import('node:crypto');

const inbox = [];
let pushStatus = 201;
const pushService = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    inbox.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(pushStatus).end();
  });
});
await new Promise((resolve) => pushService.listen(0, '127.0.0.1', resolve));
const pushPort = pushService.address().port;

const ua = createECDH('prime256v1');
ua.generateKeys();
const uaPublic = ua.getPublicKey();
const authSecret = randomBytes(16);

function decryptPush(body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
}
const waitInbox = async (n, ms = 1500) => {
  const until = Date.now() + ms;
  while (Date.now() < until && inbox.length < n) await sleep(25);
  return inbox.length >= n;
};

const pa = makeClient();
const pb = makeClient();
const userPa = `pusha_${stamp}`;
const userPb = `pushb_${stamp}`;
await signUp(pa, userPa, 'Пуш А');
await signUp(pb, userPb, 'Пуш Б');
const pbId = (await pb('/auth/me')).body.user.id;
const subscribe = (client, endpoint, keys = { p256dh: uaPublic.toString('base64url'), auth: authSecret.toString('base64url') }) =>
  client('/push/subscription', { method: 'PUT', body: JSON.stringify({ endpoint, keys }) });
const subsOf = (endpoint) => {
  const rdb = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
  try {
    return rdb.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE endpoint = ?').get(endpoint).c;
  } finally {
    rdb.close();
  }
};

r = await guest('/push/key');
check('ключ сервера — гостю 401', r.status === 401, `${r.status}`);
r = await pa('/push/key');
check('открытый ключ VAPID', r.status === 200 && /^[A-Za-z0-9_-]{80,}$/.test(r.body.publicKey ?? ''), JSON.stringify(r.body));
r = await subscribe(pa, 'https://evil.example.com/push');
check('чужой адрес вместо службы доставки — 400', r.status === 400, `${r.status}`);
r = await subscribe(pa, 'http://169.254.169.254/latest');
check('внутренний адрес — 400', r.status === 400, `${r.status}`);
r = await subscribe(pa, `http://127.0.0.1:${pushPort}/a`, { p256dh: 'не ключ!', auth: 'x' });
check('повреждённые ключи — 400', r.status === 400, `${r.status}`);

const endpointA = `http://127.0.0.1:${pushPort}/a`;
r = await subscribe(pa, endpointA);
check('подписка устройства сохранена', r.status === 200 && subsOf(endpointA) === 1, `${r.status}`);

await dmSend(pb, userPa, { body: 'Привет из пуша' });
check('без открытой вкладки — пуш ушёл в службу доставки', await waitInbox(1), `${inbox.length}`);
const sent = inbox[0];
check('письмо подписано VAPID и зашифровано aes128gcm', sent?.headers.authorization?.startsWith('vapid t=') && sent.headers['content-encoding'] === 'aes128gcm' && sent.headers.ttl === '86400', JSON.stringify(sent?.headers));
let payload = null;
try {
  payload = decryptPush(sent.body);
} catch (err) {
  payload = { error: err.message };
}
check('расшифровывается ключом подписчика: кто, что и куда', payload?.title === 'Пуш Б' && payload.body === 'Привет из пуша' && payload.url === `/messages/${userPb}` && payload.tag === `dm-${pbId}`, JSON.stringify(payload));

const paLive = await listen(pa);
await paLive.waitFor((e) => e.t === 'ready');
await dmSend(pb, userPa, { body: 'Вкладка открыта' });
await sleep(600);
check('при открытой вкладке пуша нет — хватает живого потока', inbox.length === 1, `${inbox.length}`);
paLive.stop();
await sleep(300);

pushStatus = 410;
await dmSend(pb, userPa, { body: 'Подписку отозвали' });
await waitInbox(2);
await sleep(200);
check('служба ответила 410 — подписка удалена', subsOf(endpointA) === 0, `${subsOf(endpointA)}`);

pushStatus = 201;
await subscribe(pa, endpointA);
await pa('/auth/logout', { method: 'POST' });
check('вышли на устройстве — его подписка ушла вместе с сеансом', subsOf(endpointA) === 0, `${subsOf(endpointA)}`);

// О входе в аккаунт пуш уходит, даже когда вкладка открыта: чужой вход
// важнее тишины.
const endpointB = `http://127.0.0.1:${pushPort}/b`;
await subscribe(pb, endpointB);
const pbLive = await listen(pb);
await pbLive.waitFor((e) => e.t === 'ready');
const sentBefore = inbox.length;
await makeClient()('/auth/login', { method: 'POST', body: JSON.stringify({ username: userPb, password: 'parol12345' }) });
check('вход в аккаунт — пуш даже при открытой вкладке', await waitInbox(sentBefore + 1), `${inbox.length}`);
let loginPush = null;
try {
  loginPush = decryptPush(inbox.at(-1).body);
} catch (err) {
  loginPush = { error: err.message };
}
check('в пуше о входе — устройство и путь в настройки', loginPush?.title === 'Вход в аккаунт' && loginPush.url === '/settings' && /^Неизвестное устройство\. Если это были не вы/.test(loginPush.body ?? ''), JSON.stringify(loginPush));
pbLive.stop();

// «Без звука»: событие и пуш есть, но пуш с флагом silent — не звенит.
await sleep(300);
await pa('/auth/login', { method: 'POST', body: JSON.stringify({ username: userPa, password: 'parol12345' }) });
let quietFrom = inbox.length;
await dmSend(pa, userPb, { body: 'Тихо, все спят', silent: true });
await waitInbox(quietFrom + 1);
let quiet = null;
try {
  quiet = decryptPush(inbox.at(-1).body);
} catch (err) {
  quiet = { error: err.message };
}
check('«без звука» — пуш приходит, но с silent', inbox.length === quietFrom + 1 && quiet?.silent === true && quiet.body === 'Тихо, все спят', JSON.stringify(quiet));
quietFrom = inbox.length;
await dmSend(pa, userPb, { body: 'А теперь громко' });
await waitInbox(quietFrom + 1);
try {
  quiet = decryptPush(inbox.at(-1).body);
} catch (err) {
  quiet = { error: err.message };
}
check('обычное — без silent', quiet?.body === 'А теперь громко' && !('silent' in quiet), JSON.stringify(quiet));
r = await pa(`/chats`, { method: 'POST', body: JSON.stringify({ title: 'Тихая группа', members: [userPb] }) });
const silentChat = r.body.chat.id;
quietFrom = inbox.length;
r = await pa(`/chats/${silentChat}/messages`, { method: 'POST', body: JSON.stringify({ body: `@${userPb}, без звука`, silent: true }) });
await waitInbox(quietFrom + 3);
// Пуш о приглашении в чат приходит своим чередом — смотрим только на тихое сообщение.
const quietPushes = inbox.slice(quietFrom).map((x) => { try { return decryptPush(x.body); } catch { return {}; } })
  .filter((x) => x.body?.includes('без звука'));
check('в группе «без звука» — и сообщение, и упоминание тихие', quietPushes.length === 2 && quietPushes.every((x) => x.silent === true), JSON.stringify(quietPushes));
pushService.close();

console.log('\n— вход и регистрация по номеру —');
// Поддельный Twilio: сервер поднят с SMS_PROVIDER=twilio и TWILIO_API_BASE на
// этот порт (см. README, «Тесты»). Тест читает коды из «отправленных» SMS —
// так проверяется настоящий путь отправки, а не обходная дверь.
const smsBox = [];
let smsStatus = 201;
const fakeTwilio = createServer((req, res) => {
  const chunks = [];
  req.on('data', (ch) => chunks.push(ch));
  req.on('end', () => {
    smsBox.push({ path: req.url, auth: req.headers.authorization, form: new URLSearchParams(Buffer.concat(chunks).toString()) });
    res.writeHead(smsStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify(smsStatus < 300 ? { sid: 'SMfake' } : { message: 'поддельная ошибка' }));
  });
});
await new Promise((resolve) => fakeTwilio.listen(Number(process.env.FAKE_SMS_PORT ?? 3097), '127.0.0.1', resolve));
const RESEND_WAIT = Number(process.env.SMS_RESEND_MS ?? 1500) + 200;

const lastCode = (phone) => {
  const sms = [...smsBox].reverse().find((s) => s.form.get('To') === phone);
  return sms?.form.get('Body').match(/код (\d{6})/)?.[1] ?? null;
};
const tail = String(Date.now()).slice(-7);
const phoneNew = `+9965${tail}1`;
const phoneOther = `+9965${tail}2`;
const phoneFail = `+9965${tail}3`;
const start = (client, phone) => client('/auth/phone/start', { method: 'POST', body: JSON.stringify({ phone }) });
const verify = (client, phone, code) => client('/auth/phone/verify', { method: 'POST', body: JSON.stringify({ phone, code }) });
const wrongOf = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

r = await start(anon, '123');
check('номер не в международном формате — 400', r.status === 400, `${r.status}`);
const ph = makeClient();
r = await start(ph, `+996 (5${tail.slice(0, 2)}) ${tail.slice(2, 4)}-${tail.slice(4)}-1`);
check('код отправлен, номер приведён к E.164', r.status === 200 && r.body.phone === phoneNew && r.body.expiresIn === 300, `${r.status} ${JSON.stringify(r.body)}`);
const sms1 = smsBox.at(-1);
check('SMS ушло через Twilio: учётка, отправитель, получатель', sms1?.path === '/2010-04-01/Accounts/ACsmoke/Messages.json'
  && sms1.auth === `Basic ${Buffer.from('ACsmoke:smoke-token').toString('base64')}` && sms1.form.get('From') === '+15550000000' && sms1.form.get('To') === phoneNew, JSON.stringify({ path: sms1?.path, to: sms1?.form.get('To') }));
const code1 = lastCode(phoneNew);
check('в SMS — шестизначный код', /^\d{6}$/.test(code1 ?? ''), sms1?.form.get('Body'));
r = await start(ph, phoneNew);
check('повторный код сразу — 429', r.status === 429, `${r.status}`);

r = await verify(ph, phoneNew, wrongOf(code1));
check('неверный код — 400 и сколько попыток осталось', r.status === 400 && /Осталось попыток: 4/.test(r.body.error), JSON.stringify(r.body));
r = await verify(ph, phoneNew, code1);
check('верный код для нового номера — к регистрации', r.status === 200 && r.body.status === 'signup' && typeof r.body.ticket === 'string', JSON.stringify(r.body));
const signupTicket = r.body.ticket;
r = await verify(ph, phoneNew, code1);
check('тот же код второй раз не проходит', r.status === 400, `${r.status}`);

const signup = (client, ticket, username, displayName = 'Телефон') =>
  client('/auth/phone/signup', { method: 'POST', body: JSON.stringify({ ticket, username, displayName }) });
r = await signup(ph, signupTicket, 'ЮзерКириллица');
check('кириллица в логине — 400', r.status === 400, `${r.status}`);
r = await signup(ph, signupTicket, userA.toUpperCase());
check('занятый логин (в другом регистре) — 409', r.status === 409, `${r.status}`);
r = await signup(ph, 'выдуманный-билет', `tel_${stamp}`);
check('чужой билет — 400', r.status === 400, `${r.status}`);
const userTel = `tel_${stamp}`;
r = await signup(ph, signupTicket, userTel, 'Тел Телефонов');
check('регистрация по номеру — 201 и сразу вход', r.status === 201 && r.body.user?.username === userTel && (await ph('/auth/me')).body.user?.username === userTel, JSON.stringify(r.body));
r = await ph('/account');
check('в настройках — номер, без пароля и без входа по логину', r.body.phone === phoneNew && r.body.hasPassword === false && r.body.passwordLogin === false && r.body.email === null, JSON.stringify(r.body));
check('без галочки по номеру не находят и номер никому не виден', r.body.phoneFind === 'nobody' && r.body.phoneShow === 'nobody', JSON.stringify(r.body));
r = await ph('/notifications');
check('регистрация по номеру не шлёт «вход в аккаунт»', r.body.notifications?.length === 0, JSON.stringify(r.body.notifications));
r = await signup(makeClient(), signupTicket, `tel2_${stamp}`);
check('билет одноразовый', r.status === 400, `${r.status}`);
r = await anon('/auth/login', { method: 'POST', body: JSON.stringify({ username: userTel, password: '' }) });
check('по логину аккаунт по номеру не входит', r.status === 401, `${r.status}`);

// Вход тем же номером — сразу внутрь, пароля нет.
await sleep(RESEND_WAIT);
const ph2 = makeClient();
await start(ph2, phoneNew);
r = await verify(ph2, phoneNew, lastCode(phoneNew));
check('знакомый номер без пароля — сразу вход', r.body.status === 'signed-in' && r.body.user?.username === userTel && (await ph2('/auth/me')).body.user?.username === userTel, JSON.stringify(r.body));
r = await ph('/notifications');
check('вход по номеру — событие на остальных устройствах', r.body.notifications?.[0]?.kind === 'new_login' && r.body.unread === 1, JSON.stringify(r.body.notifications));

// Двухэтапная проверка: пароль задаётся без текущего (его нет), дальше — после кода.
r = await ph('/account/password', { method: 'PUT', body: JSON.stringify({ newPassword: 'dvuhetap12' }) });
check('задать пароль впервые — без текущего', r.status === 200 && (await ph('/account')).body.hasPassword === true, `${r.status} ${JSON.stringify(r.body)}`);
await sleep(RESEND_WAIT);
const ph3 = makeClient();
await start(ph3, phoneNew);
r = await verify(ph3, phoneNew, lastCode(phoneNew));
check('с паролем — после кода спрашивают его', r.body.status === 'password' && typeof r.body.ticket === 'string' && (await ph3('/auth/me')).body.user === null, JSON.stringify(r.body));
const pwTicket = r.body.ticket;
r = await ph3('/auth/phone/password', { method: 'POST', body: JSON.stringify({ ticket: pwTicket, password: 'ne-tot-parol' }) });
check('неверный пароль — 403', r.status === 403, `${r.status}`);
r = await ph3('/auth/phone/password', { method: 'POST', body: JSON.stringify({ ticket: pwTicket, password: 'dvuhetap12' }) });
check('верный пароль — вход', r.status === 200 && (await ph3('/auth/me')).body.user?.username === userTel, `${r.status}`);
r = await anon('/auth/login', { method: 'POST', body: JSON.stringify({ username: userTel, password: 'dvuhetap12' }) });
check('пароль — второй шаг, а не вход по логину', r.status === 401, `${r.status}`);
r = await ph('/account/password', { method: 'DELETE', body: JSON.stringify({ currentPassword: 'ne-tot' }) });
check('выключить проверку без верного пароля — 403', r.status === 403, `${r.status}`);
r = await ph('/account/password', { method: 'DELETE', body: JSON.stringify({ currentPassword: 'dvuhetap12' }) });
check('выключить двухэтапную проверку', r.status === 200 && (await ph('/account')).body.hasPassword === false, `${r.status}`);
// Старый аккаунт — логин, почта, пароль, как до входа по номеру.
const oldie = makeClient();
await legacySignUp(oldie, `oldie_${stamp}`, 'Старожил');
r = await oldie('/account/password', { method: 'DELETE', body: JSON.stringify({ currentPassword: 'parol12345' }) });
check('у старого аккаунта пароль не убрать — это его вход', r.status === 400, `${r.status}`);

// Старый аккаунт привязывает номер.
r = await oldie('/account/phone/start', { method: 'POST', body: JSON.stringify({ phone: phoneNew }) });
check('чужой номер не привязать — 409', r.status === 409, `${r.status}`);
r = await oldie('/account/phone/start', { method: 'POST', body: JSON.stringify({ phone: phoneOther }) });
check('код на новый номер старого аккаунта', r.status === 200 && Boolean(lastCode(phoneOther)), `${r.status}`);
r = await oldie('/account/phone', { method: 'PUT', body: JSON.stringify({ phone: phoneOther, code: wrongOf(lastCode(phoneOther)) }) });
check('неверный код привязки — 400', r.status === 400, `${r.status}`);
r = await oldie('/account/phone', { method: 'PUT', body: JSON.stringify({ phone: phoneOther, code: lastCode(phoneOther) }) });
check('номер привязан', r.status === 200 && (await oldie('/account')).body.phone === phoneOther, `${r.status}`);
await sleep(RESEND_WAIT);
const aPhone = makeClient();
await start(aPhone, phoneOther);
r = await verify(aPhone, phoneOther, lastCode(phoneOther));
check('старый аккаунт входит и по номеру — с паролем вторым шагом', r.body.status === 'password', JSON.stringify(r.body));
r = await oldie('/account/phone', { method: 'DELETE' });
check('старый аккаунт может отвязать номер', r.status === 200 && (await oldie('/account')).body.phone === null, `${r.status}`);
r = await ph('/account/phone', { method: 'DELETE' });
check('у аккаунта по номеру номер не убрать', r.status === 400, `${r.status}`);

// Провайдер упал — честная ошибка, и код не «съеден».
smsStatus = 500;
r = await start(makeClient(), phoneFail);
check('SMS не ушло — 502', r.status === 502, `${r.status}`);
smsStatus = 201;
r = await start(makeClient(), phoneFail);
check('неудачная отправка не блокирует повтор', r.status === 200, `${r.status}`);
const failCode = lastCode(phoneFail);
for (let i = 0; i < 5; i++) await verify(anon, phoneFail, wrongOf(failCode));
r = await verify(anon, phoneFail, failCode);
check('после пяти промахов и верный код не принимается', r.status === 400 && /Слишком много попыток/.test(r.body.error), JSON.stringify(r.body));

// Удаление аккаунта без пароля — кодом из SMS.
r = await ph('/account/delete-code', { method: 'POST' });
check('код для удаления', r.status === 200, `${r.status}`);
const delCode = lastCode(phoneNew);
r = await ph('/account', { method: 'DELETE', body: JSON.stringify({ code: wrongOf(delCode) }) });
check('неверный код удаления — 400', r.status === 400, `${r.status}`);
r = await ph('/account', { method: 'DELETE', body: JSON.stringify({ code: delCode }) });
check('аккаунт по номеру удалён по коду', r.status === 200 && (await ph('/auth/me')).body.user === null, `${r.status}`);
r = await oldie('/account/delete-code', { method: 'POST' });
check('у аккаунта с паролем — удаление паролем, а не кодом', r.status === 400, `${r.status}`);

// Галочка «находить меня по номеру» при регистрации.
const phoneFindable = `+9965${tail}4`;
const fin = makeClient();
await start(fin, phoneFindable);
r = await verify(fin, phoneFindable, lastCode(phoneFindable));
r = await fin('/auth/phone/signup', { method: 'POST', body: JSON.stringify({ ticket: r.body.ticket, username: `fin_${stamp}`, displayName: 'Находимый', findable: true }) });
check('регистрация с галочкой «находить по номеру»', r.status === 201 && (await fin('/account')).body.phoneFind === 'all', `${r.status}`);
r = await oldie('/users/by-phone', { method: 'POST', body: JSON.stringify({ phones: [phoneFindable] }) });
check('такого находят по номеру', r.body.users?.length === 1 && r.body.users[0].username === `fin_${stamp}`, JSON.stringify(r.body));

// Вход по номеру, когда включён код из приложения: SMS — и ещё шесть цифр.
r = await fin('/account/2fa/setup', { method: 'POST', body: '{}' });
check('аккаунт без пароля подключает код без пароля', r.status === 200 && typeof r.body.secret === 'string', `${r.status} ${JSON.stringify(r.body)}`);
const finSecret = r.body.secret;
r = await fin('/account/2fa/enable', { method: 'POST', body: JSON.stringify({ code: totpCode(finSecret) }) });
check('код включён — десять резервных кодов', r.status === 200 && r.body.backupCodes?.length === 10, `${r.status}`);
const finAgain = makeClient();
await new Promise((ok) => setTimeout(ok, RESEND_WAIT));
await start(finAgain, phoneFindable);
r = await verify(finAgain, phoneFindable, lastCode(phoneFindable));
check('после SMS — шаг с кодом, сеанса ещё нет', r.body.status === 'two-factor' && typeof r.body.ticket === 'string'
  && (await finAgain('/auth/me')).body.user === null, JSON.stringify(r.body));
r = await finAgain('/auth/2fa', { method: 'POST', body: JSON.stringify({ ticket: r.body.ticket, code: totpCode(finSecret, 1) }) });
check('код из приложения — и вход', r.status === 200 && r.body.user?.username === `fin_${stamp}` && (await finAgain('/auth/me')).body.user?.username === `fin_${stamp}`,
  `${r.status} ${JSON.stringify(r.body)}`);
fakeTwilio.close();

console.log('\n— уведомление о новом входе —');
const home = makeClient();
const userHome = `home_${stamp}`;
await legacySignUp(home, userHome, 'Домосед');
const homeId = (await home('/auth/me')).body.user.id;
r = await home('/notifications');
check('подготовительный вход событий не оставил', r.body.notifications?.length === 0, JSON.stringify(r.body.notifications));

const chromeWin = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
r = await makeClient()('/auth/login', { method: 'POST', headers: { 'User-Agent': chromeWin }, body: JSON.stringify({ username: userHome, password: 'не тот' }) });
check('неверный пароль — не вход', r.status === 401, `${r.status}`);
r = await home('/notifications');
check('неудачная попытка события не создаёт', r.body.notifications?.length === 0, JSON.stringify(r.body.notifications));

const away = makeClient();
r = await away('/auth/login', { method: 'POST', headers: { 'User-Agent': chromeWin }, body: JSON.stringify({ username: userHome, password: 'parol12345' }) });
check('вход с другого устройства', r.status === 200, `${r.status}`);
r = await home('/notifications');
ev = r.body.notifications?.[0];
check('событие «вход в аккаунт» с устройством', r.body.notifications?.length === 1 && ev?.kind === 'new_login' && ev.device === 'Chrome, Windows', JSON.stringify(r.body.notifications));
check('автор события — сам владелец', ev?.actor?.id === homeId && ev.post === null && ev.chat === null, JSON.stringify(ev));
check('событие непрочитано и видно в счётчике', r.body.unread === 1 && (await home('/badges')).body.notifications === 1, JSON.stringify(r.body.unread));
r = await away('/notifications');
check('новое устройство видит то же событие', r.body.notifications?.[0]?.kind === 'new_login', JSON.stringify(r.body.notifications));

const phoneUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/131.0';
await makeClient()('/auth/login', { method: 'POST', headers: { 'User-Agent': phoneUa }, body: JSON.stringify({ username: userHome, password: 'parol12345' }) });
r = await home('/notifications');
check('каждый вход — своё событие, новое сверху', r.body.notifications?.length === 2 && r.body.notifications[0].device === 'Firefox, Android', JSON.stringify(r.body.notifications?.map((x) => x.device)));
r = await home('/account/sessions');
check('все три сеанса видны в настройках', r.body.sessions?.length === 3, JSON.stringify(r.body.sessions?.length));

console.log('\n— поиск по номеру и кому виден номер —');
const fa = makeClient();
const fb = makeClient();
const userFa = `finda_${stamp}`;
const userFb = `findb_${stamp}`;
await legacySignUp(fa, userFa, 'Ищущий');
await legacySignUp(fb, userFb, 'Искомая');
// Номер привязывается кодом — это проверено выше; здесь его кладём прямо в базу.
const phoneFb = `+9967${tail}1`;
legacyDb.prepare('UPDATE users SET phone = ? WHERE username = ?').run(phoneFb, userFb);
const byPhone = (client, phones) => client('/users/by-phone', { method: 'POST', body: JSON.stringify({ phones }) });
const setPrivacy = (client, body) => client('/account/privacy', { method: 'PUT', body: JSON.stringify(body) });
const found = (res) => (res.body.users ?? []).map((u) => u.username);

r = await byPhone(guest, [phoneFb]);
check('поиск по номеру — гостю 401', r.status === 401, `${r.status}`);
r = await fa('/users/by-phone', { method: 'POST', body: JSON.stringify({ phones: phoneFb }) });
check('номера не списком — 400', r.status === 400, `${r.status}`);
r = await byPhone(fa, []);
check('пустой список — 400', r.status === 400, `${r.status}`);
r = await byPhone(fa, Array.from({ length: 51 }, (_, i) => `+99670000${String(i).padStart(4, '0')}`));
check('больше 50 номеров за раз — 400', r.status === 400, `${r.status}`);
r = await byPhone(fa, [996700000000]);
check('номер числом, а не строкой — 400', r.status === 400, `${r.status}`);

r = await fb('/account');
check('по умолчанию: не находят и номер не виден', r.body.phoneFind === 'nobody' && r.body.phoneShow === 'nobody', JSON.stringify(r.body));
r = await byPhone(fa, [phoneFb]);
check('без разрешения — пусто, как будто номера нет', r.status === 200 && found(r).length === 0, JSON.stringify(r.body));

r = await setPrivacy(fb, { phoneFind: 'friends' });
check('неизвестное значение — 400', r.status === 400, `${r.status}`);
r = await setPrivacy(fb, {});
check('пустая настройка — 400', r.status === 400, `${r.status}`);
await setPrivacy(fb, { lastSeen: 'follows' });
r = await setPrivacy(fb, { phoneFind: 'all' });
check('меняется только присланное', r.status === 200 && r.body.phoneFind === 'all' && r.body.lastSeen === 'follows' && r.body.phoneShow === 'nobody', JSON.stringify(r.body));
await setPrivacy(fb, { lastSeen: 'all' });

const pretty = `+996 (7${tail.slice(0, 2)}) ${tail.slice(2, 4)}-${tail.slice(4)}-1`;
r = await byPhone(fa, ['не номер', pretty, phoneFb]);
check('находит по номеру в любом написании, мусор пропускает, повтор схлопывает', found(r).join() === userFb, JSON.stringify(r.body));
const hit = r.body.users?.[0];
check('в ответе — номер в E.164 и подписка', hit?.phone === phoneFb && hit.followedByMe === false && hit.displayName === 'Искомая', JSON.stringify(hit));
r = await byPhone(fb, [phoneFb]);
check('себя по своему номеру не находит', found(r).length === 0, JSON.stringify(r.body));

await setPrivacy(fb, { phoneFind: 'follows' });
r = await byPhone(fa, [phoneFb]);
check('«мои подписки»: чужому — пусто', found(r).length === 0, JSON.stringify(r.body));
await fb(`/users/${userFa}/follow`, { method: 'PUT' });
r = await byPhone(fa, [phoneFb]);
check('«мои подписки»: тому, на кого подписана, — находит', found(r).join() === userFb, JSON.stringify(r.body));
await fa(`/users/${userFb}/follow`, { method: 'PUT' });
r = await byPhone(fa, [phoneFb]);
check('подписка видна в ответе', r.body.users?.[0]?.followedByMe === true, JSON.stringify(r.body));

// Номер в профиле.
r = await fa(`/users/${userFb}`);
check('номер в профиле по умолчанию скрыт', r.status === 200 && r.body.user.phone === null, JSON.stringify(r.body.user?.phone));
r = await fb(`/users/${userFb}`);
check('и в своём профиле не показан, раз никому не виден', r.body.user.phone === null, JSON.stringify(r.body.user?.phone));
await setPrivacy(fb, { phoneShow: 'all' });
r = await fa(`/users/${userFb}`);
check('«все» — номер в профиле', r.body.user.phone === phoneFb, JSON.stringify(r.body.user?.phone));
r = await guest(`/users/${userFb}`);
check('гостю номер не виден никогда', r.status === 200 && r.body.user.phone === null, JSON.stringify(r.body.user?.phone));
r = await fb(`/users/${userFb}`);
check('свой номер в профиле — раз его видят другие', r.body.user.phone === phoneFb, JSON.stringify(r.body.user?.phone));
await setPrivacy(fb, { phoneShow: 'follows' });
r = await b(`/users/${userFb}`);
check('«мои подписки»: чужому номер не виден', r.body.user.phone === null, JSON.stringify(r.body.user?.phone));
r = await fa(`/users/${userFb}`);
check('«мои подписки»: тому, на кого подписана, — виден', r.body.user.phone === phoneFb, JSON.stringify(r.body.user?.phone));
r = await fb(`/users/${userFa}`);
check('у кого номера нет — null', r.body.user.phone === null, JSON.stringify(r.body.user?.phone));

// Блокировка сильнее любой настройки.
await setPrivacy(fb, { phoneFind: 'all', phoneShow: 'all' });
await fb(`/users/${userFa}/block`, { method: 'PUT' });
r = await byPhone(fa, [phoneFb]);
check('заблокированный не находит по номеру', found(r).length === 0, JSON.stringify(r.body));
r = await fa(`/users/${userFb}`);
check('и не видит номер в профиле', r.body.user.phone === null, JSON.stringify(r.body.user?.phone));
r = await byPhone(fb, [phoneFb, `+9967${tail}9`]);
check('незарегистрированный номер — просто пусто', r.status === 200 && found(r).length === 0, JSON.stringify(r.body));
await fb(`/users/${userFa}/block`, { method: 'DELETE' });
r = await byPhone(fa, [phoneFb]);
check('после разблокировки — снова находит', found(r).join() === userFb, JSON.stringify(r.body));

console.log('\n— черновики —');
const dra = makeClient();
const drb = makeClient();
const drc = makeClient();
const userDra = `drafta_${stamp}`;
const userDrb = `draftb_${stamp}`;
const userDrc = `draftc_${stamp}`;
await legacySignUp(dra, userDra, 'Пишущая');
await legacySignUp(drb, userDrb, 'Читающий');
await legacySignUp(drc, userDrc, 'Третий');
const getDraft = (client, kind, target) => client(`/drafts/${kind}/${target}`);
const putDraft = (client, kind, target, body) =>
  client(`/drafts/${kind}/${target}`, { method: 'PUT', body: JSON.stringify({ body }) });
const draftCount = (kind, targetId) => legacyDb.prepare('SELECT COUNT(*) AS c FROM drafts WHERE kind = ? AND target_id = ?').get(kind, targetId).c;

r = await getDraft(guest, 'dm', userDrb);
check('черновик — гостю 401', r.status === 401, `${r.status}`);
r = await getDraft(dra, 'dm', userDrb);
check('черновика нет — null', r.status === 200 && r.body.draft === null, JSON.stringify(r.body));
r = await getDraft(dra, 'dm', `net_takogo_${stamp}`);
check('черновик несуществующему — 404', r.status === 404, `${r.status}`);
r = await getDraft(dra, 'group', '1');
check('неизвестный вид — 404', r.status === 404, `${r.status}`);

await dmSend(dra, userDrb, { body: 'Начнём' });
r = await putDraft(dra, 'dm', userDrb, 'Привет, как ');
check('черновик сохранён как есть — с пробелом в конце', r.status === 200 && r.body.draft?.body === 'Привет, как ' && typeof r.body.draft.updatedAt === 'string', JSON.stringify(r.body));
r = await getDraft(dra, 'dm', userDrb.toUpperCase());
check('читается обратно (логин в любом регистре)', r.body.draft?.body === 'Привет, как ', JSON.stringify(r.body));
r = await putDraft(dra, 'dm', userDrb, 'я'.repeat(1001));
check('длиннее сообщения — 400', r.status === 400, `${r.status}`);
r = await dra('/messages');
const drRow = r.body.conversations?.find((c) => c.user.username === userDrb);
check('в списке диалогов — черновик', drRow?.draft?.body === 'Привет, как ', JSON.stringify(drRow?.draft));
r = await drb('/messages');
check('собеседник чужого черновика не видит', r.body.conversations?.find((c) => c.user.username === userDra)?.draft === null, JSON.stringify(r.body.conversations?.map((c) => c.draft)));

// Другое устройство того же человека узнаёт о черновике живым потоком.
const dra2 = makeClient();
await dra2('/auth/login', { method: 'POST', body: JSON.stringify({ username: userDra, password: 'parol12345' }) });
const dra2Live = await listen(dra2);
await dra2Live.waitFor((e) => e.t === 'ready');
await putDraft(dra, 'dm', userDrb, 'Привет, как дела?');
check('другое устройство получает толчок обновить список', Boolean(await dra2Live.waitFor((e) => e.t === 'list')), JSON.stringify(dra2Live.events));
dra2Live.stop();
r = await getDraft(dra2, 'dm', userDrb);
check('и видит тот же черновик', r.body.draft?.body === 'Привет, как дела?', JSON.stringify(r.body));

r = await dmSend(dra, userDrb, { sticker: 'plenka/hi' });
r = await getDraft(dra, 'dm', userDrb);
check('стикер черновик не трогает', r.body.draft?.body === 'Привет, как дела?', JSON.stringify(r.body));
await dmSend(dra, userDrb, { body: 'Привет, как дела?' });
r = await getDraft(dra, 'dm', userDrb);
check('отправленный текст — больше не черновик', r.body.draft === null, JSON.stringify(r.body));
await putDraft(dra, 'dm', userDrb, 'ещё');
r = await putDraft(dra, 'dm', userDrb, '  \n ');
check('пустой черновик — удалён', r.status === 200 && r.body.draft === null && (await getDraft(dra, 'dm', userDrb)).body.draft === null, JSON.stringify(r.body));
r = await putDraft(dra, 'dm', userDra, 'заметка себе');
check('черновик в «Избранном»', r.status === 200 && r.body.draft?.body === 'заметка себе', `${r.status}`);

// Группа: черновик только у участника.
r = await dra('/chats', { method: 'POST', body: JSON.stringify({ title: 'Черновики', members: [userDrb] }) });
const drChat = r.body.chat.id;
r = await putDraft(drc, 'chat', drChat, 'подсмотрю');
check('в чужой группе черновика нет — 404', r.status === 404, `${r.status}`);
r = await putDraft(dra, 'chat', 'abc', 'x');
check('кривой id группы — 404', r.status === 404, `${r.status}`);
await putDraft(dra, 'chat', drChat, 'В группу');
await putDraft(drb, 'chat', drChat, 'Мой ответ');
r = await dra('/chats');
check('в списке групп — свой черновик', r.body.chats?.find((c) => c.id === drChat)?.draft?.body === 'В группу', JSON.stringify(r.body.chats?.map((c) => c.draft)));
await dra(`/chats/${drChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'В группу' }) });
check('сообщение в группу снимает только свой черновик', (await getDraft(dra, 'chat', drChat)).body.draft === null
  && (await getDraft(drb, 'chat', drChat)).body.draft?.body === 'Мой ответ', '');
await dra(`/chats/${drChat}/members/${userDrb}`, { method: 'DELETE' });
r = await getDraft(drb, 'chat', drChat);
check('исключённый из группы теряет и черновик', r.status === 404 && draftCount('chat', drChat) === 0, `${r.status} ${draftCount('chat', drChat)}`);
await putDraft(dra, 'chat', drChat, 'последнее слово');
await dra(`/chats/${drChat}`, { method: 'DELETE' });
check('удалённая группа уносит черновики', draftCount('chat', drChat) === 0, `${draftCount('chat', drChat)}`);

// Канал: черновик — только у владельца.
const drHandle = `drafts_${stamp}`;
r = await dra('/channels', { method: 'POST', body: JSON.stringify({ title: 'Черновой канал', handle: drHandle }) });
const drChannelId = r.body.channel.id;
await drb(`/channels/${drHandle}/subscribe`, { method: 'PUT' });
r = await putDraft(drb, 'channel', drHandle, 'не мой канал');
check('в чужом канале черновика нет — 404', r.status === 404, `${r.status}`);
r = await putDraft(dra, 'channel', `@${drHandle.toUpperCase()}`, 'Длинная публикация '.repeat(100));
check('черновик публикации — до 4000 знаков', r.status === 200 && r.body.draft?.body.length === 1900, `${r.status}`);
r = await dra('/channels');
check('в списке каналов — черновик', r.body.channels?.find((c) => c.handle === drHandle)?.draft?.body.startsWith('Длинная'), '');
await dra(`/channels/${drHandle}/posts`, { method: 'POST', body: JSON.stringify({ body: 'Опубликовано' }) });
check('публикация снимает черновик', (await getDraft(dra, 'channel', drHandle)).body.draft === null, '');
await putDraft(dra, 'channel', drHandle, 'не успею');
await dra(`/channels/${drHandle}`, { method: 'DELETE' });
check('удалённый канал уносит черновик', draftCount('channel', drChannelId) === 0, `${draftCount('channel', drChannelId)}`);

// Удаление аккаунта: его черновики — каскадом, чужие ему — руками.
const drcId = (await drc('/auth/me')).body.user.id;
await dmSend(dra, userDrc, { body: 'Привет' });
await putDraft(dra, 'dm', userDrc, 'Не успела дописать');
await putDraft(drc, 'dm', userDra, 'И я');
await drc('/account', { method: 'DELETE', body: JSON.stringify({ password: 'parol12345' }) });
check('удалённый аккаунт уносит и свои черновики, и чужие ему', draftCount('dm', drcId) === 0
  && legacyDb.prepare('SELECT COUNT(*) AS c FROM drafts WHERE user_id = ?').get(drcId).c === 0, '');

console.log('\n— ссылки-приглашения в группу —');
const ia = makeClient();
const ib = makeClient();
const ic = makeClient();
const idd = makeClient();
const userIa = `inva_${stamp}`;
const userIb = `invb_${stamp}`;
const userIc = `invc_${stamp}`;
const userId_ = `invd_${stamp}`;
await legacySignUp(ia, userIa, 'Хозяйка');
await legacySignUp(ib, userIb, 'Участник');
await legacySignUp(ic, userIc, 'Новенький');
await legacySignUp(idd, userId_, 'Недруг');
r = await ia('/chats', { method: 'POST', body: JSON.stringify({ title: 'По ссылке', members: [userIb] }) });
const invChat = r.body.chat;
check('у новой группы ссылки нет', invChat?.invite === null, JSON.stringify(invChat));
await ia(`/chats/${invChat.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Старое сообщение' }) });
await ib(`/chats/${invChat.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'И ещё одно' }) });

r = await ib(`/chats/${invChat.id}/invite`, { method: 'POST' });
check('ссылку создаёт только владелец — 403', r.status === 403, `${r.status}`);
r = await ic(`/chats/${invChat.id}/invite`, { method: 'POST' });
check('не участник — 404', r.status === 404, `${r.status}`);
r = await ia(`/chats/${invChat.id}/invite`, { method: 'POST' });
const token1 = r.body.invite;
check('владелец создал ссылку — случайный код', r.status === 200 && /^[A-Za-z0-9_-]{22}$/.test(token1 ?? ''), JSON.stringify(r.body));
r = await ib(`/chats/${invChat.id}`);
check('ссылку видит любой участник', r.body.chat?.invite === token1, JSON.stringify(r.body.chat?.invite));

r = await guest(`/chats/join/${token1}`);
check('приглашение — гостю 401', r.status === 401, `${r.status}`);
r = await ic('/chats/join/nesushchestvuyushchiy_kod_123');
check('выдуманный код — 404', r.status === 404, `${r.status}`);
r = await ic('/chats/join/a');
check('короткий код — 404', r.status === 404, `${r.status}`);
r = await ic(`/chats/join/${token1}`);
check('по ссылке видно название и состав, но не переписку', r.status === 200 && r.body.chat?.title === 'По ссылке' && r.body.chat.memberCount === 2
  && r.body.chat.members.length === 2 && r.body.member === false && !('messages' in r.body.chat), JSON.stringify(r.body));
r = await ic(`/chats/${invChat.id}/messages`);
check('до вступления переписка закрыта', r.status === 404, `${r.status}`);

const iaLive = await listen(ia);
await iaLive.waitFor((e) => e.t === 'ready');
r = await ic(`/chats/join/${token1}`, { method: 'POST' });
check('вступил по ссылке — 201 и чат', r.status === 201 && r.body.chat?.id === invChat.id && r.body.chat.memberCount === 3, `${r.status} ${JSON.stringify(r.body)}`);
check('участники узнают о новичке живым потоком', Boolean(await iaLive.waitFor((e) => e.t === 'chat' && e.id === invChat.id)), JSON.stringify(iaLive.events));
iaLive.stop();
r = await ic('/chats');
const icRow = r.body.chats?.find((c) => c.id === invChat.id);
check('чат в списке, старое не падает непрочитанным', icRow && icRow.unread === 0, JSON.stringify(icRow?.unread));
r = await ic(`/chats/${invChat.id}/messages`);
check('история видна после вступления', r.status === 200 && r.body.messages?.length === 2, `${r.status}`);
r = await ic(`/chats/join/${token1}`, { method: 'POST' });
check('повторный щелчок — 200, без второй строки', r.status === 200 && r.body.chat?.memberCount === 3, `${r.status}`);
r = await ic(`/chats/join/${token1}`);
check('в приглашении видно, что уже участник', r.body.member === true, JSON.stringify(r.body.member));
await ib(`/chats/${invChat.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Добро пожаловать' }) });
r = await ic('/chats');
check('новое после вступления — непрочитанное', r.body.chats?.find((c) => c.id === invChat.id)?.unread === 1, '');

r = await ia(`/chats/${invChat.id}/invite`, { method: 'POST' });
const token2 = r.body.invite;
check('сменить ссылку — новый код', token2 && token2 !== token1, '');
r = await idd(`/chats/join/${token1}`);
check('старая ссылка после смены — 404', r.status === 404, `${r.status}`);
await idd(`/users/${userIa}/block`, { method: 'PUT' });
r = await idd(`/chats/join/${token2}`, { method: 'POST' });
check('в блокировке с владельцем — не вступить', r.status === 403, `${r.status}`);
await idd(`/users/${userIa}/block`, { method: 'DELETE' });

r = await ib(`/chats/${invChat.id}/invite`, { method: 'DELETE' });
check('отключить ссылку может только владелец', r.status === 403, `${r.status}`);
r = await ia(`/chats/${invChat.id}/invite`, { method: 'DELETE' });
check('ссылка отключена', r.status === 200 && r.body.invite === null && (await ia(`/chats/${invChat.id}`)).body.chat.invite === null, `${r.status}`);
r = await idd(`/chats/join/${token2}`, { method: 'POST' });
check('по отключённой ссылке не вступить', r.status === 404, `${r.status}`);

console.log('\n— администраторы, медленный режим, «пишут только администраторы» —');
const ga = makeClient();
const gb = makeClient();
const gc = makeClient();
const gd = makeClient();
const userGa = `grpa_${stamp}`;
const userGb = `grpb_${stamp}`;
const userGc = `grpc_${stamp}`;
const userGd = `grpd_${stamp}`;
await legacySignUp(ga, userGa, 'Владелица');
await legacySignUp(gb, userGb, 'Админ');
await legacySignUp(gc, userGc, 'Участница');
await legacySignUp(gd, userGd, 'Лишний');
r = await ga('/chats', { method: 'POST', body: JSON.stringify({ title: 'Порядок', members: [userGb, userGc, userGd] }) });
const grp = r.body.chat;
const roleIn = (chat, username) => chat?.members?.find((m) => m.username === username)?.role;
check('новая группа: владелец и участники, порядок выключен', grp?.myRole === 'owner' && roleIn(grp, userGa) === 'owner' && roleIn(grp, userGb) === 'member'
  && grp.slowMode === 0 && grp.adminsOnly === false && grp.nextPostAt === null, JSON.stringify({ myRole: grp?.myRole, slow: grp?.slowMode }));
const gpost = (client, body) => client(`/chats/${grp.id}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
const gpatch = (client, body) => client(`/chats/${grp.id}`, { method: 'PATCH', body: JSON.stringify(body) });

r = await gb(`/chats/${grp.id}/admins/${userGc}`, { method: 'PUT' });
check('назначать администраторов может только владелец', r.status === 403, `${r.status}`);
r = await ga(`/chats/${grp.id}/admins/net_takogo_${stamp}`, { method: 'PUT' });
check('не участник — 404', r.status === 404, `${r.status}`);
r = await ga(`/chats/${grp.id}/admins/${userGa}`, { method: 'PUT' });
check('владельца в администраторы — 400', r.status === 400, `${r.status}`);
r = await ga(`/chats/${grp.id}/admins/${userGb}`, { method: 'PUT' });
check('владелец назначил администратора', r.status === 200 && roleIn(r.body.chat, userGb) === 'admin', JSON.stringify(r.body.chat?.members?.map((m) => m.role)));
r = await gb(`/chats/${grp.id}`);
check('администратор видит свою роль', r.body.chat?.myRole === 'admin', JSON.stringify(r.body.chat?.myRole));

r = await gpatch(gc, { title: 'Захват' });
check('участник группу не меняет — 403', r.status === 403, `${r.status}`);
r = await gpatch(gb, { title: 'Порядок и тишина' });
check('администратор переименовал', r.status === 200 && r.body.chat?.title === 'Порядок и тишина', `${r.status}`);
r = await gpatch(gb, { slowMode: 7 });
check('медленный режим не из списка — 400', r.status === 400, `${r.status}`);
r = await gpatch(gb, { adminsOnly: 'да' });
check('adminsOnly не да/нет — 400', r.status === 400, `${r.status}`);
r = await gpatch(gb, {});
check('пустая правка — 400', r.status === 400, `${r.status}`);
r = await gpatch(gb, { slowMode: 30 });
check('медленный режим включён', r.status === 200 && r.body.chat?.slowMode === 30 && r.body.chat.title === 'Порядок и тишина', `${r.status}`);

r = await gpost(gc, 'Первое');
const gcFirst = r.body.message;
check('участник пишет в медленном режиме', r.status === 201, `${r.status}`);
r = await gpost(gc, 'Второе сразу');
check('второе сразу — 429 с временем ожидания', r.status === 429 && /Медленный режим: следующее сообщение — через \d+ с/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
r = await gc(`/chats/${grp.id}`);
check('в чате видно, когда можно снова', Date.parse(r.body.chat?.nextPostAt ?? '') > Date.now(), JSON.stringify(r.body.chat?.nextPostAt));
r = await gc('/chats');
check('и в списке чатов тоже', Date.parse(r.body.chats?.find((c) => c.id === grp.id)?.nextPostAt ?? '') > Date.now(), '');
r = await gc(`/chats/${grp.id}/messages`, { method: 'POST', body: JSON.stringify({ sticker: 'plenka/hi' }) });
check('стикер медленный режим тоже не обходит', r.status === 429, `${r.status}`);
r = await gc('/scheduled', { method: 'POST', body: JSON.stringify({ kind: 'chat', target: grp.id, body: 'потом', sendAt: new Date(Date.now() + 3_600_000).toISOString() }) });
check('в медленном режиме участнику не отложить', r.status === 403, `${r.status}`);
r = await gpost(gb, 'Админ раз');
const gbMsg = r.body.message;
const r2 = await gpost(gb, 'Админ два');
check('администратора медленный режим не касается', r.status === 201 && r2.status === 201, `${r.status} ${r2.status}`);
r = await gpost(ga, 'Владелица');
const gaMsg = r.body.message;
check('владельца тоже', r.status === 201 && (await gb(`/chats/${grp.id}`)).body.chat.nextPostAt === null, `${r.status}`);
await gpatch(ga, { slowMode: 0 });
r = await gpost(gc, 'Режим выключили');
check('выключили — пишет сразу', r.status === 201, `${r.status}`);

r = await gpatch(gb, { adminsOnly: true });
check('«пишут только администраторы» включено', r.status === 200 && r.body.chat?.adminsOnly === true, `${r.status}`);
r = await gpost(gc, 'Можно?');
check('участнику писать нельзя — 403', r.status === 403 && /только администраторы/.test(r.body.error ?? ''), `${r.status}`);
r = await gc(`/chats/${grp.id}/messages/${gbMsg.id}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji: '👍' }) });
check('реакции участникам остаются', r.status === 200, `${r.status}`);
r = await gpost(gb, 'Объявление');
check('администратор пишет', r.status === 201, `${r.status}`);
await gpatch(ga, { adminsOnly: false });

r = await gc(`/chats/${grp.id}/messages/${gbMsg.id}`, { method: 'DELETE' });
check('участник чужое не удаляет', r.status === 403, `${r.status}`);
r = await gb(`/chats/${grp.id}/messages/${gaMsg.id}`, { method: 'DELETE' });
check('администратор не удаляет сообщение владельца', r.status === 403, `${r.status}`);
r = await gb(`/chats/${grp.id}/messages/${gcFirst.id}`, { method: 'DELETE' });
check('администратор удаляет сообщение участника', r.status === 200, `${r.status}`);
r = await ga(`/chats/${grp.id}/messages/${gbMsg.id}`, { method: 'DELETE' });
check('владелец удаляет и сообщение администратора', r.status === 200, `${r.status}`);

r = await gc(`/chats/${grp.id}/messages/${gaMsg.id}/pin`, { method: 'PUT' });
check('участник не закрепляет', r.status === 403, `${r.status}`);
r = await gb(`/chats/${grp.id}/messages/${gaMsg.id}/pin`, { method: 'PUT' });
check('администратор закрепляет', r.status === 200 && r.body.pinned?.id === gaMsg.id, `${r.status}`);
r = await gb(`/chats/${grp.id}/invite`, { method: 'POST' });
check('администратор управляет ссылкой-приглашением', r.status === 200 && typeof r.body.invite === 'string', `${r.status}`);

await ga(`/chats/${grp.id}/admins/${userGc}`, { method: 'PUT' });
r = await gb(`/chats/${grp.id}/members/${userGc}`, { method: 'DELETE' });
check('администратор не убирает другого администратора', r.status === 403, `${r.status}`);
r = await gb(`/chats/${grp.id}/members/${userGa}`, { method: 'DELETE' });
check('и владельца', r.status === 403, `${r.status}`);
r = await gb(`/chats/${grp.id}/members/${userGd}`, { method: 'DELETE' });
check('администратор убирает обычного участника', r.status === 200, `${r.status}`);
r = await ga(`/chats/${grp.id}/admins/${userGc}`, { method: 'DELETE' });
check('владелец снял администратора', r.status === 200 && roleIn(r.body.chat, userGc) === 'member', JSON.stringify(r.body.chat?.members?.map((m) => m.role)));
r = await gb(`/chats/${grp.id}`, { method: 'DELETE' });
check('удалить группу может только владелец', r.status === 403, `${r.status}`);

r = await ga(`/chats/${grp.id}/members/${userGa}`, { method: 'DELETE' });
r = await gb(`/chats/${grp.id}`);
check('ушёл владелец — группа переходит администратору', r.body.chat?.ownerId !== undefined && r.body.chat.myRole === 'owner'
  && roleIn(r.body.chat, userGb) === 'owner' && roleIn(r.body.chat, userGc) === 'member', JSON.stringify(r.body.chat?.members?.map((m) => [m.username, m.role])));

console.log('\n— кто прочитал в группе —');
const ra = makeClient();
const rb = makeClient();
const rc = makeClient();
const rd = makeClient();
const userRa = `rdra_${stamp}`;
const userRb = `rdrb_${stamp}`;
const userRc = `rdrc_${stamp}`;
const userRd = `rdrd_${stamp}`;
await legacySignUp(ra, userRa, 'Автор');
await legacySignUp(rb, userRb, 'Быстрый');
await legacySignUp(rc, userRc, 'Медленный');
await legacySignUp(rd, userRd, 'Скрытый');
r = await ra('/chats', { method: 'POST', body: JSON.stringify({ title: 'Читатели', members: [userRb, userRc, userRd] }) });
const rchat = r.body.chat.id;
r = await ra(`/chats/${rchat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Все прочитали?' }) });
const rmsg = r.body.message.id;
const readers = (client, mid = rmsg) => client(`/chats/${rchat}/messages/${mid}/readers`);
const names = (list) => (list ?? []).map((u) => u.username).sort().join(',');

r = await readers(ra);
check('сразу после отправки — никто не прочитал', r.status === 200 && r.body.read?.length === 0 && names(r.body.unread) === [userRb, userRc, userRd].sort().join(','), JSON.stringify(r.body));
await rb(`/chats/${rchat}/read`, { method: 'PUT' });
r = await readers(ra);
check('прочитал — в списке прочитавших', names(r.body.read) === userRb && names(r.body.unread) === [userRc, userRd].sort().join(','), JSON.stringify({ read: names(r.body.read), unread: names(r.body.unread) }));
check('автора в списках нет', ![...r.body.read, ...r.body.unread].some((u) => u.username === userRa), '');
r = await readers(rb);
check('чужое сообщение — 403', r.status === 403, `${r.status}`);
r = await readers(ra, 999999);
check('несуществующее сообщение — 404', r.status === 404, `${r.status}`);
r = await readers(makeClient());
check('гостю — 401', r.status === 401, `${r.status}`);
await rd(`/users/${userRa}/block`, { method: 'PUT' });
await rd(`/chats/${rchat}/read`, { method: 'PUT' });
r = await readers(ra);
check('с кем автор в блокировке — нет ни в одном списке', ![...r.body.read, ...r.body.unread].some((u) => u.username === userRd), JSON.stringify(r.body));
r = await ra(`/chats/${rchat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Второе' }) });
const rmsg2 = r.body.message.id;
await rc(`/chats/${rchat}/read`, { method: 'PUT' });
r = await readers(ra, rmsg2);
check('ватерлиния: у второго — только тот, кто зашёл после него', names(r.body.read) === userRc, JSON.stringify({ read: names(r.body.read) }));
r = await readers(ra);
check('у первого теперь оба', names(r.body.read) === [userRb, userRc].sort().join(','), JSON.stringify({ read: names(r.body.read) }));

console.log('\n— предпросмотр ссылок —');
// Поддельный сайт на 127.0.0.1: сервер поднят с LINK_PREVIEW_ALLOW_LOOPBACK=1
// (см. README, «Тесты»), и только петля ему открыта — остальные частные адреса
// закрыты и в этом режиме, это проверяется ниже.
const SITE_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const siteHits = {};
const site = createServer((req, res) => {
  siteHits[req.url] = (siteHits[req.url] ?? 0) + 1;
  const html = (body) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
  switch (req.url) {
    case '/':
      return html('<html><head><meta property="og:title" content="Плёнка &amp; свет"><meta property="og:description" content="Заметки о проявке">'
        + '<meta property="og:site_name" content="Заметки"><meta property="og:image" content="/pic.png"></head><body>…</body></html>');
    case '/cp1251':
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(Buffer.concat([Buffer.from('<meta charset="windows-1251"><title>'), Buffer.from([0xcf, 0xf0, 0xee, 0xff, 0xe2, 0xea, 0xe0]), Buffer.from('</title>')]));
    case '/redirect':
      return res.writeHead(302, { Location: '/' }).end();
    case '/loop':
      return res.writeHead(302, { Location: '/loop' }).end();
    case '/to-metadata':
      return res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }).end();
    case '/json':
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"title":"нет"}');
    case '/svg-page':
      return html('<meta property="og:title" content="С картинкой-SVG"><meta property="og:image" content="/evil.svg">');
    case '/evil.svg':
      return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    case '/pic.png':
      return res.writeHead(200, { 'Content-Type': 'image/png' }).end(SITE_PNG);
    default:
      return res.writeHead(404).end();
  }
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const siteBase = `http://127.0.0.1:${site.address().port}`;
const lpa = makeClient();
const lpb = makeClient();
await legacySignUp(lpa, `lpva_${stamp}`, 'Смотрящая');
await legacySignUp(lpb, `lpvb_${stamp}`, 'Второй');
const preview = (client, url) => client(`/link-preview?url=${encodeURIComponent(url)}`);

r = await preview(guest, `${siteBase}/`);
check('предпросмотр — гостю 401', r.status === 401, `${r.status}`);
r = await preview(lpa, 'ftp://example.com/');
check('не http(s) — 400', r.status === 400, `${r.status}`);
r = await preview(lpa, 'http://user:pass@example.com/');
check('с логином в адресе — 400', r.status === 400, `${r.status}`);
for (const [name, url] of [
  ['облачные метаданные', 'http://169.254.169.254/latest/meta-data'],
  ['частная сеть', 'http://10.0.0.1/'],
  ['IPv4 внутри IPv6', 'http://[::ffff:192.168.0.1]/'],
]) {
  const started = Date.now();
  r = await preview(lpa, url);
  check(`закрыто: ${name} — пусто и сразу`, r.status === 200 && r.body.preview === null && Date.now() - started < 2000, `${r.status} ${Date.now() - started}ms`);
}

r = await preview(lpa, `${siteBase}/#якорь`);
const pv = r.body.preview;
check('Open Graph разобран: заголовок, описание, сайт', r.status === 200 && pv?.title === 'Плёнка & свет' && pv.description === 'Заметки о проявке' && pv.siteName === 'Заметки' && pv.url === `${siteBase}/`, JSON.stringify(r.body));
check('картинка — через наш сервер', pv?.image === `/api/link-preview/image?u=${encodeURIComponent(`${siteBase}/pic.png`)}`, JSON.stringify(pv?.image));
await preview(lpb, `${siteBase}/`);
check('повтор берётся из кэша, сайт не дёргается', siteHits['/'] === 1, JSON.stringify(siteHits));
const img = await lpa.raw(pv.image);
const imgBody = Buffer.from(await img.arrayBuffer());
check('картинка отдаётся: png, те же байты, кэш у браузера', img.status === 200 && img.headers.get('content-type') === 'image/png'
  && imgBody.equals(SITE_PNG) && /private/.test(img.headers.get('cache-control') ?? ''), `${img.status} ${img.headers.get('content-type')}`);
r = await lpa.raw(`/api/link-preview/image?u=${encodeURIComponent(`${siteBase}/pic.png?other=1`)}`);
check('картинка не из превью — 404: это не открытый прокси', r.status === 404, `${r.status}`);
r = await guest.raw(pv.image);
check('картинка — гостю 401', r.status === 401, `${r.status}`);

r = await preview(lpa, `${siteBase}/cp1251`);
check('страница в windows-1251 — заголовок по-русски', r.body.preview?.title === 'Проявка', JSON.stringify(r.body));
r = await preview(lpa, `${siteBase}/redirect`);
check('переадресация на тот же сайт — превью конечной страницы', r.body.preview?.title === 'Плёнка & свет', JSON.stringify(r.body));
r = await preview(lpa, `${siteBase}/loop`);
check('бесконечная переадресация — пусто', r.status === 200 && r.body.preview === null, JSON.stringify(r.body));
r = await preview(lpa, `${siteBase}/to-metadata`);
check('переадресация на закрытый адрес — пусто', r.status === 200 && r.body.preview === null, JSON.stringify(r.body));
r = await preview(lpa, `${siteBase}/json`);
check('не HTML — пусто', r.body.preview === null, JSON.stringify(r.body));
r = await preview(lpa, `${siteBase}/svg-page`);
const svgImg = r.body.preview?.image;
r = svgImg ? await lpa.raw(svgImg) : { status: 0 };
check('SVG через прокси не отдаётся', r.status === 404, `${r.status}`);
site.close();

console.log('\n— альбомы —');
const aa = makeClient();
const ab = makeClient();
const ac = makeClient();
const userAa = `alba_${stamp}`;
const userAb = `albb_${stamp}`;
const userAc = `albc_${stamp}`;
await legacySignUp(aa, userAa, 'Фотограф');
await legacySignUp(ab, userAb, 'Зритель');
await legacySignUp(ac, userAc, 'Третий');
const album1 = `alb${stamp}one`;
r = await dmPost(aa, userAb, withFile(PNG, '1.png', 'image/png', { album: album1, body: 'Три кадра' }));
const al1 = r.body.message;
check('первое фото альбома — с подписью и кодом альбома', r.status === 201 && al1?.albumId === album1 && al1.body === 'Три кадра', `${r.status} ${JSON.stringify(r.body)}`);
r = await dmPost(aa, userAb, withFile(PNG, '2.png', 'image/png', { album: album1 }));
const r3 = await dmPost(aa, userAb, withFile(PNG, '3.png', 'image/png', { album: album1 }));
check('следующие снимки — в тот же альбом', r.status === 201 && r3.status === 201 && r3.body.message?.albumId === album1, `${r.status} ${r3.status}`);
r = await ab(`/messages/${userAa}`);
check('собеседник видит три сообщения с общим альбомом', r.body.messages?.filter((m) => m.albumId === album1).length === 3, '');
r = await dmPost(aa, userAb, withFile(PDF, 'doc.pdf', 'application/pdf', { album: album1 }));
check('документ в альбом — 400', r.status === 400 && /только фото и видео/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
r = await dmPost(aa, userAb, withFile(PNG, 'x.png', 'image/png', { album: 'кривой код' }));
check('кривой код альбома — 400', r.status === 400, `${r.status}`);
r = await dmPost(ab, userAa, withFile(PNG, 'hijack.png', 'image/png', { album: album1 }));
check('в чужой альбом не подклеить — 400', r.status === 400 && /Альбом не найден/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
r = await dmPost(aa, userAc, withFile(PNG, 'elsewhere.png', 'image/png', { album: album1 }));
check('в альбом из другой переписки — тоже 400', r.status === 400, `${r.status}`);
const album2 = `alb${stamp}ten`;
for (let i = 0; i < 10; i++) await dmPost(aa, userAc, withFile(PNG, `${i}.png`, 'image/png', { album: album2 }));
r = await dmPost(aa, userAc, withFile(PNG, '11.png', 'image/png', { album: album2 }));
check('одиннадцатый снимок — 400: в альбоме не больше десяти', r.status === 400 && /не больше 10/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
r = await aa(`/messages/${userAb}/${al1.id}`, { method: 'DELETE' });
r = await ab(`/messages/${userAa}`);
check('снимок альбома удаляется отдельно', r.body.messages?.filter((m) => m.albumId === album1).length === 2, '');

// Группа: альбом в медленном режиме — одно сообщение.
r = await aa('/chats', { method: 'POST', body: JSON.stringify({ title: 'Альбомы', members: [userAb, userAc] }) });
const achat = r.body.chat.id;
await aa(`/chats/${achat}`, { method: 'PATCH', body: JSON.stringify({ slowMode: 60 }) });
const album3 = `alb${stamp}grp`;
r = await chatPost(ab, achat, withFile(PNG, 'g1.png', 'image/png', { album: album3, body: 'Из похода' }));
const g2 = await chatPost(ab, achat, withFile(PNG, 'g2.png', 'image/png', { album: album3 }));
check('альбом в медленном режиме уходит целиком', r.status === 201 && g2.status === 201 && g2.body.message?.albumId === album3, `${r.status} ${g2.status} ${g2.body.error}`);
r = await chatPost(ab, achat, withFile(PNG, 'g3.png', 'image/png', { album: `alb${stamp}new` }));
check('новый альбом сразу после — медленный режим держит', r.status === 429, `${r.status}`);
r = await chatPost(ac, achat, withFile(PNG, 'g4.png', 'image/png', { album: album3 }));
check('чужой альбом в группе не продолжить', r.status === 400, `${r.status}`);
r = await ac(`/chats/${achat}/messages`);
check('участники видят альбом в группе', r.body.messages?.filter((m) => m.albumId === album3).length === 2, '');

// Канал: альбом публикаций — те же правила.
const chAlbHandle = `albch_${stamp}`.slice(0, 32);
await aa('/channels', { method: 'POST', body: JSON.stringify({ title: 'Фотоканал', handle: chAlbHandle }) });
await ab(`/channels/${chAlbHandle}/subscription`, { method: 'PUT' });
const albPublish = (client, fd) => client(`/channels/${chAlbHandle}/posts`, { method: 'POST', body: fd });
const album4 = `alb${stamp}chn`;
r = await albPublish(aa, withFile(PNG, 'c1.png', 'image/png', { album: album4, body: 'Репортаж' }));
const albC2 = await albPublish(aa, withFile(PNG, 'albC2.png', 'image/png', { album: album4 }));
const albC3 = await albPublish(aa, withFile(PNG, 'albC3.png', 'image/png', { album: album4 }));
check('альбом в канале: три публикации с общим кодом', r.status === 201 && r.body.post?.albumId === album4 && albC3.body.post?.albumId === album4 && albC2.status === 201,
  `${r.status} ${albC2.status} ${JSON.stringify(r.body)}`);
const chAlb = [r.body.post, albC2.body.post, albC3.body.post];
r = await albPublish(aa, withFile(PDF, 'c.pdf', 'application/pdf', { album: album4 }));
check('документ в альбом канала — 400', r.status === 400, `${r.status}`);
const chAlbOther = `albcx_${stamp}`.slice(0, 32);
await aa('/channels', { method: 'POST', body: JSON.stringify({ title: 'Второй фотоканал', handle: chAlbOther }) });
r = await aa(`/channels/${chAlbOther}/posts`, { method: 'POST', body: withFile(PNG, 'c4.png', 'image/png', { album: album4 }) });
check('альбом другого канала не продолжить — 400', r.status === 400 && /Альбом не найден/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
r = await ab(`/channels/${chAlbHandle}/posts`);
check('подписчик видит альбом канала', r.body.posts?.filter((x) => x.albumId === album4).length === 3, '');

// Пересылка альбома целиком: те же пересылки с новым общим кодом.
const fwdAlbum = `alb${stamp}fwd`;
const fwdOne = (client, to, id, album) =>
  client(`/messages/${to}`, { method: 'POST', body: JSON.stringify({ forward: { from: 'channel', id }, album }) });
const fw = [];
for (const post of chAlb) fw.push(await fwdOne(ab, userAc, post.id, fwdAlbum));
check('альбом канала переслан целиком — новый общий код, подпись и «из канала»',
  fw.every((x) => x.status === 201 && x.body.message?.albumId === fwdAlbum && x.body.message.forwardedFrom?.handle === chAlbHandle)
  && fw[0].body.message.body === 'Репортаж' && fw[1].body.message.attachment?.kind === 'image',
  JSON.stringify(fw.map((x) => [x.status, x.body.message?.albumId, x.body.error])));
r = await ac(`/messages/${userAb}`);
check('получатель видит пересланный альбом одной группой', r.body.messages?.filter((m) => m.albumId === fwdAlbum).length === 3, '');
r = await fwdOne(ab, userAc, chAlb[0].id, 'кривой код');
check('кривой код у пересылки — 400', r.status === 400, `${r.status}`);
r = await fwdOne(ac, userAb, chAlb[1].id, fwdAlbum);
check('пересылкой в чужой альбом не подклеить — 400', r.status === 400 && /Альбом не найден/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
const fwdText = `alb${stamp}txt`;
r = await ab(`/messages/${userAc}`, { method: 'POST', body: JSON.stringify({ body: 'Просто текст' }) });
r = await ab(`/messages/${userAa}`, { method: 'POST', body: JSON.stringify({ forward: { from: 'dm', id: r.body.message.id }, album: fwdText }) });
check('текст альбомом не переслать — 400', r.status === 400 && /только фото и видео/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);

// В группу с медленным режимом пересланный альбом уходит целиком, как и отправленный.
const fwdGroup = `alb${stamp}fgr`;
const gf = [];
for (const post of chAlb) {
  gf.push(await ac(`/chats/${achat}/messages`, { method: 'POST', body: JSON.stringify({ forward: { from: 'channel', id: post.id }, album: fwdGroup }) }));
}
check('пересылка альбома в группу с медленным режимом — целиком', gf.every((x) => x.status === 201 && x.body.message?.albumId === fwdGroup),
  JSON.stringify(gf.map((x) => [x.status, x.body.error])));

console.log('\n— смена логина —');
const un = makeClient();
const uo = makeClient();
const renOld = `uname_${stamp}`;
const renOther = `uother_${stamp}`;
const renNew = `unew_${stamp}`;
await legacySignUp(un, renOld, 'Меняющий');
await legacySignUp(uo, renOther, 'Сосед');
await dmSend(uo, renOld, { body: 'Привет до смены' });
const rename = (client, username) => client('/account/username', { method: 'PUT', body: JSON.stringify({ username }) });

r = await rename(guest, renNew);
check('смена логина — гостю 401', r.status === 401, `${r.status}`);
r = await rename(un, 'Кириллица');
check('кириллица — 400', r.status === 400, `${r.status}`);
r = await rename(un, renOld);
check('тот же логин — 400', r.status === 400, `${r.status}`);
r = await rename(un, renOther.toUpperCase());
check('чужой логин (в другом регистре) — 409', r.status === 409, `${r.status}`);
r = await rename(un, renNew.toUpperCase());
check('логин сменён, приведён к нижнему регистру', r.status === 200 && r.body.user?.username === renNew && r.body.previous === renOld && r.body.holdDays === 14
  && Date.parse(r.body.heldUntil) > Date.now() + 13 * 864e5, JSON.stringify(r.body));
r = await un('/auth/me');
check('сеанс тот же — уже с новым логином', r.body.user?.username === renNew, JSON.stringify(r.body.user));
r = await uo(`/users/${renOld}`);
check('по старому логину профиля нет', r.status === 404, `${r.status}`);
r = await uo(`/users/${renNew}`);
check('по новому — есть', r.status === 200, `${r.status}`);
r = await uo('/messages');
check('переписка на месте, собеседник видит новый логин', r.body.conversations?.some((c) => c.user.username === renNew && c.lastMessage.body === 'Привет до смены'), '');
r = await rename(uo, renOld);
check('старый логин закреплён — другому 409', r.status === 409, `${r.status}`);
r = await makeClient()('/auth/login', { method: 'POST', body: JSON.stringify({ username: renOld, password: 'parol12345' }) });
check('по старому логину не войти', r.status === 401, `${r.status}`);
r = await makeClient()('/auth/login', { method: 'POST', body: JSON.stringify({ username: renNew, password: 'parol12345' }) });
check('по новому — входит', r.status === 200, `${r.status}`);
r = await rename(un, renOld);
check('свой старый логин можно вернуть', r.status === 200 && r.body.user?.username === renOld, `${r.status}`);
r = await rename(uo, renNew);
check('промежуточный теперь тоже закреплён за ним', r.status === 409, `${r.status}`);

// Удалённый аккаунт: его логин тоже не освобождается сразу.
const ug = makeClient();
const renGone = `ugone_${stamp}`;
await legacySignUp(ug, renGone, 'Уходящий');
await ug('/account', { method: 'DELETE', body: JSON.stringify({ password: 'parol12345' }) });
r = await rename(uo, renGone);
check('логин удалённого аккаунта закреплён — 409', r.status === 409, `${r.status}`);

console.log('\n— звонки: сигнализация —');
// Сами звук и картинка идут между браузерами — здесь проверяется только, что
// сервер сводит участников: кому что доходит, кто может звонить и когда звонок
// кончается. Сервер для прогона поднят с CALL_RING_MS=1500 (см. README, «Тесты»).
const ka = makeClient();
const kb = makeClient();
const kc = makeClient();
const userKa = `calla_${stamp}`;
const userKb = `callb_${stamp}`;
const userKc = `callc_${stamp}`;
await legacySignUp(ka, userKa, 'Звонящая');
await legacySignUp(kb, userKb, 'Отвечающий');
await legacySignUp(kc, userKc, 'Третий');
const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\n' };
const dial = (client, to, extra = {}) => client('/calls', { method: 'POST', body: JSON.stringify({ to, sdp: OFFER, ...extra }) });
const callPost = (client, id, action, body = {}) => client(`/calls/${id}/${action}`, { method: 'POST', body: JSON.stringify(body) });

r = await guest('/calls/config');
check('настройки звонков — гостю 401', r.status === 401, `${r.status}`);
r = await ka('/calls/config');
check('STUN по умолчанию', r.status === 200 && r.body.iceServers?.[0]?.urls?.some((u) => u.startsWith('stun:')), JSON.stringify(r.body));
r = await dial(ka, userKa);
check('себе не позвонить — 400', r.status === 400, `${r.status}`);
r = await dial(ka, userKb);
check('собеседник без открытой вкладки — 409', r.status === 409 && /не в сети/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);

const kaLive = await listen(ka);
const kbLive = await listen(kb);
const kcLive = await listen(kc);
await Promise.all([kaLive, kbLive, kcLive].map((s) => s.waitFor((e) => e.t === 'ready')));
r = await ka('/calls', { method: 'POST', body: JSON.stringify({ to: userKb, sdp: { type: 'answer', sdp: 'x' } }) });
check('без offer — 400', r.status === 400, `${r.status}`);
r = await dial(ka, userKb, { video: true });
const call1 = r.body.call?.id;
check('звонок начат', r.status === 201 && typeof call1 === 'string' && r.body.call.video === true, `${r.status} ${JSON.stringify(r.body)}`);
ev = await kbLive.waitFor((e) => e.t === 'call' && e.kind === 'ring');
check('вызываемому приходит звонок: кто, видео и offer', ev?.id === call1 && ev.video === true && ev.from?.username === userKa && ev.sdp?.type === 'offer', JSON.stringify(ev));
check('посторонний ничего не получает', !kcLive.events.some((e) => e.t === 'call'), '');
r = await dial(kc, userKb);
check('вызываемый уже в звонке — «занято»', r.status === 409 && /Занято/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
r = await dial(ka, userKc);
check('звонящий уже в звонке — 409', r.status === 409, `${r.status}`);
r = await callPost(ka, call1, 'answer', { sdp: ANSWER });
check('ответить может только вызываемый', r.status === 409, `${r.status}`);
r = await callPost(kc, call1, 'ice', { candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } });
check('посторонний в звонок — 404', r.status === 404, `${r.status}`);
r = await callPost(kb, call1, 'answer', { sdp: ANSWER });
ev = await kaLive.waitFor((e) => e.t === 'call' && e.kind === 'answer');
check('ответ доходит звонящему', r.status === 200 && ev?.sdp?.type === 'answer', JSON.stringify(ev));
r = await callPost(ka, call1, 'ice', { candidate: { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
ev = await kbLive.waitFor((e) => e.t === 'call' && e.kind === 'ice');
check('кандидаты передаются собеседнику', r.status === 200 && ev?.candidate?.sdpMid === '0', JSON.stringify(ev));
r = await callPost(kb, call1, 'ice', { candidate: { candidate: 'x'.repeat(2000) } });
check('кривой кандидат — 400', r.status === 400, `${r.status}`);
r = await callPost(kb, call1, 'end');
ev = await kaLive.waitFor((e) => e.t === 'call' && e.kind === 'end');
check('положил трубку — собеседник узнаёт, звонок «завершён»', r.status === 200 && r.body.reason === 'hangup' && ev?.reason === 'hangup', JSON.stringify(ev));
r = await callPost(ka, call1, 'end');
check('завершённый звонок — 404', r.status === 404, `${r.status}`);

r = await dial(ka, userKb);
const call2 = r.body.call?.id;
r = await callPost(kb, call2, 'end');
ev = await kaLive.waitFor((e) => e.t === 'call' && e.kind === 'end' && e.id === call2);
check('отклонил до ответа — «отклонён»', r.body.reason === 'declined' && ev?.reason === 'declined', JSON.stringify(ev));

r = await dial(ka, userKb);
const call3 = r.body.call?.id;
ev = await kaLive.waitFor((e) => e.t === 'call' && e.kind === 'end' && e.id === call3, 4000);
const ev3b = kbLive.events.find((e) => e.t === 'call' && e.kind === 'end' && e.id === call3);
check('никто не ответил — пропущенный у обоих', ev?.reason === 'missed' && ev3b?.reason === 'missed', JSON.stringify([ev, ev3b]));

r = await dial(ka, userKb);
const call4 = r.body.call?.id;
await callPost(kb, call4, 'answer', { sdp: ANSWER });
kbLive.stop();
ev = await kaLive.waitFor((e) => e.t === 'call' && e.kind === 'end' && e.id === call4, 3000);
check('вкладка собеседника закрылась — звонок завершается', ev?.reason === 'gone', JSON.stringify(ev));

await kc(`/users/${userKa}/block`, { method: 'PUT' });
r = await dial(ka, userKc);
check('в блокировке — 403', r.status === 403, `${r.status}`);
kaLive.stop();
kcLive.stop();

console.log('\n— модерация жалоб —');
const mod = makeClient();
const mb = makeClient();
const mc = makeClient();
const mv = makeClient();
const userMod = `moder_${stamp}`;
const userMb = `mrepa_${stamp}`;
const userMc = `mrepb_${stamp}`;
const userMv = `mviol_${stamp}`;
await legacySignUp(mb, userMb, 'Жалобщица');
await legacySignUp(mc, userMc, 'Жалобщик');
await legacySignUp(mv, userMv, 'Нарушитель');
// Модератора назначает владелец сервера (npm run moderator) — здесь прямо в базе.
legacyDb.prepare('INSERT INTO users (username, display_name, bio, email, password_hash, created_at, moderator) VALUES (?, ?, \'\', ?, ?, ?, 1)')
  .run(userMod, 'Модератор', `${userMod}@example.test`, LEGACY_HASH, new Date().toISOString());
r = await mod('/auth/login', { method: 'POST', body: JSON.stringify({ username: userMod, password: 'parol12345' }) });
check('вход модератора — сразу с флагом', r.body.user?.moderator === true, JSON.stringify(r.body.user));
const report = (client, targetType, targetId, reason, note) =>
  client('/reports', { method: 'POST', body: JSON.stringify({ targetType, targetId, reason, ...(note ? { note } : {}) }) });
const resolve = (client, targetType, targetId, action) =>
  client('/moderation/resolve', { method: 'POST', body: JSON.stringify({ targetType, targetId, action }) });
const openReports = async () => (await mod('/moderation/reports')).body.reports ?? [];

r = await mod('/auth/me');
check('модератор видит свой флаг', r.body.user?.moderator === true, JSON.stringify(r.body.user));
r = await mb('/auth/me');
check('у остальных флага нет', !('moderator' in (r.body.user ?? {})), JSON.stringify(r.body.user));
r = await guest('/moderation/reports');
check('панель — гостю 401', r.status === 401, `${r.status}`);
r = await mb('/moderation/reports');
check('панель — не модератору 403', r.status === 403, `${r.status}`);

r = await mv('/posts', { method: 'POST', body: JSON.stringify({ body: 'Купите мои курсы по заработку' }) });
const spamPost = r.body.post.id;
await report(mb, 'post', spamPost, 'spam', 'реклама');
await report(mc, 'post', spamPost, 'spam');
r = await mv(`/posts/${spamPost}/comments`, { method: 'POST', body: JSON.stringify({ body: 'и ещё раз реклама' }) });
const spamComment = r.body.comment.id;
await report(mb, 'comment', spamComment, 'spam');
r = await mb('/posts', { method: 'POST', body: JSON.stringify({ body: 'Обычная запись' }) });
const okPost = r.body.post.id;
await report(mc, 'post', okPost, 'other', 'не понравилось');

let list = await openReports();
const spamGroup = list.find((g) => g.targetType === 'post' && g.targetId === spamPost);
check('жалобы сгруппированы по записи: сколько, причины, комментарии', spamGroup?.count === 2 && spamGroup.reasons.spam === 2
  && spamGroup.notes.some((n) => n.reporter === userMb && n.note === 'реклама'), JSON.stringify(spamGroup));
check('в карточке — текст и автор', spamGroup?.subject?.text === 'Купите мои курсы по заработку' && spamGroup.subject.author?.username === userMv, JSON.stringify(spamGroup?.subject));
check('частые жалобы — сверху', list.findIndex((g) => g.targetId === spamPost && g.targetType === 'post') < list.findIndex((g) => g.targetId === okPost && g.targetType === 'post'), '');

r = await resolve(mod, 'post', okPost, 'dismiss');
check('жалоба отклонена — запись на месте', r.status === 200 && r.body.resolution === 'dismissed' && (await mb(`/posts/${okPost}`)).status === 200, `${r.status}`);
r = await resolve(mod, 'post', okPost, 'dismiss');
check('повторное решение — 404: открытых жалоб нет', r.status === 404, `${r.status}`);
r = await mod('/moderation/reports?status=resolved');
check('в разобранных — с решением', r.body.reports?.some((g) => g.targetId === okPost && g.resolution === 'dismissed'), '');
r = await report(mc, 'post', okPost, 'abuse');
check('новая жалоба на разобранное — снова открыта', r.status === 201 && r.body.alreadyReported === false
  && (await openReports()).some((g) => g.targetType === 'post' && g.targetId === okPost), JSON.stringify(r.body));
await resolve(mod, 'post', okPost, 'dismiss');

r = await resolve(mod, 'comment', spamComment, 'remove');
check('комментарий удалён модератором', r.status === 200 && r.body.resolution === 'removed'
  && !(await mb(`/posts/${spamPost}/comments`)).body.comments?.some((c) => c.id === spamComment), `${r.status}`);
r = await resolve(mod, 'user', 999999, 'remove');
check('без открытых жалоб — 404', r.status === 404, `${r.status}`);
r = await resolve(mod, 'post', spamPost, 'launch');
check('неизвестное решение — 400', r.status === 400, `${r.status}`);

r = await resolve(mod, 'post', spamPost, 'ban');
check('автор записи заблокирован', r.status === 200 && r.body.resolution === 'banned', `${r.status} ${JSON.stringify(r.body)}`);
r = await mv('/auth/me');
check('его сеанс закрыт сразу', r.body.user === null, JSON.stringify(r.body));
r = await makeClient()('/auth/login', { method: 'POST', body: JSON.stringify({ username: userMv, password: 'parol12345' }) });
check('войти нельзя — 403 «заблокирован»', r.status === 403 && /заблокирован/.test(r.body.error ?? ''), `${r.status} ${r.body.error}`);
r = await makeClient()('/auth/login', { method: 'POST', body: JSON.stringify({ username: userMv, password: 'ne-tot' }) });
check('с неверным паролем — обычное 401: блокировку не выдаём', r.status === 401, `${r.status}`);
r = await mod('/moderation/banned');
check('в списке заблокированных', r.body.users?.some((u) => u.username === userMv && u.reason.includes('post')), JSON.stringify(r.body));

await report(mb, 'user', (await mod('/auth/me')).body.user.id, 'abuse');
r = await resolve(mod, 'user', (await mod('/auth/me')).body.user.id, 'ban');
check('себя не заблокировать — 400', r.status === 400, `${r.status}`);
r = await resolve(mod, 'user', (await mod('/auth/me')).body.user.id, 'remove');
check('человека не «удалить» — 400', r.status === 400, `${r.status}`);

r = await mod(`/moderation/banned/${userMv}`, { method: 'DELETE' });
check('блокировка снята', r.status === 200, `${r.status}`);
r = await mv('/auth/login', { method: 'POST', body: JSON.stringify({ username: userMv, password: 'parol12345' }) });
check('после снятия — входит, записи на месте', r.status === 200 && (await mv(`/posts/${spamPost}`)).status === 200, `${r.status}`);
r = await mod(`/moderation/banned/${userMv}`, { method: 'DELETE' });
check('снять ещё раз — 404', r.status === 404, `${r.status}`);

console.log('\n— история звонков —');
// Звонки секции «сигнализация» между ka и kb: принятый видеозвонок, отклонённый,
// пропущенный и прерванный закрытием вкладки после ответа.
r = await ka(`/messages/${userKb}`);
const callRows = (r.body.messages ?? []).filter((m) => m.call);
check('в переписке — четыре записи о звонках', callRows.length === 4, JSON.stringify(callRows.map((m) => m.call)));
check('исходы по порядку: завершён, отклонён, пропущен, завершён', callRows.map((m) => m.call.outcome).join() === 'ended,declined,missed,ended', JSON.stringify(callRows.map((m) => m.call.outcome)));
check('первый — видеозвонок, с длительностью', callRows[0]?.call.video === true && Number.isInteger(callRows[0].call.duration), JSON.stringify(callRows[0]?.call));
check('у непринятых длительности нет', callRows[1]?.call.duration === null && callRows[2]?.call.duration === null, '');
const kaId = (await ka('/auth/me')).body.user.id;
const kbId = (await kb('/auth/me')).body.user.id;
check('запись — от звонившего вызываемому, без текста', callRows.every((m) => m.fromId === kaId && m.toId === kbId && m.body === ''), '');
r = await kb('/messages');
const kbConv = r.body.conversations?.find((c) => c.user.username === userKa);
check('пропущенный — непрочитан у вызываемого', kbConv?.unread === 1 && kbConv.lastMessage.call?.outcome === 'ended', JSON.stringify({ unread: kbConv?.unread, last: kbConv?.lastMessage.call }));
r = await kb('/notifications');
check('о пропущенном — событие', r.body.notifications?.some((n) => n.kind === 'message' && n.actor.username === userKa), '');
r = await ka(`/messages/${userKb}/${callRows[0].id}`, { method: 'PATCH', body: JSON.stringify({ body: 'правка' }) });
check('запись о звонке не правится', r.status === 403, `${r.status}`);
r = await ka(`/messages/${userKb}`, { method: 'POST', body: JSON.stringify({ forward: { from: 'dm', id: callRows[0].id } }) });
check('и не пересылается', r.status === 400, `${r.status}`);

console.log('\n— архив чатов —');
const xa = makeClient();
const xb = makeClient();
const userXa = `archa_${stamp}`;
const userXb = `archb_${stamp}`;
await legacySignUp(xa, userXa, 'Архивариус');
await legacySignUp(xb, userXb, 'Собеседник');
await dmSend(xb, userXa, { body: 'Привет' });
const setPref = (client, kind, target, body) => client(`/prefs/${kind}/${target}`, { method: 'PUT', body: JSON.stringify(body) });
const dmRow = async () => (await xa('/messages')).body.conversations?.find((c) => c.user.username === userXb);

r = await setPref(xa, 'dm', userXb, { archived: 'да' });
check('archived не да/нет — 400', r.status === 400, `${r.status}`);
r = await setPref(xa, 'dm', userXb, { archived: true });
check('переписка убрана в архив', r.status === 200 && r.body.archived === true && r.body.muted === false, JSON.stringify(r.body));
check('в списке — с пометкой «в архиве»', (await dmRow())?.archived === true, '');
check('у собеседника — нет: архив свой у каждого', (await xb('/messages')).body.conversations?.find((c) => c.user.username === userXa)?.archived === false, '');
await sleep(5);
await dmSend(xb, userXa, { body: 'Ты тут?' });
check('новое сообщение возвращает из архива', (await dmRow())?.archived === false, '');
await setPref(xa, 'dm', userXb, { archived: true, muted: true });
await sleep(5);
await dmSend(xb, userXa, { body: 'Всё равно пишу' });
check('приглушённая переписка в архиве остаётся', (await dmRow())?.archived === true, '');
r = await setPref(xa, 'dm', userXb, { archived: false });
check('вернуть из архива вручную', r.body.archived === false && (await dmRow())?.archived === false && r.body.muted === true, JSON.stringify(r.body));
r = await xa(`/prefs/dm/${userXb}`);
check('настройки читаются с архивом', r.status === 200 && r.body.archived === false, JSON.stringify(r.body));

r = await xa('/chats', { method: 'POST', body: JSON.stringify({ title: 'Архивная', members: [userXb] }) });
const xchat = r.body.chat.id;
await setPref(xa, 'chat', xchat, { archived: true });
check('пустая группа в архиве', (await xa('/chats')).body.chats?.find((c) => c.id === xchat)?.archived === true, '');
await sleep(5);
await xb(`/chats/${xchat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Оживим' }) });
check('сообщение в группе возвращает её из архива', (await xa('/chats')).body.chats?.find((c) => c.id === xchat)?.archived === false, '');
r = await xb('/channels', { method: 'POST', body: JSON.stringify({ title: 'Архивный канал', handle: `archch_${stamp}` }) });
await xa(`/channels/archch_${stamp}/subscription`, { method: 'PUT' });
await setPref(xa, 'channel', `archch_${stamp}`, { archived: true });
check('канал в архиве', (await xa('/channels')).body.channels?.find((c) => c.handle === `archch_${stamp}`)?.archived === true, '');
await sleep(5);
await xb(`/channels/archch_${stamp}/posts`, { method: 'POST', body: JSON.stringify({ body: 'Новая публикация' }) });
check('новая публикация возвращает канал', (await xa('/channels')).body.channels?.find((c) => c.handle === `archch_${stamp}`)?.archived === false, '');

console.log('\n— вход по QR-коду —');
const phone = makeClient();
const desk = makeClient();
const userQr = `qrusr_${stamp}`;
await legacySignUp(phone, userQr, 'Телефонный');
const DESK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const qrCreate = (client) => client('/auth/qr', { method: 'POST', headers: { 'User-Agent': DESK_UA } });
const qrPoll = (client, token, secret) => client('/auth/qr/poll', { method: 'POST', body: JSON.stringify({ token, secret }) });

r = await qrCreate(phone);
check('уже вошедшему код не нужен — 400', r.status === 400, `${r.status}`);
r = await qrCreate(desk);
const qr = r.body;
check('компьютер получил токен, код и секрет', r.status === 201 && /^[A-Za-z0-9_-]{22}$/.test(qr.token ?? '') && /^[A-HJ-NP-Z2-9]{8}$/.test(qr.code ?? '')
  && typeof qr.secret === 'string' && qr.expiresIn === 120, JSON.stringify(qr));
r = await qrPoll(desk, qr.token, 'чужой секрет');
check('без верного секрета — будто кода нет', r.status === 410, `${r.status}`);
r = await qrPoll(desk, qr.token, qr.secret);
check('пока не подтвердили — ждём', r.status === 200 && r.body.status === 'pending', JSON.stringify(r.body));
r = await guest(`/auth/qr/${qr.token}`);
check('посмотреть запрос — только вошедшему', r.status === 401, `${r.status}`);
r = await phone(`/auth/qr/${qr.token}`);
check('телефон видит, какое устройство просит войти', r.status === 200 && r.body.device === 'Chrome, Windows' && r.body.expiresIn > 100, JSON.stringify(r.body));
const typed = `${qr.code.slice(0, 4).toLowerCase()}-${qr.code.slice(4)}`;
r = await phone(`/auth/qr/${encodeURIComponent(typed)}`);
check('и по коду, набранному как попало', r.status === 200 && r.body.device === 'Chrome, Windows', `${r.status}`);
r = await phone('/auth/qr/approve', { method: 'POST', body: JSON.stringify({ code: 'AAAAAAAA' }) });
check('выдуманный код — 404', r.status === 404, `${r.status}`);
r = await phone('/auth/qr/approve', { method: 'POST', body: JSON.stringify({ code: typed }) });
check('телефон подтвердил вход', r.status === 200 && r.body.device === 'Chrome, Windows', JSON.stringify(r.body));
r = await phone('/auth/qr/approve', { method: 'POST', body: JSON.stringify({ token: qr.token }) });
check('подтвердить второй раз нельзя', r.status === 404, `${r.status}`);
r = await qrPoll(desk, qr.token, qr.secret);
check('компьютер вошёл в тот же аккаунт', r.status === 200 && r.body.status === 'approved' && r.body.user?.username === userQr
  && (await desk('/auth/me')).body.user?.username === userQr, JSON.stringify(r.body));
r = await qrPoll(desk, qr.token, qr.secret);
check('код одноразовый', r.status === 410, `${r.status}`);
r = await phone('/notifications');
check('на телефоне — событие о входе с компьютера', r.body.notifications?.[0]?.kind === 'new_login' && r.body.notifications[0].device === 'Chrome, Windows', JSON.stringify(r.body.notifications?.[0]));
r = await phone('/account/sessions');
check('новый сеанс — с устройством компьютера', r.body.sessions?.some((s) => !s.current && /Chrome/.test(s.userAgent ?? '')), JSON.stringify(r.body.sessions));

console.log('\n— автоудаление —');
// Ждать сутки тест не может: срок сообщения сдвигается в прошлое прямо в базе,
// а убирает его обычный такт планировщика (SCHEDULE_TICK_MS=500).
const ad = makeClient();
const ae = makeClient();
const userAd = `autod_${stamp}`;
const userAe = `autoe_${stamp}`;
await legacySignUp(ad, userAd, 'Исчезающий');
await legacySignUp(ae, userAe, 'Собеседница');
const DAY = 86400;
const expireNow = (table, id) => legacyDb.prepare(`UPDATE ${table} SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), id);
const setTimer = (client, to, seconds) => client(`/messages/${to}/auto-delete`, { method: 'PUT', body: JSON.stringify({ seconds }) });

r = await dmSend(ad, userAe, { body: 'До таймера' });
const preTimer = r.body.message;
check('до таймера срока нет', preTimer.expiresAt === null, JSON.stringify(preTimer.expiresAt));
r = await setTimer(ad, userAe, 5);
check('таймер не из списка — 400', r.status === 400, `${r.status}`);
r = await setTimer(ad, userAe, DAY);
check('таймер включён', r.status === 200 && r.body.autoDelete === DAY, JSON.stringify(r.body));
r = await ae(`/messages/${userAd}`);
check('таймер общий — собеседник его видит', r.body.autoDelete === DAY, `${r.body.autoDelete}`);
r = await dmSend(ae, userAd, { body: 'Исчезну через сутки' });
const fading = r.body.message;
const fadeLeft = Date.parse(fading.expiresAt) - Date.now();
// Допуск в пять секунд: системные часы подстраиваются, и «сейчас» теста может
// оказаться на миг раньше «сейчас» сервера.
check('новое сообщение — со сроком через сутки', fadeLeft > DAY * 1000 - 60_000 && fadeLeft <= DAY * 1000 + 5_000, fading.expiresAt);
r = await ad(`/messages/${userAe}`, { method: 'POST', body: withFile(PNG, 'kadr.png', 'image/png', { body: 'С файлом' }) });
const withPhoto = r.body.message;
await ad(`/messages/${userAe}/${fading.id}/pin`, { method: 'PUT' });
expireNow('messages', fading.id);
expireNow('messages', withPhoto.id);
await sleep(1200);
r = await ad(`/messages/${userAe}`);
check('истёкшие исчезли, старое на месте', !r.body.messages?.some((m) => m.id === fading.id || m.id === withPhoto.id)
  && r.body.messages?.some((m) => m.id === preTimer.id), JSON.stringify(r.body.messages?.map((m) => m.id)));
check('закреплённое снято вместе с ним', r.body.pinned === null, JSON.stringify(r.body.pinned));
raw = await ad.raw(withPhoto.attachment.url);
check('файл вложения удалён', raw.status === 404, `${raw.status}`);
await setTimer(ae, userAd, 0);
r = await dmSend(ad, userAe, { body: 'Таймер выключили' });
check('любой из двоих выключает — новые без срока', r.body.message.expiresAt === null && (await ad(`/messages/${userAe}`)).body.autoDelete === 0, '');

r = await ad('/chats', { method: 'POST', body: JSON.stringify({ title: 'Временная', members: [userAe] }) });
const tchat = r.body.chat.id;
r = await ae(`/chats/${tchat}`, { method: 'PATCH', body: JSON.stringify({ autoDelete: DAY }) });
check('в группе таймер — не участнику', r.status === 403, `${r.status}`);
r = await ad(`/chats/${tchat}`, { method: 'PATCH', body: JSON.stringify({ autoDelete: 7 * DAY }) });
check('владелец включил автоудаление в группе', r.status === 200 && r.body.chat?.autoDelete === 7 * DAY, `${r.status}`);
r = await ae(`/chats/${tchat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'На неделю' }) });
const weekMsg = r.body.message;
check('сообщение в группе — со сроком через неделю', Date.parse(weekMsg.expiresAt) - Date.now() > 7 * DAY * 1000 - 60_000, weekMsg.expiresAt);
expireNow('chat_messages', weekMsg.id);
await sleep(1200);
r = await ad(`/chats/${tchat}/messages`);
check('истёкшее в группе исчезло', !r.body.messages?.some((m) => m.id === weekMsg.id), '');

const tHandle = `timed_${stamp}`;
await ad('/channels', { method: 'POST', body: JSON.stringify({ title: 'Временный канал', handle: tHandle }) });
r = await ad(`/channels/${tHandle}`, { method: 'PATCH', body: JSON.stringify({ autoDelete: 30 * DAY }) });
check('в канале таймер ставит владелец', r.status === 200 && r.body.channel?.autoDelete === 30 * DAY, `${r.status}`);
r = await ad(`/channels/${tHandle}/posts`, { method: 'POST', body: JSON.stringify({ body: 'На месяц' }) });
const monthPost = r.body.post;
check('публикация — со сроком через месяц', Boolean(monthPost?.expiresAt), JSON.stringify(monthPost?.expiresAt));
expireNow('channel_posts', monthPost.id);
await sleep(1200);
r = await ad(`/channels/${tHandle}/posts`);
check('истёкшая публикация исчезла', !r.body.posts?.some((x) => x.id === monthPost.id), '');

await ae(`/users/${userAd}/block`, { method: 'PUT' });
r = await setTimer(ad, userAe, DAY);
check('в блокировке таймер не поставить', r.status === 403, `${r.status}`);

console.log('\n— выгрузка своих данных —');
const ex = makeClient();
const ey = makeClient();
const userEx = `expa_${stamp}`;
const userEy = `expb_${stamp}`;
await legacySignUp(ex, userEx, 'Выгружающий');
await legacySignUp(ey, userEy, 'Собеседник');
r = await ex('/posts', { method: 'POST', body: JSON.stringify({ body: 'Моя запись для выгрузки' }) });
const exPost = r.body.post.id;
await ey(`/posts/${exPost}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Чужой комментарий' }) });
await ex(`/posts/${exPost}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Мой комментарий' }) });
await ex(`/users/${userEy}/follow`, { method: 'PUT' });
await dmSend(ex, userEy, { body: 'Я пишу' });
await dmSend(ey, userEx, { body: 'Мне отвечают' });
r = await ex('/chats', { method: 'POST', body: JSON.stringify({ title: 'Выгрузочная', members: [userEy] }) });
const exChat = r.body.chat.id;
await ex(`/chats/${exChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Моё в группе' }) });
await ey(`/chats/${exChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Чужое в группе' }) });
await ex('/channels', { method: 'POST', body: JSON.stringify({ title: 'Мой канал', handle: `expch_${stamp}` }) });
await ex(`/channels/expch_${stamp}/posts`, { method: 'POST', body: JSON.stringify({ body: 'Публикация в канале' }) });

r = await guest('/account/export');
check('выгрузка — гостю 401', r.status === 401, `${r.status}`);
raw = await ex.raw('/api/account/export');
const exportText = await raw.text();
const dump = JSON.parse(exportText);
check('выгрузка — файлом с именем', raw.status === 200 && /attachment; filename="hronika-expa_\w+-\d{4}-\d{2}-\d{2}\.json"/.test(raw.headers.get('content-disposition') ?? '')
  && /no-store/.test(raw.headers.get('cache-control') ?? ''), raw.headers.get('content-disposition'));
check('профиль и формат', dump.format === 'hronika-export/1' && dump.profile?.username === userEx && dump.profile.displayName === 'Выгружающий', JSON.stringify(dump.profile));
check('записи и только свои комментарии', dump.posts?.some((x) => x.body === 'Моя запись для выгрузки')
  && dump.comments?.length === 1 && dump.comments[0].body === 'Мой комментарий', JSON.stringify(dump.comments));
check('подписки', dump.following?.some((f) => f.username === userEy), JSON.stringify(dump.following));
const exConv = dump.conversations?.find((c) => c.with === userEy);
check('личная переписка — обе стороны', exConv?.messages.some((m) => m.from === 'me' && m.body === 'Я пишу')
  && exConv.messages.some((m) => m.from === userEy && m.body === 'Мне отвечают'), JSON.stringify(exConv));
const exGroup = dump.groups?.find((g) => g.id === exChat);
check('в группе — только свои сообщения', exGroup?.myMessages.length === 1 && exGroup.myMessages[0].body === 'Моё в группе', JSON.stringify(exGroup));
check('свой канал с публикациями', dump.channels?.own?.[0]?.posts?.[0]?.body === 'Публикация в канале', JSON.stringify(dump.channels));
check('сеансы — без токенов', dump.sessions?.length >= 1 && dump.sessions.every((s) => !('token' in s)), JSON.stringify(dump.sessions));
check('ни хеша пароля, ни токенов', !/scrypt\$|password_hash|"token"/.test(exportText), exportText.match(/scrypt\$|password_hash|"token"/)?.[0]);

console.log('\n— разметка текста —');
const mkA = makeClient();
const mkB = makeClient();
const userMkA = `fmta_${stamp}`;
const userMkB = `fmtb_${stamp}`;
await legacySignUp(mkA, userMkA, 'Оформитель');
await legacySignUp(mkB, userMkB, 'Читатель');
const markedText = '**Итог:** __переносим__ на ~~среду~~ четверг, ||торт — сюрприз||, `npm run dev`';
r = await dmSend(mkA, userMkB, { body: markedText });
const markedMsg = r.body.message;
check('текст хранится со знаками, как написан', r.status === 201 && markedMsg?.body === markedText, `${r.status} ${markedMsg?.body}`);
r = await dmSend(mkB, userMkA, { body: 'Понял', replyTo: markedMsg.id });
check('цитата в ответе — без знаков, спойлер скрыт',
  r.body.message?.replyTo?.body === 'Итог: переносим на среду четверг, ▒▒▒, npm run dev', r.body.message?.replyTo?.body);
r = await mkA(`/messages/${userMkB}/${markedMsg.id}/pin`, { method: 'PUT' });
check('закреплённое — тоже без знаков', r.body.pinned?.body?.startsWith('Итог: переносим') && !r.body.pinned.body.includes('сюрприз'), r.body.pinned?.body);
r = await mkB(`/messages/${userMkA}/search?q=${encodeURIComponent('переносим')}`);
check('найденное — без знаков', r.body.results?.[0]?.body?.startsWith('Итог: переносим на среду'), JSON.stringify(r.body.results?.[0]));
r = await dmSend(mkA, userMkB, { body: '2 ** 3 = 8, а a__b__c — имя' });
r = await dmSend(mkB, userMkA, { body: 'ок', replyTo: r.body.message.id });
check('знаки у пробела и внутри слова — как у клиента', r.body.message?.replyTo?.body === '2 ** 3 = 8, а abc — имя', r.body.message?.replyTo?.body);

console.log('\n— кто поставил реакцию —');
const rxA = makeClient();
const rxB = makeClient();
const rxC = makeClient();
const rxOut = makeClient();
const userRxA = `rxa_${stamp}`;
const userRxB = `rxb_${stamp}`;
const userRxC = `rxc_${stamp}`;
const userRxOut = `rxo_${stamp}`;
await legacySignUp(rxA, userRxA, 'Автор');
await legacySignUp(rxB, userRxB, 'Бета');
await legacySignUp(rxC, userRxC, 'Гамма');
await legacySignUp(rxOut, userRxOut, 'Посторонний');
r = await rxA('/chats', { method: 'POST', body: JSON.stringify({ title: 'Реакции', members: [userRxB, userRxC] }) });
const rxChat = r.body.chat.id;
r = await rxA(`/chats/${rxChat}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Кто за?' }) });
const rxMsg = r.body.message.id;
const rxPath = `/chats/${rxChat}/messages/${rxMsg}`;
await rxB(`${rxPath}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji: '👍' }) });
await new Promise((ok) => setTimeout(ok, 15));
await rxC(`${rxPath}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji: '🔥' }) });
r = await rxB(`${rxPath}/reactions`);
check('список реакций — любому участнику, свежие сверху',
  r.status === 200 && r.body.reactions?.map((x) => `${x.user.username}:${x.emoji}`).join(',') === `${userRxC}:🔥,${userRxB}:👍`,
  `${r.status} ${JSON.stringify(r.body)}`);
check('у реакции — человек и время, без лишнего', typeof r.body.reactions?.[0]?.at === 'string' && r.body.reactions[0].user.displayName === 'Гамма'
  && !('email' in r.body.reactions[0].user), JSON.stringify(r.body.reactions?.[0]));
await rxB(`${rxPath}/reaction`, { method: 'PUT', body: JSON.stringify({ emoji: '❤️' }) });
r = await rxA(`${rxPath}/reactions`);
check('сменил реакцию — в списке одна, новая', r.body.reactions?.filter((x) => x.user.username === userRxB).map((x) => x.emoji).join() === '❤️', JSON.stringify(r.body));
r = await rxOut(`${rxPath}/reactions`);
check('не участнику — 404', r.status === 404, `${r.status}`);
r = await rxA(`/chats/${rxChat}/messages/999999999/reactions`);
check('чужое или несуществующее сообщение — 404', r.status === 404, `${r.status}`);
await rxA(`/users/${userRxC}/block`, { method: 'PUT' });
r = await rxA(`${rxPath}/reactions`);
check('заблокированного в списке нет', r.body.reactions?.length === 1 && r.body.reactions[0].user.username === userRxB, JSON.stringify(r.body));
r = await rxC(`${rxPath}/reactions`);
check('заблокированный не видит и само сообщение — 404, как везде', r.status === 404, `${r.status}`);

console.log('\n— вход с кодом из приложения —');
const tf = makeClient();
const userTf = `totp_${stamp}`;
await legacySignUp(tf, userTf, 'Осторожный');
const tfLogin = (client) => client('/auth/login', { method: 'POST', body: JSON.stringify({ username: userTf, password: 'parol12345' }) });
const tfCode = (client, ticket, code) => client('/auth/2fa', { method: 'POST', body: JSON.stringify({ ticket, code }) });

r = await guest('/account/2fa/setup', { method: 'POST', body: '{}' });
check('гостю — 401', r.status === 401, `${r.status}`);
r = await tf('/account');
check('по умолчанию выключено', r.body.twoFactor?.enabled === false, JSON.stringify(r.body.twoFactor));
r = await tf('/account/2fa/setup', { method: 'POST', body: JSON.stringify({ password: 'не тот' }) });
check('подключение — только с паролем, если он есть', r.status === 403, `${r.status}`);
r = await tf('/account/2fa/setup', { method: 'POST', body: JSON.stringify({ password: 'parol12345' }) });
const tfSecret = r.body.secret;
check('секрет и адрес для QR', r.status === 200 && /^[A-Z2-7]{32}$/.test(tfSecret ?? '')
  && r.body.uri === `otpauth://totp/${encodeURIComponent('Хроника')}:${userTf}?secret=${tfSecret}&issuer=${encodeURIComponent('Хроника')}&algorithm=SHA1&digits=6&period=30`,
  JSON.stringify(r.body));
r = await tf('/account');
check('пока код не подтверждён — не включено', r.body.twoFactor?.enabled === false, JSON.stringify(r.body.twoFactor));
r = await tfLogin(makeClient());
check('и вход пока без кода', r.status === 200 && r.body.user?.username === userTf, JSON.stringify(r.body));
r = await tf('/account/2fa/enable', { method: 'POST', body: JSON.stringify({ code: '000000' === totpCode(tfSecret) ? '111111' : '000000' }) });
check('неверный первый код — не включает', r.status === 403, `${r.status}`);
const enableCode = totpCode(tfSecret);
r = await tf('/account/2fa/enable', { method: 'POST', body: JSON.stringify({ code: enableCode }) });
const backup = r.body.backupCodes ?? [];
check('включено: десять резервных кодов вида xxxx-xxxx', r.status === 200 && backup.length === 10 && backup.every((c) => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(c))
  && new Set(backup).size === 10, JSON.stringify(r.body));
r = await tf('/account');
check('в настройках — включено и сколько кодов осталось', r.body.twoFactor?.enabled === true && r.body.twoFactor.backupCodesLeft === 10, JSON.stringify(r.body.twoFactor));

const tfNew = makeClient();
r = await tfLogin(tfNew);
check('пароль верный — ещё не вход, а шаг с кодом', r.status === 200 && r.body.status === 'two-factor' && typeof r.body.ticket === 'string' && !r.body.user,
  JSON.stringify(r.body));
const tfTicket = r.body.ticket;
check('сеанса после пароля нет', (await tfNew('/auth/me')).body.user === null, '');
r = await tfLogin(makeClient());
r = await makeClient()('/auth/login', { method: 'POST', body: JSON.stringify({ username: userTf, password: 'не тот' }) });
check('неверный пароль — как раньше, 401 без намёка на код', r.status === 401 && !r.body.ticket, JSON.stringify(r.body));
r = await tfCode(tfNew, tfTicket, enableCode);
check('код, которым включали, второй раз не проходит', r.status === 403, `${r.status}`);
r = await tfCode(tfNew, tfTicket, totpCode(tfSecret, 1));
check('свежий код — вход', r.status === 200 && r.body.user?.username === userTf && (await tfNew('/auth/me')).body.user?.username === userTf,
  `${r.status} ${JSON.stringify(r.body)}`);
r = await tfCode(tfNew, tfTicket, totpCode(tfSecret, 1));
check('билет одноразовый', r.status === 410, `${r.status}`);
r = await tfCode(tfNew, 'выдуманный', totpCode(tfSecret));
check('выдуманный билет — 410', r.status === 410, `${r.status}`);

const tfGuess = makeClient();
r = await tfLogin(tfGuess);
const guessTicket = r.body.ticket;
for (let i = 0; i < 5; i++) r = await tfCode(tfGuess, guessTicket, String(100000 + i));
check('пять неверных кодов — билет сгорает', r.status === 403 && (await tfCode(tfGuess, guessTicket, totpCode(tfSecret))).status === 410, `${r.status}`);

const tfBackup = makeClient();
r = await tfLogin(tfBackup);
r = await tfCode(tfBackup, r.body.ticket, backup[0].toUpperCase().replace('-', ' '));
check('резервный код (в любом регистре, с пробелом) — вход и сколько осталось', r.status === 200 && r.body.backupCodesLeft === 9, JSON.stringify(r.body));
r = await tfLogin(makeClient());
r = await tfCode(makeClient(), r.body.ticket, backup[0]);
check('резервный код одноразовый', r.status === 403, `${r.status}`);

r = await tf('/account/2fa/backup-codes', { method: 'POST', body: JSON.stringify({ code: 'не код' }) });
check('новые резервные коды — только с кодом', r.status === 403, `${r.status}`);
r = await tf('/account/2fa/backup-codes', { method: 'POST', body: JSON.stringify({ code: backup[1] }) });
const backup2 = r.body.backupCodes ?? [];
check('новые резервные коды', r.status === 200 && backup2.length === 10 && !backup2.includes(backup[2]), `${r.status}`);
const tfOld = makeClient();
r = await tfLogin(tfOld);
r = await tfCode(tfOld, r.body.ticket, backup[2]);
check('прежние резервные коды больше не работают', r.status === 403, `${r.status}`);

r = await tf('/account/2fa/disable', { method: 'POST', body: JSON.stringify({ password: 'не тот', code: backup2[0] }) });
check('выключить — не без пароля', r.status === 403, `${r.status}`);
r = await tf('/account/2fa/disable', { method: 'POST', body: JSON.stringify({ password: 'parol12345', code: '123' }) });
check('и не без кода', r.status === 403, `${r.status}`);
r = await tf('/account/2fa/disable', { method: 'POST', body: JSON.stringify({ password: 'parol12345', code: backup2[0] }) });
check('выключено паролем и резервным кодом', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
r = await tfLogin(makeClient());
check('после выключения — снова вход одним паролем', r.status === 200 && r.body.user?.username === userTf, JSON.stringify(r.body));
r = await tf('/account');
check('в настройках — выключено', r.body.twoFactor?.enabled === false, JSON.stringify(r.body.twoFactor));

console.log('\n— автозавершение сеансов —');
const ttlA = makeClient();
const ttlB = makeClient();
const ttlC = makeClient();
const userTtl = `ttl_${stamp}`;
await legacySignUp(ttlA, userTtl, 'Сеансовый');
const ttlLogin = (client) => client('/auth/login', { method: 'POST', body: JSON.stringify({ username: userTtl, password: 'parol12345' }) });
await ttlLogin(ttlB);
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const sessionIdOf = async (client) => (await client('/account/sessions')).body.sessions?.find((s) => s.current)?.id;
const idTtlA = await sessionIdOf(ttlA);
const idTtlB = await sessionIdOf(ttlB);

r = await ttlA('/account');
check('по умолчанию — месяц без использования', r.body.sessionTtlDays === 30, JSON.stringify(r.body.sessionTtlDays));
r = await ttlA('/account/sessions');
check('у сеанса — когда им пользовались', r.body.sessions?.length === 2 && r.body.sessions.every((s) => typeof s.lastUsedAt === 'string'), JSON.stringify(r.body.sessions));
r = await ttlA('/account/session-ttl', { method: 'PUT', body: JSON.stringify({ days: 3 }) });
check('срок не из списка — 400', r.status === 400, `${r.status}`);
r = await guest('/account/session-ttl', { method: 'PUT', body: JSON.stringify({ days: 7 }) });
check('гостю — 401', r.status === 401, `${r.status}`);

// Вторым сеансом не пользовались десять дней — неделя его закрывает сразу.
legacyDb.prepare('UPDATE sessions SET last_used_at = ? WHERE rowid = ?').run(agoIso(10 * 864e5), idTtlB);
r = await ttlA('/account/session-ttl', { method: 'PUT', body: JSON.stringify({ days: 7 }) });
check('срок «неделя» — давно неактивный сеанс закрыт сразу', r.status === 200 && r.body.days === 7 && r.body.ended === 1, JSON.stringify(r.body));
check('им больше не войти', (await ttlB('/auth/me')).body.user === null, '');
check('текущий — на месте', (await ttlA('/auth/me')).body.user?.username === userTtl, '');
r = await ttlA('/account');
check('в настройках — неделя', r.body.sessionTtlDays === 7, JSON.stringify(r.body.sessionTtlDays));

// Пользуются — срок сдвигается вперёд (не чаще раза в час) вместе с кукой.
legacyDb.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE rowid = ?')
  .run(agoIso(2 * 3_600_000), new Date(Date.now() + 3_600_000).toISOString(), idTtlA);
raw = await ttlA.raw('/api/auth/me');
const extended = legacyDb.prepare('SELECT expires_at FROM sessions WHERE rowid = ?').get(idTtlA);
const extendedLeft = Date.parse(extended?.expires_at) - Date.now();
check('пользуются — срок сдвинут на неделю вперёд', extendedLeft > 7 * 864e5 - 60_000 && extendedLeft <= 7 * 864e5 + 5_000, extended?.expires_at);
check('и кука продлена', /sid=/.test(raw.headers.get('set-cookie') ?? ''), raw.headers.get('set-cookie'));
raw = await ttlA.raw('/api/auth/me');
check('свежий сеанс не продлевается на каждом запросе', !raw.headers.get('set-cookie'), raw.headers.get('set-cookie'));

// Истёкшие убирает такт планировщика — вместе с их пуш-подписками.
await ttlLogin(ttlC);
const idTtlC = await sessionIdOf(ttlC);
legacyDb.prepare('UPDATE sessions SET expires_at = ? WHERE rowid = ?').run(agoIso(1000), idTtlC);
await sleep(Number(process.env.SCHEDULE_TICK_MS ?? 500) * 2 + 300);
check('истёкший сеанс убран тактом планировщика', !legacyDb.prepare('SELECT 1 FROM sessions WHERE rowid = ?').get(idTtlC), '');

console.log('\n— прочитать все —');
const raA = makeClient();
const raB = makeClient();
const userRaA = `rda_${stamp}`;
const userRaB = `rdb_${stamp}`;
await legacySignUp(raA, userRaA, 'Читатель');
await legacySignUp(raB, userRaB, 'Писатель');
const raHandle = `rdch_${stamp}`.slice(0, 32);
await raB('/channels', { method: 'POST', body: JSON.stringify({ title: 'Новости', handle: raHandle }) });
await raA(`/channels/${raHandle}/subscription`, { method: 'PUT' });
r = await raB('/chats', { method: 'POST', body: JSON.stringify({ title: 'Читальня', members: [userRaA] }) });
const raChat = r.body.chat.id;
// Один чат приглушён и убран в архив — «прочитать все» касается и его.
await raA(`/prefs/chat/${raChat}`, { method: 'PUT', body: JSON.stringify({ muted: true, archived: true }) });
await dmSend(raB, userRaA, { body: 'Раз' });
const raDm = (await dmSend(raB, userRaA, { body: 'Два' })).body.message;
await raB(`/chats/${raChat}/messages`, { method: 'POST', body: JSON.stringify({ body: `@${userRaA}, глянь` }) });
await raB(`/channels/${raHandle}/posts`, { method: 'POST', body: JSON.stringify({ body: 'Свежая новость' }) });
const unreadOf = async () => ({
  dm: (await raA('/messages')).body.conversations?.find((c) => c.user.username === userRaB)?.unread,
  chat: (await raA('/chats')).body.chats?.find((c) => c.id === raChat)?.unread,
  channel: (await raA('/channels')).body.channels?.find((c) => c.handle === raHandle)?.unread,
});
check('до — непрочитано везде', JSON.stringify(await unreadOf()) === JSON.stringify({ dm: 2, chat: 1, channel: 1 }), JSON.stringify(await unreadOf()));

r = await guest('/read-all', { method: 'POST' });
check('гостю — 401', r.status === 401, `${r.status}`);
r = await raA('/read-all', { method: 'POST' });
check('прочитать все — сколько отмечено', r.status === 200 && r.body.dms === 2 && r.body.chats === 1 && r.body.channels === 1, JSON.stringify(r.body));
check('после — ноль везде, и в приглушённом архивном чате', JSON.stringify(await unreadOf()) === JSON.stringify({ dm: 0, chat: 0, channel: 0 }), JSON.stringify(await unreadOf()));
r = await raA('/chats');
check('и «@» в списке погас', r.body.chats?.find((c) => c.id === raChat)?.mentions === 0, '');
r = await raA('/notifications');
check('события о сообщениях и упоминании прочитаны', (r.body.notifications ?? []).filter((n) => ['message', 'chat_message', 'mention'].includes(n.kind)).every((n) => n.readAt != null), JSON.stringify(r.body.notifications?.map((n) => [n.kind, n.readAt])));
r = await raB(`/messages/${userRaA}`);
check('у отправителя — вторые галочки', r.body.messages?.find((m) => m.id === raDm.id)?.readAt != null, JSON.stringify(r.body.messages?.at(-1)));
r = await raA('/read-all', { method: 'POST' });
check('повторно — отмечать нечего', r.body.dms === 0 && r.body.chats === 0 && r.body.channels === 0, JSON.stringify(r.body));

console.log(`\n${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);

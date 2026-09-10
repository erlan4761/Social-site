// Прогоняет API целиком по живому серверу.
// Сервер нужно поднять с RELAX_RATE_LIMITS=1, иначе лимит регистраций
// (10 в час на IP) остановит прогон на середине.
import { DatabaseSync } from 'node:sqlite';

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

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

function makeClient() {
  let cookie = '';
  return async function call(path, init = {}) {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        // FormData ставит свой Content-Type с boundary — перебивать нельзя.
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.startsWith('sid=')) cookie = pair.endsWith('sid=') ? '' : pair;
    }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
}

const stamp = Date.now().toString(36).slice(-5);
const a = makeClient();
const b = makeClient();
const anon = makeClient();

const userA = `alice_${stamp}`;
const userB = `bob_${stamp}`;

console.log('\n— регистрация и сессия —');
let r = await a('/auth/register', { method: 'POST', body: JSON.stringify({ username: userA, displayName: 'Алиса Иванова', email: `${userA}@example.test`, password: 'parol12345' }) });
check('register 201', r.status === 201, JSON.stringify(r.body));
check('вернулся пользователь', r.body.user?.username === userA, JSON.stringify(r.body));
check('хэш пароля не утёк', !JSON.stringify(r.body).includes('scrypt'));

r = await a('/auth/me');
check('me видит сессию', r.body.user?.username === userA, JSON.stringify(r.body));

r = await anon('/auth/me');
check('me без куки = null', r.body.user === null, JSON.stringify(r.body));

console.log('\n— валидация —');
r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: 'ЮзерКириллица', displayName: 'x', email: `kir_${stamp}@example.test`, password: 'parol12345' }) });
check('кириллица в логине отклонена', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: `zed_${stamp}`, displayName: 'z', email: `zed_${stamp}@example.test`, password: 'korotk' }) });
check('короткий пароль отклонён', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: userA.toUpperCase(), displayName: 'дубль', email: `dup_${stamp}@example.test`, password: 'parol12345' }) });
check('занятый логин (в другом регистре) отклонён', r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);

console.log('\n— вход —');
r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: userB, displayName: 'Борис', email: `${userB}@example.test`, password: 'parol12345' }) });
check('второй пользователь создан', r.status === 201, JSON.stringify(r.body));

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
await c('/auth/register', { method: 'POST', body: JSON.stringify({ username: userC, displayName: 'Карл', email: `${userC}@example.test`, password: 'parol12345' }) });
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
check('нельзя написать себе', r.status === 400, `${r.status}`);

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

console.log('\n— email при регистрации —');
r = await anon('/auth/register', { method: 'POST', body: JSON.stringify({ username: `noemail_${stamp}`, displayName: 'x', password: 'parol12345' }) });
check('регистрация без email отклонена', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await anon('/auth/register', { method: 'POST', body: JSON.stringify({ username: `bad_${stamp}`, displayName: 'x', email: 'не-похоже-на-почту', password: 'parol12345' }) });
check('кривой email отклонён', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await anon('/auth/register', { method: 'POST', body: JSON.stringify({ username: `second_${stamp}`, displayName: 'x', email: `${userA}@example.test`, password: 'parol12345' }) });
check('занятый email (другой логин) отклонён', r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);

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

const signUp = (client, name, displayName) => client('/auth/register', {
  method: 'POST',
  body: JSON.stringify({ username: name, displayName, email: `${name}@example.test`, password: 'parol12345' }),
});

console.log('\n— уведомления —');
r = await signUp(n, userN, 'Ника');
check('Ника зарегистрирована', r.status === 201, JSON.stringify(r.body));
r = await signUp(o, userO, 'Олег');
check('Олег зарегистрирован', r.status === 201, JSON.stringify(r.body));
r = await signUp(p, userP, 'Павел');
check('Павел зарегистрирован', r.status === 201, JSON.stringify(r.body));
r = await signUp(d, userD, 'Дина');
check('Дина зарегистрирована', r.status === 201, JSON.stringify(r.body));

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
  await makeClient()('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: name, displayName: `Участник ${i}`, email: `${name}@example.test`, password: 'parol12345' }),
  });
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

console.log(`\n${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);

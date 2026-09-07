// Прогоняет API целиком по живому серверу.
// Сервер нужно поднять с RELAX_RATE_LIMITS=1, иначе лимит регистраций
// (10 в час на IP) остановит прогон на середине.
const BASE = (process.env.API_URL ?? 'http://localhost:3001') + '/api';

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
let r = await a('/auth/register', { method: 'POST', body: JSON.stringify({ username: userA, displayName: 'Алиса Иванова', password: 'parol12345' }) });
check('register 201', r.status === 201, JSON.stringify(r.body));
check('вернулся пользователь', r.body.user?.username === userA, JSON.stringify(r.body));
check('хэш пароля не утёк', !JSON.stringify(r.body).includes('scrypt'));

r = await a('/auth/me');
check('me видит сессию', r.body.user?.username === userA, JSON.stringify(r.body));

r = await anon('/auth/me');
check('me без куки = null', r.body.user === null, JSON.stringify(r.body));

console.log('\n— валидация —');
r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: 'ЮзерКириллица', displayName: 'x', password: 'parol12345' }) });
check('кириллица в логине отклонена', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: `zed_${stamp}`, displayName: 'z', password: 'korotk' }) });
check('короткий пароль отклонён', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: userA.toUpperCase(), displayName: 'дубль', password: 'parol12345' }) });
check('занятый логин (в другом регистре) отклонён', r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);

console.log('\n— вход —');
r = await b('/auth/register', { method: 'POST', body: JSON.stringify({ username: userB, displayName: 'Борис', password: 'parol12345' }) });
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

console.log('\n— своя лента —');
const userC = `carl_${stamp}`;
const c = makeClient();
await c('/auth/register', { method: 'POST', body: JSON.stringify({ username: userC, displayName: 'Карл', password: 'parol12345' }) });
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

console.log('\n— выход —');
r = await a('/auth/logout', { method: 'POST' });
check('logout 200', r.status === 200);
r = await a('/auth/me');
check('сессия недействительна после выхода', r.body.user === null, JSON.stringify(r.body));

console.log('\n— прочее —');
r = await anon('/net-takogo-endpointa');
check('несуществующий API = 404 JSON', r.status === 404 && !!r.body.error, `${r.status}`);

console.log(`\n${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);

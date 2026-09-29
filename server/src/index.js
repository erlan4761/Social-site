import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadUser, requireAuth } from './auth.js';
import { uploadsDir } from './media.js';
import { rateLimit } from './rateLimit.js';
import { router as authRoutes } from './routes/auth.js';
import { router as userRoutes } from './routes/users.js';
import { router as postRoutes } from './routes/posts.js';
import { router as commentRoutes } from './routes/comments.js';
import { router as messageRoutes } from './routes/messages.js';
import { router as chatRoutes } from './routes/chats.js';
import { router as notificationRoutes, badgesRouter } from './routes/notifications.js';
import { router as reportRoutes } from './routes/reports.js';
import { router as searchRoutes } from './routes/search.js';
import { router as bookmarkRoutes } from './routes/bookmarks.js';
import { router as attachmentRoutes } from './routes/attachments.js';
import { router as channelRoutes } from './routes/channels.js';
import { router as prefRoutes } from './routes/prefs.js';
import { router as folderRoutes } from './routes/folders.js';
import { router as accountRoutes } from './routes/account.js';
import { router as pollRoutes } from './routes/polls.js';
import { router as scheduledRoutes } from './routes/scheduled.js';
import { router as pushRoutes } from './routes/push.js';
import { router as phoneRoutes } from './routes/phone.js';
import { startScheduler } from './scheduled.js';
import { dropDeadStreams, nudge, openStream } from './live.js';
import { router as draftRoutes } from './routes/drafts.js';
import { router as linkPreviewRoutes } from './routes/linkPreview.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.set('trust proxy', 1);

// A browser that ignores an upload's declared Content-Type and "sniffs" the
// bytes instead is how a renamed .html masquerading as an image would run as
// a page. This turns that sniffing off for every response, uploads included.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use(loadUser);

// Filenames are random UUIDs handed out once and never reused, so a response
// can be cached hard — a URL either always means this exact file, or 404s
// after the post/avatar that pointed to it is gone.
app.use('/uploads', express.static(uploadsDir, { maxAge: '30d', immutable: true }));

// Боевые значения по умолчанию. RELAX_RATE_LIMITS=1 поднимает потолок, чтобы
// смоук-тест можно было прогонять подряд, а не раз в час.
const relaxed = process.env.RELAX_RATE_LIMITS === '1';

app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60_000, max: relaxed ? 10_000 : 10 }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: relaxed ? 10_000 : 20 }));
// Без лимита форма «забыли пароль» — готовый инструмент завалить письмами
// чужой ящик или перебором нащупать, какие email вообще зарегистрированы.
app.use('/api/auth/forgot-password', rateLimit({ windowMs: 15 * 60_000, max: relaxed ? 10_000 : 5 }));
app.use('/api/auth/reset-password', rateLimit({ windowMs: 15 * 60_000, max: relaxed ? 10_000 : 20 }));
// Смена пароля и удаление аккаунта проверяют текущий пароль — это тот же
// вход, и перебирать его через открытый чужой сеанс нельзя давать быстрее.
const passwordCheckLimit = rateLimit({ windowMs: 15 * 60_000, max: relaxed ? 10_000 : 20 });
app.put('/api/account/password', passwordCheckLimit);
app.delete('/api/account/password', passwordCheckLimit);
app.use('/api/auth/phone/password', passwordCheckLimit);
// Каждое SMS стоит денег: коды с одного адреса — не чаще десяти за четверть
// часа (поверх потолка на сам номер в phone.js), попытки ввести код — 30.
const smsLimit = rateLimit({ windowMs: 15 * 60_000, max: relaxed ? 10_000 : 10 });
for (const path of ['/api/auth/phone/start', '/api/account/phone/start', '/api/account/delete-code']) app.use(path, smsLimit);
app.use('/api/auth/phone/verify', rateLimit({ windowMs: 15 * 60_000, max: relaxed ? 10_000 : 30 }));
app.delete('/api/account', passwordCheckLimit);

// Писать может кто угодно кому угодно, поэтому отправку приходится ограничивать:
// иначе открытые ЛС — готовый канал для рассылки.
app.post('/api/messages/*splat', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 30 }));

// Создание чата — отдельный, куда более редкий жест, чем сообщение в нём:
// десяток новых чатов в час покрывает любое живое использование, а без этого
// лимита один запрос порождал бы уведомления сразу двадцати людям.
// Вступление по ссылке: коды не угадать, но и перебирать их незачем давать.
app.use('/api/chats/join', rateLimit({ windowMs: 15 * 60_000, max: relaxed ? 10_000 : 60 }));
app.post('/api/chats', rateLimit({ windowMs: 60 * 60_000, max: relaxed ? 10_000 : 10 }));
// Всё остальное, что пишет в чат (сообщения, добавление участников), — по той
// же мерке, что и ЛС.
app.post('/api/chats/*splat', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 30 }));

// Поиск дороже обычного чтения ленты: каждый терм — отдельный обход
// FTS-индекса, и поле ввода на клиенте шлёт запрос по мере набора. Шестьдесят
// в минуту — это запрос в секунду подряд, живому человеку столько не нужно.
app.use('/api/search', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 60 }));
// Поиск внутри переписки — та же мерка: поле ввода шлёт запрос по мере набора.
const conversationSearchLimit = rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 60 });
app.get('/api/messages/:username/search', conversationSearchLimit);
app.get('/api/chats/:id/search', conversationSearchLimit);
app.get('/api/channels/:handle/search', conversationSearchLimit);

// Отложить — та же мерка, что и отправить: иначе очередь стала бы обходом лимита сообщений.
app.post('/api/scheduled', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 30 }));
app.post('/api/scheduled/*splat', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 30 }));

// Жалоба — сигнал, а не действие: десятка в час хватит любому живому человеку,
// а поток одинаковых жалоб от одного адреса только зашумит лог.
app.use('/api/reports', rateLimit({ windowMs: 60 * 60_000, max: relaxed ? 10_000 : 10 }));

// Один счётчик на блокировку и разблокировку: осмысленных сценариев, где
// человек щёлкает этой парой чаще тридцати раз в час, нет, а перебор имён
// через ответы 404/400 такой лимит закрывает.
// Поиск по номерам считает номера, а не запросы: пятьдесят номеров за раз —
// это пятьдесят попыток угадать, чей это телефон.
app.post('/api/users/by-phone', rateLimit({
  windowMs: 60 * 60_000,
  max: relaxed ? 10_000 : 200,
  cost: (req) => (Array.isArray(req.body?.phones) ? Math.max(1, req.body.phones.length) : 1),
}));

// Предпросмотр ходит по чужим сайтам — не чаще, чем нужно читающему глазами.
app.get('/api/link-preview', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 60 }));
app.get('/api/link-preview/image', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 120 }));

const blockLimit = rateLimit({ windowMs: 60 * 60_000, max: relaxed ? 10_000 : 30 });
app.put('/api/users/:username/block', blockLimit);
app.delete('/api/users/:username/block', blockLimit);

// Канал — редкий жест, как групповой чат; публикации и комментарии — по мерке
// сообщений: без лимита комментарии под чужой публикацией стали бы рассылкой.
app.post('/api/channels', rateLimit({ windowMs: 60 * 60_000, max: relaxed ? 10_000 : 10 }));
app.post('/api/channels/*splat', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 30 }));

// Всё, что меняет переписку, кроме самой отправки: правки, удаления, реакции,
// «печатает…», отметки прочтения. Потолок щедрый — «печатает…» уходит раз в
// три секунды, прочтение — на каждое новое сообщение, — но скрипт, который
// правит или реагирует без остановки, в него упрётся.
const conversationLimit = rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 120 });
for (const path of ['/api/messages/*splat', '/api/chats/*splat', '/api/channels/*splat', '/api/prefs/*splat', '/api/folders/*splat', '/api/account/*splat', '/api/polls/*splat', '/api/scheduled/*splat', '/api/push/*splat', '/api/drafts/*splat']) {
  app.put(path, conversationLimit);
  app.patch(path, conversationLimit);
  app.delete(path, conversationLimit);
}

if (relaxed) console.warn('⚠  RELAX_RATE_LIMITS=1 — защита от перебора ослаблена. Только для тестов.');

// Живой поток и толчки участникам — до маршрутов: прослойка вешает
// «после ответа» на запрос раньше, чем его обработает маршрут (см. live.js).
app.get('/api/events', requireAuth, openStream);
app.use('/api/messages', nudge('dm'));
app.use('/api/chats', nudge('chat'));
app.use('/api/channels', nudge('channel'));
app.use('/api/polls', nudge('poll'));
// Черновик тоже: другие устройства обновят список и покажут «Черновик: …».
for (const path of ['/api/prefs', '/api/folders', '/api/notifications', '/api/drafts']) app.use(path, nudge('self'));
// Сеанс закрыт — его поток тоже: выход, смена пароля, «завершить сеанс», удаление.
for (const path of ['/api/auth/logout', '/api/auth/reset-password', '/api/account']) {
  app.use(path, (req, res, next) => {
    if (req.method !== 'GET') res.on('finish', dropDeadStreams);
    next();
  });
}

app.use('/api/auth/phone', phoneRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/badges', badgesRouter);
app.use('/api/reports', reportRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/bookmarks', bookmarkRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/prefs', prefRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/polls', pollRoutes);
app.use('/api/scheduled', scheduledRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/drafts', draftRoutes);
app.use('/api/link-preview', linkPreviewRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Нет такого эндпоинта' }));

// In production the built frontend is served from the same origin.
const webDist = join(here, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // /uploads тоже исключён: иначе удалённый файл проваливался бы сюда и
  // отдавал index.html со статусом 200 вместо честного 404.
  app.get(/^(?!\/(api|uploads)\/).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'Файл слишком большой',
      LIMIT_UNEXPECTED_FILE: 'Лишнее поле файла в запросе',
    };
    return res.status(400).json({ error: messages[err.code] ?? 'Не удалось загрузить файл' });
  }
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`API запущен на http://localhost:${PORT}`);
  startScheduler();
});

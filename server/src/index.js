import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadUser } from './auth.js';
import { uploadsDir } from './media.js';
import { rateLimit } from './rateLimit.js';
import { router as authRoutes } from './routes/auth.js';
import { router as userRoutes } from './routes/users.js';
import { router as postRoutes } from './routes/posts.js';
import { router as commentRoutes } from './routes/comments.js';
import { router as messageRoutes } from './routes/messages.js';

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

// Писать может кто угодно кому угодно, поэтому отправку приходится ограничивать:
// иначе открытые ЛС — готовый канал для рассылки.
app.post('/api/messages/*splat', rateLimit({ windowMs: 60_000, max: relaxed ? 10_000 : 30 }));

if (relaxed) console.warn('⚠  RELAX_RATE_LIMITS=1 — защита от перебора ослаблена. Только для тестов.');

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/messages', messageRoutes);

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
});

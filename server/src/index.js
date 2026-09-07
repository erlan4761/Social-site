import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadUser } from './auth.js';
import { rateLimit } from './rateLimit.js';
import { router as authRoutes } from './routes/auth.js';
import { router as userRoutes } from './routes/users.js';
import { router as postRoutes } from './routes/posts.js';
import { router as commentRoutes } from './routes/comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use(loadUser);

// Боевые значения по умолчанию. RELAX_RATE_LIMITS=1 поднимает потолок, чтобы
// смоук-тест можно было прогонять подряд, а не раз в час.
const relaxed = process.env.RELAX_RATE_LIMITS === '1';

app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60_000, max: relaxed ? 10_000 : 10 }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: relaxed ? 10_000 : 20 }));

if (relaxed) console.warn('⚠  RELAX_RATE_LIMITS=1 — защита от перебора ослаблена. Только для тестов.');

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/comments', commentRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Нет такого эндпоинта' }));

// In production the built frontend is served from the same origin.
const webDist = join(here, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`API запущен на http://localhost:${PORT}`);
});

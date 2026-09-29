import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { previewFor, previewImage } from '../linkPreview.js';
import { readUrl } from '../safeFetch.js';

/**
 * Предпросмотр ссылок (см. linkPreview.js). Только вошедшим: иначе любой
 * посторонний мог бы гонять наш сервер по чужим сайтам.
 */
export const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const url = readUrl(req.query.url);
    if (!url) return res.status(400).json({ error: 'Ссылка — http или https, без логина и пароля, до 2 КБ' });
    res.json({ preview: await previewFor(url) });
  } catch (err) {
    next(err);
  }
});

router.get('/image', async (req, res, next) => {
  try {
    const image = await previewImage(req.query.u);
    if (!image) return res.status(404).json({ error: 'Картинки нет' });
    res.set({
      'Content-Type': image.type,
      'Cache-Control': 'private, max-age=86400',
      // Даже открытая напрямую, картинка остаётся картинкой.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.send(image.body);
  } catch (err) {
    next(err);
  }
});

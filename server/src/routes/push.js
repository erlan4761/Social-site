import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedEndpoint, vapidPublicKey } from '../push.js';

/**
 * Подписка этого устройства на пуш-уведомления (см. push.js). Подписка
 * принадлежит сеансу: вышли на телефоне — пуши на него прекращаются сами,
 * каскадом, без отдельного «отписаться».
 */
export const router = Router();
router.use(requireAuth);

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Открытый ключ сервера — браузеру он нужен, чтобы подписаться. */
router.get('/key', (_req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

router.put('/subscription', (req, res) => {
  const endpoint = req.body?.endpoint;
  const p256dh = req.body?.keys?.p256dh;
  const auth = req.body?.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !allowedEndpoint(endpoint)) {
    return res.status(400).json({ error: 'Адрес подписки — не служба доставки уведомлений' });
  }
  const keyOk = (k, max) => typeof k === 'string' && k.length <= max && B64URL.test(k);
  if (!keyOk(p256dh, 200) || !keyOk(auth, 100)) {
    return res.status(400).json({ error: 'Ключи подписки повреждены' });
  }
  // Тот же браузер мог подписываться раньше — под другим сеансом или человеком:
  // адрес один на браузер, и владелец у него теперь тот, кто вошёл сейчас.
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, session_token, endpoint, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET
      user_id = excluded.user_id, session_token = excluded.session_token,
      p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at
  `).run(req.user.id, req.sessionToken, endpoint, p256dh, auth, nowIso());
  res.json({ ok: true });
});

router.delete('/subscription', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Нужен адрес подписки' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.json({ ok: true });
});

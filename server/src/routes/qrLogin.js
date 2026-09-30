import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { db } from '../db.js';
import { assertNotBanned, createSession, requireAuth, selfUser, setSessionCookie } from '../auth.js';
import { deviceLabel } from '../device.js';
import { notifyLogin } from '../notifications.js';

/**
 * Вход на компьютере с телефона — как в Телеграме: компьютер показывает
 * QR-код (и короткий код на случай, если камеры нет), телефон, где человек уже
 * вошёл, подтверждает — и компьютер входит в тот же аккаунт.
 *
 * Три секрета, у каждого своя роль:
 *   token  — в QR-ссылке: по нему телефон находит запрос;
 *   code   — то же, но руками: 8 знаков без похожих букв и цифр;
 *   secret — знает только компьютер, показавший код: по нему он и получает
 *            сеанс. Сфотографировавший QR чужой телефон может разве что
 *            подтвердить вход — и впустить в свой аккаунт чужой компьютер, а не
 *            попасть в чужой сам.
 *
 * Подтверждение — явное, с названием устройства: QR, подсунутый злоумышленником,
 * иначе впускал бы его компьютер в аккаунт того, кто неосторожно навёл камеру.
 * Запрос живёт две минуты и срабатывает один раз; хранится в памяти процесса.
 */
export const router = Router();

const TTL_MS = 2 * 60_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O, 1/I
const requests = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, r] of requests) if (r.expiresAt <= now) requests.delete(token);
}, 60_000).unref();

const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const normCode = (raw) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Живой запрос по token или коду — или null. */
function find(raw) {
  const key = String(raw ?? '');
  const byToken = requests.get(key);
  const hit = byToken ?? [...requests.values()].find((r) => r.code === normCode(key));
  return hit && hit.expiresAt > Date.now() ? hit : null;
}

const GONE = { error: 'Код устарел или уже использован — обновите его на компьютере' };

/** Компьютер: новый запрос на вход. */
router.post('/', (req, res) => {
  if (req.user) return res.status(400).json({ error: 'Вы уже вошли' });
  const r = {
    token: randomBytes(16).toString('base64url'),
    code: newCode(),
    secret: randomBytes(32).toString('base64url'),
    userAgent: req.get('user-agent') ?? null,
    expiresAt: Date.now() + TTL_MS,
    approvedBy: null,
  };
  requests.set(r.token, r);
  res.status(201).json({ token: r.token, code: r.code, secret: r.secret, expiresIn: TTL_MS / 1000 });
});

/**
 * Компьютер ждёт: «pending», пока телефон не подтвердил, потом — сеанс (один
 * раз). Без верного secret — будто запроса нет.
 */
router.post('/poll', (req, res, next) => {
  try {
    const r = requests.get(String(req.body?.token ?? ''));
    const secret = Buffer.from(String(req.body?.secret ?? ''));
    const ok = r && secret.length === Buffer.byteLength(r.secret) && timingSafeEqual(secret, Buffer.from(r.secret));
    if (!ok || r.expiresAt <= Date.now()) return res.status(410).json({ status: 'expired' });
    if (!r.approvedBy) return res.json({ status: 'pending' });

    requests.delete(r.token);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.approvedBy);
    if (!user) return res.status(410).json({ status: 'expired' });
    assertNotBanned(user);
    setSessionCookie(res, createSession(user.id, r.userAgent));
    notifyLogin(user.id, r.userAgent);
    res.json({ status: 'approved', user: selfUser(user) });
  } catch (err) {
    next(err);
  }
});

/** Телефон: что за устройство просит войти — для экрана подтверждения. */
router.get('/:key', requireAuth, (req, res) => {
  const r = find(req.params.key);
  if (!r || r.approvedBy) return res.status(404).json(GONE);
  res.json({ device: deviceLabel(r.userAgent), expiresIn: Math.round((r.expiresAt - Date.now()) / 1000) });
});

/** Телефон: «да, это я» — по token из QR или по коду, набранному руками. */
router.post('/approve', requireAuth, (req, res) => {
  const r = find(req.body?.token ?? req.body?.code);
  if (!r || r.approvedBy) return res.status(404).json(GONE);
  r.approvedBy = req.user.id;
  res.json({ ok: true, device: deviceLabel(r.userAgent) });
});

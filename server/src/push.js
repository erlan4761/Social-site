import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { db } from './db.js';
import { dataDir } from './dataDir.js';
import { PUBLIC_URL } from './email.js';
import { isLive } from './live.js';
import { contentLabel } from './messageExtras.js';

/**
 * Push-уведомления на телефон и компьютер — стандартный Web Push, без
 * сторонних сервисов и оплаты: браузер сам выдаёт адрес своей службы доставки
 * (Google, Mozilla, Apple, Microsoft), сервер шлёт туда зашифрованное письмо.
 *
 * Ключи VAPID — «подпись» сервера перед службами доставки. Их можно задать
 * переменными VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY; нет — сервер создаёт пару
 * при первом запуске и хранит рядом с базой, чтобы подписки переживали
 * перезапуск.
 *
 * Пуш уходит, только когда у человека нет открытой вкладки: открытую
 * обновляет живой поток, а два сигнала об одном сообщении — это шум.
 */

function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = join(dataDir, 'vapid.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

const keys = loadKeys();
export const vapidPublicKey = keys.publicKey;
const subject = process.env.VAPID_SUBJECT || (PUBLIC_URL.startsWith('https:') ? PUBLIC_URL : 'mailto:admin@example.com');

/* ─ Куда можно слать ───────────────────────────────────────────────────
 * Адрес подписки присылает браузер, то есть по сути клиент: без списка
 * разрешённых служб сервер можно было бы заставить стучаться куда угодно,
 * вплоть до внутренних адресов своей же сети. Поэтому — только настоящие
 * службы доставки, а локальный адрес — только вне продакшена, для тестов.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function allowedEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname))) return true;
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  return local && process.env.NODE_ENV !== 'production';
}

/* ─ Что написать ─────────────────────────────────────────────────────── */

const EXCERPT = 120;
const cut = (s) => (s.length > EXCERPT ? `${s.slice(0, EXCERPT).trimEnd()}…` : s);

/** Текст уведомления по событию — те же слова, что в ленте «Событий». */
function describe(n) {
  const who = n.actor_name;
  switch (n.kind) {
    case 'message': {
      const last = db.prepare(`
        SELECT body, sticker, call, attach_kind, attach_name FROM messages
        WHERE from_id = ? AND to_id = ? ORDER BY id DESC LIMIT 1
      `).get(n.actor_id, n.user_id);
      return { title: who, body: last ? cut(contentLabel(last)) : 'Новое сообщение', url: `/messages/${n.actor_username}`, tag: `dm-${n.actor_id}` };
    }
    case 'chat_message': {
      const last = db.prepare(`
        SELECT body, sticker, attach_kind, attach_name FROM chat_messages
        WHERE chat_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1
      `).get(n.chat_id, n.actor_id);
      return {
        title: n.chat_title ?? 'Групповой чат',
        body: `${who}: ${last ? cut(contentLabel(last)) : 'новое сообщение'}`,
        url: `/messages/c/${n.chat_id}`,
        tag: `chat-${n.chat_id}`,
      };
    }
    case 'mention':
      return {
        title: `${who} упомянул(а) вас в «${n.chat_title ?? 'чате'}»`,
        body: cut(n.message_body ?? ''),
        url: n.message_id ? `/messages/c/${n.chat_id}?m=${n.message_id}` : `/messages/c/${n.chat_id}`,
        tag: `mention-${n.message_id ?? n.id}`,
      };
    case 'chat_invite':
      return { title: 'Хроника', body: `${who} добавил(а) вас в чат «${n.chat_title ?? ''}»`, url: `/messages/c/${n.chat_id}`, tag: `chat-${n.chat_id}` };
    case 'comment':
      return { title: `${who} ответил(а) вам`, body: cut(n.comment_body ?? ''), url: `/p/${n.post_id}`, tag: `post-${n.post_id}` };
    case 'like':
      return { title: 'Хроника', body: `${who} отметил(а) вашу запись`, url: `/p/${n.post_id}`, tag: `post-${n.post_id}` };
    case 'follow':
      return { title: 'Хроника', body: `${who} подписался(ась) на вас`, url: `/u/${n.actor_username}`, tag: `follow-${n.actor_id}` };
    case 'new_login': {
      let device = 'Новое устройство';
      try {
        device = JSON.parse(n.detail ?? '{}').device ?? device;
      } catch {
        // подробностей нет — хватит общего «новое устройство»
      }
      return {
        title: 'Вход в аккаунт',
        body: `${device}. Если это были не вы — завершите этот сеанс в настройках.`,
        url: '/settings',
        tag: `login-${n.id}`,
      };
    }
    default:
      return null;
  }
}

/* ─ Отправка ─────────────────────────────────────────────────────────── */

/**
 * Письмо шифрует и подписывает web-push, а отправляет обычный fetch: так
 * смоук-тест может подставить свою «службу доставки» на localhost и
 * расшифровать, что пришло.
 */
async function deliver(sub, payload) {
  const details = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 24 * 60 * 60, urgency: 'high' },
  );
  const { 'Content-Length': _length, ...headers } = details.headers;
  const res = await fetch(details.endpoint, { method: details.method, headers, body: details.body });
  // Подписка отозвана (браузер удалили, разрешение сняли) — больше не пытаемся.
  if (res.status === 404 || res.status === 410) {
    db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
  }
}

/** Пуш о только что созданном событии. Ошибки доставки не ломают запрос. */
/**
 * `silent` — сообщение отправили «без звука», как в Телеграме: уведомление
 * приходит, но не звенит и не вибрирует (флаг `silent` у showNotification).
 */
export function pushNotification(notificationId, { evenIfLive = false, silent = false } = {}) {
  const n = db.prepare(`
    SELECT n.*, a.display_name AS actor_name, a.username AS actor_username,
           g.title AS chat_title, m.body AS message_body, c.body AS comment_body
    FROM notifications n
    JOIN users a ON a.id = n.actor_id
    LEFT JOIN chats g ON g.id = n.chat_id
    LEFT JOIN chat_messages m ON m.id = n.message_id
    LEFT JOIN comments c ON c.id = n.comment_id
    WHERE n.id = ?
  `).get(notificationId);
  if (!n || (!evenIfLive && isLive(n.user_id))) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(n.user_id);
  if (subs.length === 0) return;
  const described = describe(n);
  if (!described) return;
  const payload = silent ? { ...described, silent: true } : described;
  for (const sub of subs) {
    deliver(sub, payload).catch((err) => console.warn('Пуш не доставлен:', err.message));
  }
}

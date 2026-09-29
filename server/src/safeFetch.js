import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Безопасное скачивание по ссылке от пользователя — для предпросмотра ссылок
 * (linkPreview.js). Сервер, который по просьбе пользователя ходит по адресам, —
 * классическая дыра SSRF: «покажи превью http://169.254.169.254/» читал бы
 * секреты облака, а «http://10.0.0.5:6379/» стучался бы во внутреннюю сеть.
 * Поэтому:
 *
 *  - только http и https, только порты 80 и 443, без логина в адресе;
 *  - адрес проверяется в момент соединения — своей функцией DNS-поиска: любой
 *    частный, локальный, служебный или зарезервированный IP (v4 и v6, включая
 *    v4 внутри v6) — отказ. Проверка при соединении, а не заранее, закрывает
 *    DNS rebinding: имя не успеет «переехать» между проверкой и запросом;
 *  - переадресации — вручную, не больше трёх, каждая проверяется заново;
 *  - пять секунд на ответ и потолок размера.
 *
 * Базы здесь нет — модуль проверяется юнит-тестами без сервера.
 *
 * Для смоук-теста можно разрешить петлю 127.0.0.1 (LINK_PREVIEW_ALLOW_LOOPBACK=1,
 * не в продакшене): поддельный сайт живёт на localhost. Остальные частные
 * адреса закрыты и тогда.
 */

const ALLOW_LOOPBACK = process.env.LINK_PREVIEW_ALLOW_LOOPBACK === '1' && process.env.NODE_ENV !== 'production';

export const PAGE_MAX = 512 * 1024;
export const IMAGE_MAX = 3 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const REDIRECTS = 3;
const UA = 'Mozilla/5.0 (compatible; ChronikaPreview/1.0; +link preview)';
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];

/* ─ Какие адреса можно ────────────────────────────────────────────────── */

const v4 = (ip) => ip.split('.').map(Number);

function publicV4([a, b, c]) {
  if (a === 0 || a === 10 || a === 127) return false; // «этот», частная, петля
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, облачные метаданные
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // служебная, документация
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // тесты производительности
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // мультикаст и зарезервированные, включая 255.255.255.255
  return true;
}

/** IPv6 → 16 байт; вложенный IPv4 в хвосте тоже понимает. */
function v6bytes(ip) {
  let addr = ip.toLowerCase().split('%')[0];
  const tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [a, b, c, d] = v4(tail[1]);
    addr = addr.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = rest !== undefined && rest ? rest.split(':') : [];
  const groups = rest !== undefined ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const bytes = [];
  for (const g of groups) {
    const n = Number.parseInt(g || '0', 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function publicV6(ip) {
  const b = v6bytes(ip);
  const zeroTo = (n) => b.slice(0, n).every((x) => x === 0);
  // IPv4 внутри IPv6: ::ffff:a.b.c.d и старое ::a.b.c.d — судим по IPv4.
  if (zeroTo(10) && b[10] === 0xff && b[11] === 0xff) return publicV4(b.slice(12));
  if (zeroTo(12)) return false; // ::, ::1 и устаревшие совместимые
  // Настоящий интернет — только глобальный юникаст 2000::/3.
  if ((b[0] & 0xe0) !== 0x20) return false;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // документация
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false; // Teredo
  if (b[0] === 0x20 && b[1] === 0x02) return false; // 6to4: внутри может быть частный IPv4
  return true;
}

const isLoopback = (ip) =>
  (net.isIPv4(ip) && v4(ip)[0] === 127) || (net.isIPv6(ip) && (ip === '::1' || /^::ffff:127\./i.test(ip)));

/** Можно ли соединяться с этим IP. */
export function isPublicAddress(ip) {
  if (ALLOW_LOOPBACK && isLoopback(ip)) return true;
  if (net.isIPv4(ip)) return publicV4(v4(ip));
  if (net.isIPv6(ip)) return publicV6(ip);
  return false;
}

/**
 * DNS-поиск для http.request: пропускает имя, только если все его адреса
 * публичные. Смешанные записи (публичный и частный) — тоже отказ.
 */
const blocked = (host) => Object.assign(new Error(`Адрес ${host} закрыт для предпросмотра`), { code: 'EBLOCKED' });

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
      return callback(blocked(hostname));
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/* ─ Какие ссылки можно ────────────────────────────────────────────────── */

/** Нормализованный адрес или null: http(s), без логина, порт 80/443, до 2 КБ. */
export function readUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (url.port && !['80', '443'].includes(url.port) && !ALLOW_LOOPBACK) return null;
  url.hash = '';
  return url;
}

/* ─ Скачивание ────────────────────────────────────────────────────────── */

function fetchOnce(url, { accept, max }) {
  return new Promise((resolve, reject) => {
    // Для адреса-литерала (http://169.254.169.254/, http://[::1]/) Node вовсе не
    // зовёт DNS-поиск — safeLookup его не увидел бы. Проверяем сами. Запись вида
    // http://2130706433/ URL уже привёл к 127.0.0.1, так что она ловится тут же.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isPublicAddress(host)) return reject(blocked(host));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'ru,en;q=0.7' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) {
          // Страницу обрезаем (заголовки в начале), картинку — отвергаем целиком.
          chunks.push(chunk.subarray(0, chunk.length - (size - max)));
          res.destroy();
          resolve({ headers: res.headers, body: Buffer.concat(chunks), truncated: true });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks), truncated: false }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Нет ответа')));
    req.on('error', reject);
    req.end();
  });
}

/** С переадресациями: каждая — новый адрес, проверенный с начала. */
export async function fetchSafe(start, opts) {
  let url = start;
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    const res = await fetchOnce(url, opts);
    if (!res.redirect) return { ...res, url };
    const next = readUrl(new URL(res.redirect, url).href);
    if (!next) throw new Error('Переадресация на закрытый адрес');
    url = next;
  }
  throw new Error('Слишком много переадресаций');
}

/* ─ Разбор страницы ───────────────────────────────────────────────────── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const clean = (s, max) => {
  if (!s) return null;
  const out = decodeEntities(s).replace(/\s+/g, ' ').trim();
  if (!out) return null;
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
};

function attrsOf(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/** Кодировка: из заголовка ответа, иначе из <meta charset>, иначе UTF-8. */
export function decodeHtml(body, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (!charset) {
    const sniff = body.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Заголовок, описание, название сайта и картинка — из Open Graph, Twitter и <title>. */
export function parsePage(html, pageUrl) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrsOf(m[0]));
  const pick = (...keys) => {
    for (const key of keys) {
      const found = metas.find((a) => (a.property ?? a.name ?? '').toLowerCase() === key && a.content);
      if (found) return found.content;
    }
    return null;
  };
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
  const title = clean(pick('og:title', 'twitter:title') ?? titleTag, 200);
  if (!title) return null;

  let image = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  if (image) {
    try {
      const abs = new URL(decodeEntities(image), pageUrl);
      image = ['http:', 'https:'].includes(abs.protocol) ? abs.href : null;
    } catch {
      image = null;
    }
  }
  return {
    title,
    description: clean(pick('og:description', 'twitter:description', 'description'), 300),
    siteName: clean(pick('og:site_name'), 80) ?? pageUrl.hostname.replace(/^www\./, ''),
    image,
  };
}

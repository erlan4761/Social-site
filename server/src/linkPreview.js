import { db, nowIso } from './db.js';
import { IMAGE_MAX, IMAGE_TYPES, PAGE_MAX, decodeHtml, fetchSafe, parsePage, readUrl } from './safeFetch.js';

/**
 * Предпросмотр ссылок — заголовок, описание и картинка страницы, как в
 * Телеграме. Страницу скачивает сервер, а не браузер собеседника: так чужой
 * сайт не узнаёт адреса читателей, а картинка идёт через наш же сервер.
 * Как скачивать безопасно — safeFetch.js. Здесь — кэш в базе (удачное превью —
 * сутки, неудача — час) и картинка, которая отдаётся только из сохранённого
 * превью: иначе это был бы открытый прокси.
 */

const OK_TTL_MS = 24 * 3600_000;
const FAIL_TTL_MS = 3600_000;

/* ─ Кэш и выдача ──────────────────────────────────────────────────────── */

const inflight = new Map();

const serialize = (row) => (row?.ok ? {
  url: row.url,
  title: row.title,
  description: row.description,
  siteName: row.site_name,
  image: row.image_url ? `/api/link-preview/image?u=${encodeURIComponent(row.image_url)}` : null,
} : null);

async function fetchPreview(url) {
  try {
    const res = await fetchSafe(url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', max: PAGE_MAX });
    const type = String(res.headers['content-type'] ?? '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('application/xhtml')) return null;
    return parsePage(decodeHtml(res.body, type), res.url);
  } catch {
    return null;
  }
}

/** Превью по ссылке — из кэша (сутки; неудача — час) или свежее. Ошибки — это null. */
export async function previewFor(url) {
  const key = url.href;
  const row = db.prepare('SELECT * FROM link_previews WHERE url = ?').get(key);
  if (row && Date.now() - Date.parse(row.fetched_at) < (row.ok ? OK_TTL_MS : FAIL_TTL_MS)) return serialize(row);
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const found = await fetchPreview(url);
      db.prepare(`
        INSERT INTO link_previews (url, ok, title, description, site_name, image_url, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (url) DO UPDATE SET ok = excluded.ok, title = excluded.title, description = excluded.description,
          site_name = excluded.site_name, image_url = excluded.image_url, fetched_at = excluded.fetched_at
      `).run(key, found ? 1 : 0, found?.title ?? null, found?.description ?? null, found?.siteName ?? null, found?.image ?? null, nowIso());
    })().finally(() => inflight.delete(key)));
  }
  await inflight.get(key);
  return serialize(db.prepare('SELECT * FROM link_previews WHERE url = ?').get(key));
}

/**
 * Картинка превью через наш сервер. Только та, что стоит в сохранённом
 * превью, и только растровая: SVG — это документ со скриптами, а не картинка.
 */
export async function previewImage(raw) {
  const url = readUrl(raw);
  if (!url || !db.prepare('SELECT 1 FROM link_previews WHERE ok = 1 AND image_url = ?').get(url.href)) return null;
  try {
    const res = await fetchSafe(url, { accept: IMAGE_TYPES.join(','), max: IMAGE_MAX });
    const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (res.truncated || !IMAGE_TYPES.includes(type)) return null;
    return { type, body: res.body };
  } catch {
    return null;
  }
}

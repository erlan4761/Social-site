import { useEffect, useState } from 'react';
import { api, type LinkPreview as Preview } from '../../api';

/**
 * Карточка ссылки под сообщением: сайт, заголовок, описание, картинка — как в
 * Телеграме. Страницу скачивает сервер (и картинку отдаёт он же), браузер к
 * чужому сайту не ходит. Одна ссылка — один запрос на вкладку: ответы
 * запоминаются, и лента с десятью одинаковыми ссылками спросит один раз.
 */
const cache = new Map<string, Promise<Preview | null>>();

function load(url: string) {
  let found = cache.get(url);
  if (!found) {
    found = api.linkPreview(url).then((res) => res.preview).catch(() => null);
    cache.set(url, found);
  }
  return found;
}

export function LinkPreview({ url, onLoad }: { url: string; onLoad?: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load(url).then((p) => {
      if (!cancelled && p) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Карточка появилась позже текста — лента пересчитывает прокрутку, чтобы
  // низ переписки не уехал из-под глаз.
  useEffect(() => {
    if (preview) onLoad?.();
  }, [preview, onLoad]);

  if (!preview) return null;
  return (
    <a className="link-card" href={preview.url} target="_blank" rel="noopener noreferrer nofollow">
      {preview.image && <img className="link-card-img" src={preview.image} alt="" loading="lazy" onLoad={onLoad} />}
      <span className="link-card-site">{preview.siteName}</span>
      <strong className="link-card-title">{preview.title}</strong>
      {preview.description && <span className="link-card-desc">{preview.description}</span>}
    </a>
  );
}

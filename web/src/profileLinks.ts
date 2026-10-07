/**
 * Ссылки профиля — те же правила, что readLinks() на сервере (routes/users.js):
 * до трёх адресов http(s), адрес без схемы получает https://, повторы и пустые
 * убираются. Витрина проверяет ими, интерфейс — подписывает.
 */
export const LINKS_MAX = 3;

export function normalizeLinks(raw: string[]): { links: string[] } | { error: string } {
  const out: string[] = [];
  for (const item of raw) {
    const text = item.trim();
    if (!text) continue;
    if (text.length > 200) return { error: 'Ссылка длиннее 200 знаков' };
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return { error: `Не похоже на адрес: ${text}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Ссылка — только на сайт: http или https' };
    if (!url.hostname.includes('.')) return { error: `Не похоже на адрес: ${text}` };
    if (!out.includes(url.toString())) out.push(url.toString());
  }
  if (out.length > LINKS_MAX) return { error: `Ссылок — не больше ${LINKS_MAX}` };
  return { links: out };
}

/** Подпись ссылки: без схемы, «www.» и косой черты в конце; длинная — с многоточием. */
export function linkLabel(href: string) {
  const bare = href.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

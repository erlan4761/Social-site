/**
 * Хэштеги — тот же разбор, что server/src/hashtags.js: от двух до пятидесяти
 * букв, цифр и «_», хотя бы одна буква; перед «#» не буква, не цифра и не
 * «/», «&», «#» — якорь адреса тегом не становится. Ключ — нижний регистр
 * и «ё» → «е», как в поиске.
 */
export const TAGS_MAX = 10;

/** Источник для сборки регулярок: группа 1 — что перед «#», группа 2 — сам тег. */
export const TAG_SOURCE = '(^|[^\\p{L}\\p{N}_&#/])#([\\p{L}\\p{N}_]{2,50})(?![\\p{L}\\p{N}_])';

const KEY_RE = /^[\p{L}\p{N}_]{2,50}$/u;
const HAS_LETTER = /\p{L}/u;

export const tagKey = (raw: string) => raw.toLowerCase().replace(/ё/g, 'е');

/** «#1» — номер, а не тема. */
export const isTag = (raw: string) => HAS_LETTER.test(raw);

/** Теги текста по порядку, без повторов, не больше десяти. */
export function tagsIn(text: string): { tag: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(new RegExp(TAG_SOURCE, 'gu'))) {
    if (!isTag(m[2])) continue;
    const tag = tagKey(m[2]);
    if (!seen.has(tag)) seen.set(tag, m[2].toLowerCase());
    if (seen.size >= TAGS_MAX) break;
  }
  return [...seen].map(([tag, label]) => ({ tag, label }));
}

/** Тег из адреса или строки поиска: «#Плёнка» и «пленка» — один; мусор — null. */
export function tagFromParam(value: string): string | null {
  const raw = value.trim().replace(/^#/, '');
  return KEY_RE.test(raw) && isTag(raw) ? tagKey(raw) : null;
}

export const tagPath = (tag: string) => `/tag/${encodeURIComponent(tagKey(tag))}`;

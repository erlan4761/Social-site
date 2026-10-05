/**
 * Хэштеги записей: `#плёнка`, `#ночная_съёмка`. Тег — от двух до пятидесяти
 * букв, цифр и подчёркиваний, хотя бы одна буква: «#1» — это номер, а не тема.
 * Перед «#» не буква, не цифра и не «/», «&», «#»: так якорь адреса
 * (`site.ru/#about`, `page#top`) и HTML-сущность тегом не становятся.
 *
 * Ключ тега — в нижнем регистре и с «ё» → «е», как поиск: кто пишет «#пленка»,
 * должен попасть туда же, где «#плёнка». Подпись (`label`) хранит написание
 * автора — в нижнем регистре, но с «ё».
 *
 * Тот же разбор — в web/src/hashtags.ts: ссылки в тексте и витрина.
 */
export const TAGS_MAX = 10;

const TAG_RE = /(^|[^\p{L}\p{N}_&#/])#([\p{L}\p{N}_]{2,50})(?![\p{L}\p{N}_])/gu;
const KEY_RE = /^[\p{L}\p{N}_]{2,50}$/u;

export const tagKey = (raw) => raw.toLowerCase().replace(/ё/g, 'е');

/** Теги текста по порядку, без повторов, не больше десяти: тег — тема, а не рассылка. */
export function tagsIn(text) {
  const seen = new Map();
  for (const m of String(text ?? '').matchAll(TAG_RE)) {
    const raw = m[2];
    if (!/\p{L}/u.test(raw)) continue;
    const tag = tagKey(raw);
    if (!seen.has(tag)) seen.set(tag, raw.toLowerCase());
    if (seen.size >= TAGS_MAX) break;
  }
  return [...seen].map(([tag, label]) => ({ tag, label }));
}

/** Тег из адреса: «#Плёнка», «плёнка» и «%23пленка» — один и тот же; мусор — null. */
export function tagFromParam(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (!KEY_RE.test(raw) || !/\p{L}/u.test(raw)) return null;
  return tagKey(raw);
}

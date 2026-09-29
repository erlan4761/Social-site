/**
 * Номер телефона в интерфейсе: код страны отдельно, номер отдельно, наружу —
 * E.164 («+996555123456»), как его ждёт сервер. Кто вставил номер целиком с
 * «+», тому код страны из списка не мешает.
 */

export type Country = { code: string; dial: string; name: string };

// Кыргызстан первым: сайт делается отсюда. Россия и Казахстан — один код +7.
export const COUNTRIES: Country[] = [
  { code: 'KG', dial: '+996', name: 'Кыргызстан' },
  { code: 'KZ', dial: '+7', name: 'Казахстан, Россия' },
  { code: 'UZ', dial: '+998', name: 'Узбекистан' },
  { code: 'TJ', dial: '+992', name: 'Таджикистан' },
  { code: 'TM', dial: '+993', name: 'Туркменистан' },
  { code: 'AZ', dial: '+994', name: 'Азербайджан' },
  { code: 'AM', dial: '+374', name: 'Армения' },
  { code: 'GE', dial: '+995', name: 'Грузия' },
  { code: 'BY', dial: '+375', name: 'Беларусь' },
  { code: 'UA', dial: '+380', name: 'Украина' },
  { code: 'TR', dial: '+90', name: 'Турция' },
  { code: 'DE', dial: '+49', name: 'Германия' },
  { code: 'GB', dial: '+44', name: 'Великобритания' },
  { code: 'US', dial: '+1', name: 'США, Канада' },
];

/** Код страны и то, что набрано, — в E.164. Не проверяет: это дело сервера. */
export function toE164(dial: string, typed: string) {
  const raw = typed.trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return `+${digits}`;
  if (raw.startsWith('00')) return `+${digits.slice(2)}`;
  // «8 916 …» — так номер пишут в России и Казахстане: восьмёрка вместо +7.
  if (dial === '+7' && digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  // «0555…» — местный формат: ведущий ноль вместо кода страны.
  return `${dial}${digits.replace(/^0+/, '')}`;
}

/** «+996555123456» → «+996 555 12 34 56»; «+79161234567» → «+7 916 123-45-67». */
export function formatPhone(e164: string) {
  const d = e164.replace(/\D/g, '');
  if (d.startsWith('996') && d.length === 12) return `+996 ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)} ${d.slice(10)}`;
  if (d.startsWith('7') && d.length === 11) return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  const country = COUNTRIES.map((c) => c.dial.slice(1)).sort((a, b) => b.length - a.length).find((c) => d.startsWith(c));
  const cc = country ?? d.slice(0, Math.min(3, d.length - 7));
  const rest = d.slice(cc.length).match(/.{1,3}/g) ?? [];
  return `+${cc} ${rest.join(' ')}`.trim();
}

/** Код страны номера — из списка, самый длинный подходящий; нет номера — первый в списке. */
export function dialOf(e164: string | null | undefined) {
  if (!e164) return COUNTRIES[0].dial;
  const found = COUNTRIES.map((c) => c.dial).sort((a, b) => b.length - a.length).find((d) => e164.startsWith(d));
  return found ?? COUNTRIES[0].dial;
}

/** Похоже ли набранное в поиске на номер: с «+», не меньше восьми цифр, без букв. */
export function looksLikePhone(q: string) {
  const s = q.trim();
  return /^\+[\d\s().-]+$/.test(s) && s.replace(/\D/g, '').length >= 8;
}

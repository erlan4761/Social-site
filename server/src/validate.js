export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (message) => new HttpError(400, message);

export function str(value, field, { min = 0, max = Infinity, trim = true } = {}) {
  if (typeof value !== 'string') throw bad(`Поле «${field}» должно быть строкой`);
  const out = trim ? value.trim() : value;
  if (out.length < min) throw bad(`«${field}»: минимум ${min} символов`);
  if (out.length > max) throw bad(`«${field}»: максимум ${max} символов`);
  return out;
}

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export function username(value) {
  const out = str(value, 'имя пользователя', { min: 3, max: 20 }).toLowerCase();
  if (!USERNAME_RE.test(out)) {
    throw bad('Имя пользователя: 3–20 символов, только латиница, цифры и _');
  }
  return out;
}

// Практичная проверка формата, не полный RFC 5322 — нам важно отсечь опечатки
// вроде "a@b" без домена, а не разобрать все теоретически валидные адреса.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function email(value) {
  const out = str(value, 'email', { min: 3, max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(out)) throw bad('Некорректный email');
  return out;
}

export function password(value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw bad('Пароль должен быть не короче 8 символов');
  }
  if (value.length > 200) throw bad('Пароль слишком длинный');
  return value;
}

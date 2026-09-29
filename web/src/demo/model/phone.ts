import { db, fail } from '../store';

/** Номер и коды «из SMS» — как phone.js на сервере; код витрина отдаёт в ответе. */

const CODE_TTL_MS = 5 * 60_000;
// В витрине пауза короче серверной минуты: SMS здесь ничего не стоит.
const RESEND_MS = 20_000;
const ATTEMPTS = 5;
const TICKET_TTL_MS = 15 * 60_000;

export function normalizePhone(raw: string) {
  let phone = String(raw ?? '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) fail(400, 'Номер — в международном формате, с кодом страны: +996 555 123 456');
  return phone;
}

type Purpose = 'login' | 'link' | 'delete';

export function sendCode(phone: string, purpose: Purpose, userId: number | null = null) {
  const now = Date.now();
  const last = db.phoneCodes.filter((c) => c.phone === phone && c.purpose === purpose).at(-1);
  if (last && now - last.createdAt < RESEND_MS) {
    fail(429, `Новый код можно запросить через ${Math.ceil((RESEND_MS - (now - last.createdAt)) / 1000)} с`);
  }
  for (const c of db.phoneCodes) if (c.phone === phone && c.purpose === purpose) c.used = true;
  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  db.phoneCodes.push({ phone, purpose, userId, code, attempts: 0, expiresAt: now + CODE_TTL_MS, createdAt: now, used: false });
  console.log(`📱 [демо] SMS для ${phone}: код ${code}`);
  return { ok: true as const, phone, expiresIn: CODE_TTL_MS / 1000, resendIn: RESEND_MS / 1000, demoCode: code };
}

export function checkCode(phone: string, purpose: Purpose, code: string, userId: number | null = null) {
  const row = db.phoneCodes
    .filter((c) => c.phone === phone && c.purpose === purpose && !c.used && c.expiresAt > Date.now() && (userId == null || c.userId === userId))
    .at(-1);
  if (!row) fail(400, 'Код устарел или не запрашивался — запросите новый');
  if (row!.attempts >= ATTEMPTS) fail(400, 'Слишком много попыток — запросите новый код');
  if (!/^\d{6}$/.test(String(code ?? '').trim())) fail(400, 'Код — 6 цифр из SMS');
  if (row!.code !== code.trim()) {
    row!.attempts += 1;
    const left = ATTEMPTS - row!.attempts;
    fail(400, left > 0 ? `Неверный код. Осталось попыток: ${left}` : 'Неверный код. Запросите новый');
  }
  row!.used = true;
}

export function issueTicket(kind: 'signup' | 'password', phone: string, userId: number | null = null) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  db.phoneTickets.push({ token, kind, phone, userId, attempts: 0, expiresAt: Date.now() + TICKET_TTL_MS });
  return token;
}

export function readTicket(token: string, kind: 'signup' | 'password') {
  const row = db.phoneTickets.find((x) => x.token === token && x.kind === kind && x.expiresAt > Date.now());
  return row ?? fail(400, 'Вход устарел — начните заново с номера телефона');
}

export const dropTicket = (token: string) => {
  db.phoneTickets = db.phoneTickets.filter((x) => x.token !== token);
};

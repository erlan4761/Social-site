import { type DbUser, fail } from '../store';

/**
 * Код из приложения-аутентификатора в витрине — те же правила, что в
 * server/src/twoFactor.js: TOTP (RFC 6238), окно ±30 секунд, код дважды не
 * проходит, десять резервных кодов, билет между паролем и кодом. SHA-1 —
 * свой и синхронный: мок отвечает сразу, а WebCrypto есть не везде (в тестах
 * тоже). Секрет и коды живут в памяти вкладки, как и всё в витрине.
 */

/* ─ SHA-1 и HMAC (FIPS 180-4, RFC 2104) ─ */

function sha1(msg: Uint8Array): Uint8Array {
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = msg.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);

  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      [e, d, c, b, a] = [d, c, ((b << 30) | (b >>> 2)) >>> 0, a, t];
    }
    [h0, h1, h2, h3, h4] = [(h0 + a) >>> 0, (h1 + b) >>> 0, (h2 + c) >>> 0, (h3 + d) >>> 0, (h4 + e) >>> 0];
  }
  const out = new Uint8Array(20);
  const o = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => o.setUint32(i * 4, h));
  return out;
}

function hmacSha1(key: Uint8Array, msg: Uint8Array) {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha1(key) : key);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 20);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha1(inner), 64);
  return sha1(outer);
}

/* ─ base32 и TOTP ─ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string) {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of str.toUpperCase().replace(/[\s=-]/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function hotp(key: Uint8Array, step: number, digits = 6) {
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setUint32(0, Math.floor(step / 2 ** 32));
  new DataView(counter.buffer).setUint32(4, step >>> 0);
  const mac = hmacSha1(key, counter);
  const offset = mac[19] & 0x0f;
  const bin = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 30_000);

/** Код для секрета сейчас (или на `shift` шагов вперёд) — для тестов витрины. */
export const totpNow = (secret: string, shift = 0) => hotp(base32Decode(secret), stepAt() + shift);

export function matchTotp(secret: string, code: string, after = -1): number | null {
  const digits = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secret);
  for (let d = -1; d <= 1; d++) {
    const step = stepAt() + d;
    if (step > after && hotp(key, step) === digits) return step;
  }
  return null;
}

export const newSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)));

export const otpauthUri = (username: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent('Duet')}:${encodeURIComponent(username)}` +
  `?secret=${secret}&issuer=${encodeURIComponent('Duet')}&algorithm=SHA1&digits=6&period=30`;

/* ─ Резервные коды и второй шаг ─ */

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const normalize = (code: string) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function issueBackupCodes(u: DbUser) {
  const random = crypto.getRandomValues(new Uint8Array(80));
  const codes = Array.from({ length: 10 }, (_, i) => {
    const raw = Array.from(random.slice(i * 8, i * 8 + 8), (b) => ALPHABET[b % ALPHABET.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  u.backupCodes = codes.map((code) => ({ code: normalize(code), used: false }));
  return codes;
}

export const backupCodesLeft = (u: DbUser) => (u.backupCodes ?? []).filter((c) => !c.used).length;

export const twoFactorOn = (u: DbUser | undefined) => Boolean(u?.totpEnabledAt && u.totpSecret);

/** Код из приложения или резервный; верный отмечается использованным. */
export function useSecondFactor(u: DbUser, code: string): 'totp' | 'backup' | null {
  const step = matchTotp(u.totpSecret ?? '', code, u.totpLastStep ?? -1);
  if (step != null) {
    u.totpLastStep = step;
    return 'totp';
  }
  const hit = (u.backupCodes ?? []).find((c) => !c.used && c.code === normalize(code));
  if (!hit) return null;
  hit.used = true;
  return 'backup';
}

const tickets = new Map<string, { userId: number; attempts: number; until: number }>();

export function issueTwoFactorTicket(userId: number) {
  const token = base32Encode(crypto.getRandomValues(new Uint8Array(15)));
  tickets.set(token, { userId, attempts: 0, until: Date.now() + 5 * 60_000 });
  return token;
}

export function readTwoFactorTicket(token: string) {
  const t = tickets.get(token);
  if (!t || t.until <= Date.now()) fail(410, 'Время на ввод кода вышло — войдите заново');
  return { token, ...t! };
}

export function failTwoFactorTicket(token: string) {
  const t = tickets.get(token);
  if (!t) return;
  t.attempts += 1;
  if (t.attempts >= 5) tickets.delete(token);
}

export const dropTwoFactorTicket = (token: string) => tickets.delete(token);

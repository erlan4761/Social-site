// Юнит-тесты кода из приложения-аутентификатора: опорные значения RFC 6238 и
// RFC 4648, окно в ±30 секунд и запрет повтора. Без сервера: npm run test:totp.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Модуль тянет за собой базу — пусть это будет временная, а не рабочая.
const dir = mkdtempSync(join(tmpdir(), 'totp-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.DATA_DIR = dir;
const { base32Decode, base32Encode, hotp, matchTotp, otpauthUri, stepAt } = await import('../src/twoFactor.js');

test('base32 — опорные значения RFC 4648 (без «=»)', () => {
  const vectors = { '': '', f: 'MY', fo: 'MZXQ', foo: 'MZXW6', foob: 'MZXW6YQ', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI' };
  for (const [plain, encoded] of Object.entries(vectors)) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded, plain);
    assert.equal(base32Decode(encoded).toString(), plain, encoded);
  }
  // Как секрет набирают руками: строчными, с пробелами.
  assert.equal(base32Decode('mzxw 6ytb oi').toString(), 'foobar');
});

test('TOTP — опорные значения RFC 6238 (SHA-1, восемь цифр)', () => {
  const key = Buffer.from('12345678901234567890');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(hotp(key, stepAt(seconds * 1000), 8), code, String(seconds));
  }
});

test('шесть цифр — последние шесть от тех же значений', () => {
  const key = Buffer.from('12345678901234567890');
  assert.equal(hotp(key, stepAt(59_000)), '287082');
});

test('окно ±30 секунд и запрет повтора', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const now = 1_111_111_111_000;
  const step = stepAt(now);
  const key = base32Decode(secret);
  assert.equal(matchTotp(secret, hotp(key, step), { now }), step);
  assert.equal(matchTotp(secret, hotp(key, step - 1), { now }), step - 1, 'прошлые 30 секунд');
  assert.equal(matchTotp(secret, hotp(key, step + 1), { now }), step + 1, 'часы телефона спешат');
  assert.equal(matchTotp(secret, hotp(key, step - 2), { now }), null, 'минуту назад — уже нет');
  assert.equal(matchTotp(secret, hotp(key, step), { now, after: step }), null, 'тот же код второй раз');
  assert.equal(matchTotp(secret, `${hotp(key, step).slice(0, 3)} ${hotp(key, step).slice(3)}`, { now }), step, 'с пробелом посередине');
  assert.equal(matchTotp(secret, '12345', { now }), null);
  assert.equal(matchTotp(secret, 'abcdef', { now }), null);
});

test('адрес для QR — то, что понимают приложения', () => {
  const uri = otpauthUri('nina', 'JBSWY3DPEHPK3PXP');
  assert.match(uri, /^otpauth:\/\/totp\/Duet:nina\?secret=JBSWY3DPEHPK3PXP&/);
  assert.match(uri, /issuer=Duet&/);
  assert.match(uri, /digits=6&period=30$/);
});

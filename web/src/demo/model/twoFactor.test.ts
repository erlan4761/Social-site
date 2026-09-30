import { describe, expect, it } from 'vitest';
import { base32Encode, hotp, stepAt } from './twoFactor';

// Свой SHA-1 в витрине — значит, и проверка ему нужна по опорным значениям.
describe('код из приложения в витрине', () => {
  const key = new TextEncoder().encode('12345678901234567890');

  it('TOTP — опорные значения RFC 6238 (SHA-1, восемь цифр)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) expect(hotp(key, stepAt(seconds * 1000), 8)).toBe(code);
  });

  it('HOTP — опорные значения RFC 4226 (шесть цифр)', () => {
    const codes = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    codes.forEach((code, step) => expect(hotp(key, step)).toBe(code));
  });

  it('base32 — опорные значения RFC 4648', () => {
    const enc = (s: string) => base32Encode(new TextEncoder().encode(s));
    expect(['f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map(enc)).toEqual(['MY', 'MZXQ', 'MZXW6', 'MZXW6YQ', 'MZXW6YTB', 'MZXW6YTBOI']);
  });
});

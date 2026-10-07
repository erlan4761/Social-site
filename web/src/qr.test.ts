import { describe, expect, it } from 'vitest';
import { MASKS, formatBits, qrCodewords, qrMatrix, rsRemainder, versionBits, zigzag } from './qr';

/**
 * QR-кодер проверяется по опорным значениям стандарта (их нельзя «подогнать»
 * под собственный код), а матрица — чтением назад: служебные поля на месте, а
 * данные, собранные змейкой и очищенные от маски, совпадают с тем, что кодировали.
 */

describe('QR: опорные значения стандарта', () => {
  it('Рид — Соломон: пример «HELLO WORLD», версия 1-M', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('поле формата: вся таблица уровня M', () => {
    const table = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    table.forEach((bits, mask) => expect(formatBits(mask).toString(2).padStart(15, '0')).toBe(bits));
  });

  it('поле версии 7', () => {
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
  });
});

describe('QR: матрица читается назад', () => {
  const read = (m: boolean[][], text: string) => {
    const size = m.length;
    const version = (size - 17) / 4;
    // Где служебные модули — по той же разметке, что у кодера: берём её из
    // пустой матрицы той же версии через публичный qrMatrix не выйдет, поэтому
    // проверяем самое уязвимое — формат (две копии) и данные.
    const fmtA: boolean[] = [];
    for (let i = 0; i <= 5; i++) fmtA.push(m[i][8]);
    fmtA.push(m[7][8], m[8][8], m[8][7]);
    for (let i = 9; i < 15; i++) fmtA.push(m[8][14 - i]);
    const fmtB: boolean[] = [];
    for (let i = 0; i < 8; i++) fmtB.push(m[8][size - 1 - i]);
    for (let i = 8; i < 15; i++) fmtB.push(m[size - 15 + i][8]);
    const toNum = (bits: boolean[]) => bits.reduce((n, b, i) => n | ((b ? 1 : 0) << i), 0);
    return { size, version, fmtA: toNum(fmtA), fmtB: toNum(fmtB), text };
  };

  for (const text of ['https://example.com/Social-site/qr/AbCdEfGhIjKlMnOpQrStUv', 'Duet: вход по QR-коду, чтобы проверить блоки и поле версии', 'x'.repeat(140), 'y'.repeat(200)]) {
    it(`«${text.slice(0, 30)}…» — служебные поля и данные на месте`, () => {
      const m = qrMatrix(text);
      const { size, version, fmtA, fmtB } = read(m, text);
      expect(Number.isInteger(version)).toBe(true);
      // Обе копии формата одинаковы и это одна из восьми масок уровня M.
      expect(fmtA).toBe(fmtB);
      const mask = [...Array(8).keys()].find((k) => formatBits(k) === fmtA);
      expect(mask).toBeDefined();
      // Искатели в трёх углах: тёмная рамка 7×7, светлое кольцо, тёмный центр 3×3.
      for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        expect(m[cy - 3][cx - 3]).toBe(true);
        expect(m[cy - 2][cx - 2]).toBe(false);
        expect(m[cy][cx]).toBe(true);
      }
      // Тёмный модуль у левого нижнего искателя.
      expect(m[size - 8][8]).toBe(true);
      // Данные: змейкой по нефункциональным ячейкам, снять маску, собрать байты.
      const fixed = functionMap(size, version);
      const cells = zigzag(size, fixed);
      const expected = qrCodewords(text, version);
      const bytes: number[] = [];
      for (let i = 0; i < expected.length * 8; i++) {
        const [x, y] = cells[i];
        const b = m[y][x] !== MASKS[mask!](x, y);
        if (i % 8 === 0) bytes.push(0);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] << 1) | (b ? 1 : 0);
      }
      expect(bytes).toEqual(expected);
      if (version >= 7) {
        // Поле версии в правом верхнем углу.
        const bits = versionBits(version);
        for (let i = 0; i < 18; i++) expect(m[Math.floor(i / 3)][size - 11 + (i % 3)]).toBe(((bits >>> i) & 1) === 1);
      }
    });
  }
});

/**
 * Разметка служебных модулей — независимо от кодера, по стандарту: искатели с
 * разделителями, синхронизация, выравнивающие узоры, формат, версия.
 */
function functionMap(size: number, version: number) {
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && (f[y][x] = true);
  for (const [x0, y0] of [[0, 0], [size - 8, 0], [0, size - 8]]) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) mark(x0 + x, y0 + y);
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  const align: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  const pos = align[version];
  const last = pos.length - 1;
  pos.forEach((y, i) => pos.forEach((x, j) => {
    // По стандарту пропускаются только три угла с искателями; узоры на линиях
    // синхронизации (строка и столбец 6) — есть.
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(x + dx, y + dy);
  }));
  for (let i = 0; i < 9; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  if (version >= 7) for (let i = 0; i < 18; i++) {
    mark(size - 11 + (i % 3), Math.floor(i / 3));
    mark(Math.floor(i / 3), size - 11 + (i % 3));
  }
  return f;
}

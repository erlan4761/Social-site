/**
 * QR-код для входа по телефону — своим кодом, без библиотеки, как и иконки.
 * Нужен ровно один случай: ссылка до ~200 байт. Поэтому только байтовый режим,
 * уровень коррекции M (15 % повреждений) и версии 1–10. Устройство — по
 * стандарту ISO/IEC 18004: данные → блоки с кодом Рида — Соломона →
 * чередование → раскладка змейкой → лучшая из восьми масок → служебные поля.
 */

/** Блоки уровня M для версий 1–10: [байт коррекции на блок, [блоков, байт данных в блоке]…]. */
const BLOCKS_M: [number, [number, number][]][] = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

/** Центры выравнивающих узоров для версий 1–10. */
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const bit = (x: number, i: number) => ((x >>> i) & 1) === 1;

/* ─ Рид — Соломон над GF(256), примитивный многочлен x⁸+x⁴+x³+x²+1 ─ */

function gfMul(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number) {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** Байты коррекции для блока данных — остаток от деления на порождающий многочлен. */
export function rsRemainder(data: number[], degree: number) {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

/* ─ Служебные поля ─ */

/** 15 бит формата: уровень M (00) и маска, BCH(15,5) и маска 101010000010010. */
export function formatBits(mask: number) {
  const data = (0 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 бит версии (с 7-й): номер и BCH(18,6). */
export function versionBits(version: number) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/* ─ Кодирование ─ */

const dataCapacity = (v: number) => BLOCKS_M[v - 1][1].reduce((s, [n, k]) => s + n * k, 0);

/** Байты данных с заголовком, терминатором и добивкой — для версии v. */
function encodeData(bytes: Uint8Array, v: number) {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, v < 10 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  const capacity = dataCapacity(v) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((b, x) => (b << 1) | x, 0));
  for (let pad = 0xec; out.length < dataCapacity(v); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Блоки, их коды коррекции и чередование — готовая последовательность байт. */
function interleave(data: number[], v: number) {
  const [ecLen, groups] = BLOCKS_M[v - 1];
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(at, at + size));
      at += size;
    }
  }
  const ecs = blocks.map((b) => rsRemainder(b, ecLen));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) blocks.forEach((b) => i < b.length && out.push(b[i]));
  for (let i = 0; i < ecLen; i++) ecs.forEach((e) => out.push(e[i]));
  return out;
}

/* ─ Матрица ─ */

type Grid = { size: number; dark: boolean[][]; fixed: boolean[][] };

function blank(v: number): Grid {
  const size = v * 4 + 17;
  return {
    size,
    dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    fixed: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFixed(g: Grid, x: number, y: number, dark: boolean) {
  g.dark[y][x] = dark;
  g.fixed[y][x] = true;
}

function drawFormat(g: Grid, mask: number) {
  const bits = formatBits(mask);
  const s = g.size;
  for (let i = 0; i <= 5; i++) setFixed(g, 8, i, bit(bits, i));
  setFixed(g, 8, 7, bit(bits, 6));
  setFixed(g, 8, 8, bit(bits, 7));
  setFixed(g, 7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) setFixed(g, 14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) setFixed(g, s - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) setFixed(g, 8, s - 15 + i, bit(bits, i));
  setFixed(g, 8, s - 8, true); // всегда тёмный модуль
}

function drawFunctions(g: Grid, v: number) {
  const s = g.size;
  for (let i = 0; i < s; i++) {
    setFixed(g, 6, i, i % 2 === 0);
    setFixed(g, i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFixed(g, x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(s - 4, 3);
  finder(3, s - 4);
  const pos = ALIGN[v - 1];
  pos.forEach((y, i) =>
    pos.forEach((x, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFixed(g, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }),
  );
  drawFormat(g, 0); // место под формат; настоящий — после выбора маски
  if (v >= 7) {
    const bits = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const a = s - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFixed(g, a, b, bit(bits, i));
      setFixed(g, b, a, bit(bits, i));
    }
  }
}

/** Раскладка змейкой: пары столбцов справа налево, вверх-вниз, мимо служебных. */
export function zigzag(size: number, fixed: boolean[][]) {
  const cells: [number, number][] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // столбец синхронизации пропускается
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x]) cells.push([x, y]);
      }
    }
  }
  return cells;
}

export const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) if (!g.fixed[y][x] && MASKS[mask](x, y)) g.dark[y][x] = !g.dark[y][x];
  }
}

/** Штраф маски по четырём правилам стандарта — меньше значит легче сканировать. */
function penalty(g: Grid) {
  const s = g.size;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < s; i++) {
    lines.push(g.dark[i]);
    lines.push(g.dark.map((row) => row[i]));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= s; i++) {
      if (i < s && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const str = line.map((d) => (d ? '1' : '0')).join('');
    for (const pattern of ['10111010000', '00001011101']) {
      for (let at = str.indexOf(pattern); at !== -1; at = str.indexOf(pattern, at + 1)) score += 40;
    }
  }
  for (let y = 0; y < s - 1; y++) {
    for (let x = 0; x < s - 1; x++) {
      const c = g.dark[y][x];
      if (c === g.dark[y][x + 1] && c === g.dark[y + 1][x] && c === g.dark[y + 1][x + 1]) score += 3;
    }
  }
  const dark = g.dark.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 100) / (s * s) - 50) / 5) * 10;
  return score;
}

/** Матрица QR-кода для текста (UTF-8): true — тёмный модуль. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const v = [...Array(10).keys()].map((i) => i + 1).find((n) => 4 + (n < 10 ? 8 : 16) + bytes.length * 8 <= dataCapacity(n) * 8);
  if (!v) throw new Error('Слишком длинный текст для QR-кода');

  const codewords = interleave(encodeData(bytes, v), v);
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = blank(v);
    drawFunctions(g, v);
    zigzag(g.size, g.fixed).forEach(([x, y], i) => {
      // Ячеек может быть на несколько больше, чем бит (остаточные биты) — они светлые.
      g.dark[y][x] = i < codewords.length * 8 && bit(codewords[i >>> 3], 7 - (i & 7));
    });
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g);
    if (score < bestScore) {
      best = g;
      bestScore = score;
    }
  }
  return best!.dark;
}

/** Для тестов: байты, которые должны оказаться в матрице (данные + коррекция). */
export const qrCodewords = (text: string, version: number) =>
  interleave(encodeData(new TextEncoder().encode(text), version), version);

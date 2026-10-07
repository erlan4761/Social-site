// Иконки приложения: `node scripts/make-icons.mjs` из web/. Рисует без
// зависимостей — геометрия с субпиксельным сглаживанием и PNG через zlib.
// Знак Duet: два сцепленных белых кольца на зелёном — два голоса, одна пара.
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const GREEN = [11, 110, 91];
const WHITE = [255, 255, 255];
const SS = 4; // субпикселей на сторону

/** Фигуры в долях стороны; `inset` сжимает знак к центру (маскируемая иконка). */
function shapes({ inset = 1, background = 'rounded' }) {
  const c = (v) => 0.5 + (v - 0.5) * inset;
  const roundRect = (px, py, x, y, w, h, r) => {
    const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
    const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
  };
  // Кольцо — точки, чьё расстояние до центра отличается от радиуса не больше
  // чем на полтолщины.
  const ring = (px, py, cx, cy, r, half) => Math.abs(Math.hypot(px - cx, py - cy) - r) <= half;
  const r = 0.22 * inset;
  const half = 0.038 * inset;
  // Зазор вокруг кольца, которое проходит сверху, — чтобы пересечение читалось.
  const gap = half + 0.02 * inset;
  const left = (x, y, w) => ring(x, y, c(0.4), c(0.5), r, w);
  const right = (x, y, w) => ring(x, y, c(0.6), c(0.5), r, w);
  // Кольца сцеплены, а не наложены: в верхнем пересечении сверху правое, в
  // нижнем — левое. Каждое «верхнее» рисуется с зелёным зазором вокруг себя.
  return [
    // Фон: скруглённый квадрат или, для маскируемой, весь холст.
    { color: GREEN, alpha: 1, hit: (x, y) => (background === 'full' ? true : roundRect(x, y, 0, 0, 1, 1, 0.22)) },
    { color: WHITE, alpha: 1, hit: (x, y) => left(x, y, half) },
    { color: GREEN, alpha: 1, hit: (x, y) => y < 0.5 && right(x, y, gap) },
    { color: WHITE, alpha: 1, hit: (x, y) => right(x, y, half) },
    { color: GREEN, alpha: 1, hit: (x, y) => y >= 0.5 && left(x, y, gap) },
    { color: WHITE, alpha: 1, hit: (x, y) => y >= 0.5 && left(x, y, half) },
  ];
}

function render(size, options) {
  const layers = shapes(options);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (const layer of layers) {
        let cover = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
          if (layer.hit((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)) cover++;
        }
        const la = (cover / (SS * SS)) * layer.alpha;
        if (la === 0) continue;
        // Наложение «поверх» с учётом прозрачности нижнего слоя.
        const out = la + a * (1 - la);
        [r, g, b] = [0, 1, 2].map((i) => (layer.color[i] * la + [r, g, b][i] * a * (1 - la)) / out);
        a = out;
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Значок для строки состояния Android: только белые кольца на прозрачном.
 * Слои те же, что у иконки, без фона: белый закрашивает, зелёный зазор стирает.
 */
function badge(size) {
  const px = Buffer.alloc(size * size * 4);
  const [, ...marks] = shapes({ inset: 1.35 });
  const opaque = (x, y) => marks.reduce((on, layer) => (layer.hit(x, y) ? layer.color === WHITE : on), false);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cover = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      if (opaque((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)) cover++;
    }
    const i = (y * size + x) * 4;
    px.fill(255, i, i + 3);
    px[i + 3] = Math.round((cover / (SS * SS)) * 255);
  }
  return png(size, px);
}

const out = (name, data) => writeFileSync(new URL(`../public/${name}`, import.meta.url), data);
out('icon-192.png', render(192, {}));
out('icon-512.png', render(512, {}));
// Маскируемая: система сама обрежет кругом или «капсулой» — знак в безопасной зоне.
out('icon-maskable-512.png', render(512, { inset: 0.72, background: 'full' }));
out('apple-touch-icon.png', render(180, { inset: 0.86, background: 'full' }));
out('badge-96.png', badge(96));
console.log('иконки готовы');

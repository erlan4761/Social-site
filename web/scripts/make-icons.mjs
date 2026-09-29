// Иконки приложения: `node scripts/make-icons.mjs` из web/. Рисует без
// зависимостей — геометрия с субпиксельным сглаживанием и PNG через zlib.
// Знак: белая «Х» на зелёном, по краям — перфорация плёнки («Хроника»).
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const GREEN = [11, 110, 91];
const WHITE = [255, 255, 255];
const SS = 4; // субпикселей на сторону

/** Фигуры в долях стороны; `inset` сжимает знак к центру (маскируемая иконка). */
function shapes({ inset = 1, background = 'rounded' }) {
  const c = (v) => 0.5 + (v - 0.5) * inset;
  const segDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const roundRect = (px, py, x, y, w, h, r) => {
    const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
    const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
  };
  const holes = [];
  for (const y of [0.1, 0.84]) for (const x of [0.2, 0.37, 0.54, 0.71]) holes.push([c(x), c(y), 0.09 * inset, 0.06 * inset]);
  return [
    // Фон: скруглённый квадрат или, для маскируемой, весь холст.
    { color: GREEN, alpha: 1, hit: (x, y) => (background === 'full' ? true : roundRect(x, y, 0, 0, 1, 1, 0.22)) },
    { color: WHITE, alpha: 0.28, hit: (x, y) => holes.some(([hx, hy, w, h]) => roundRect(x, y, hx, hy, w, h, 0.015 * inset)) },
    {
      color: WHITE,
      alpha: 1,
      hit: (x, y) => {
        const half = 0.065 * inset;
        return segDist(x, y, c(0.31), c(0.3), c(0.69), c(0.7)) <= half || segDist(x, y, c(0.69), c(0.3), c(0.31), c(0.7)) <= half;
      },
    },
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

/** Значок для строки состояния Android: только белая «Х» на прозрачном. */
function badge(size) {
  const px = Buffer.alloc(size * size * 4);
  const [, , mark] = shapes({ inset: 1.35 });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cover = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      if (mark.hit((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)) cover++;
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

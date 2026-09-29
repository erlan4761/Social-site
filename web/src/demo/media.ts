

/** Картинки, «голосовое» и «кружок» для засева — нарисованы и записаны прямо в браузере. */
/** Картинки рисуем как SVG в data: — бинарники в статическую сборку тащить незачем. */
export function gradient(from: string, to: string, w = 720, h = 480, label = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    ${label ? `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(w / 18)}" text-anchor="middle" opacity=".75">${label}</text>` : ''}
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * «Голосовое» витрины: напетая мелодия из шести нот, собранная в WAV прямо в
 * браузере. Настоящую запись тащить в сборку незачем, а без неё плеер
 * голосовых в витрине было бы нечем показать тому, у кого нет микрофона.
 */
export function hummedVoice(seconds: number): { url: string; wave: string } {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const notes = [392, 440, 494, 440, 392, 330];
  const span = seconds / notes.length;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, n * 2, true);

  const envelope = (t: number) => Math.sin(Math.PI * ((t % span) / span)) ** 0.6;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = notes[Math.min(notes.length - 1, Math.floor(t / span))];
    const s = envelope(t) * 0.3 * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t));
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
  }

  const wave = Array.from({ length: 48 }, (_, i) => Math.round(envelope(((i + 0.5) / 48) * seconds) * 8) + 1)
    .map((d) => Math.min(9, d))
    .join('');
  return { url: URL.createObjectURL(new Blob([view], { type: 'audio/wav' })), wave };
}

/**
 * «Кружок» витрины: четыре секунды анимации на холсте, записанные в WebM
 * тем же MediaRecorder, которым пишутся настоящие. Живой камеры у витрины
 * нет, а показать, как «кружок» выглядит и играет, хочется и без неё.
 */
export async function paintedVideoNote(seconds: number): Promise<string | null> {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported('video/webm')) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 320;
  const g = canvas.getContext('2d');
  if (!g || typeof canvas.captureStream !== 'function') return null;

  const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  const done = new Promise<string>((resolve) => {
    recorder.onstop = () => resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
  });

  const start = performance.now();
  const frame = () => {
    const t = (performance.now() - start) / 1000;
    const hue = (200 + t * 40) % 360;
    const grad = g.createLinearGradient(0, 0, 320, 320);
    grad.addColorStop(0, `hsl(${hue} 55% 45%)`);
    grad.addColorStop(1, `hsl(${(hue + 70) % 360} 60% 55%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 320, 320);
    // Солнце, которое «встаёт» за четыре секунды.
    g.fillStyle = 'rgba(255, 236, 190, 0.9)';
    g.beginPath();
    g.arc(160, 250 - t * 30, 44, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '600 26px sans-serif';
    g.textAlign = 'center';
    g.fillText('привет с набережной', 160, 84);
    if (t < seconds) requestAnimationFrame(frame);
    else recorder.stop();
  };
  recorder.start();
  frame();
  return done;
}

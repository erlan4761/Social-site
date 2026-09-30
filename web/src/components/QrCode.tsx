import { useMemo } from 'react';
import { qrMatrix } from '../qr';

/**
 * QR-код картинкой: одна SVG-«дорожка» из тёмных модулей и тихая зона в
 * четыре модуля, как требует стандарт. Цвета — всегда чёрное на белом, даже в
 * тёмной теме: инвертированный код понимают не все камеры.
 */
export function QrCode({ text, size = 208, label }: { text: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const m = qrMatrix(text);
    let d = '';
    m.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + 4} ${y + 4}h1v1h-1z`)));
    return { path: d, n: m.length + 8 };
  }, [text]);

  return (
    <svg className="qr-code" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

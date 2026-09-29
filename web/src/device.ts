/**
 * «Chrome, Windows» из User-Agent — для списка сеансов и события о входе.
 * Точность не нужна — нужно узнать своё устройство и заметить чужое. Сервер
 * размечает так же (server/src/device.js).
 */
export function deviceName(ua: string | null) {
  if (!ua) return 'Неизвестное устройство';
  const browser = /YaBrowser\//.test(ua)
    ? 'Яндекс Браузер'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  if (!browser && !os) return 'Неизвестное устройство';
  return [browser, os].filter(Boolean).join(', ');
}

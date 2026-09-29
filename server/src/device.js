/**
 * «Chrome, Windows» из User-Agent — для уведомления о новом входе. Та же
 * грубая разметка, что в настройках (web/src/pages/Settings.tsx): точность не
 * нужна, нужно узнать своё устройство и заметить чужое.
 */
export function deviceLabel(ua) {
  const s = String(ua ?? '');
  const browser = /YaBrowser\//.test(s) ? 'Яндекс Браузер'
    : /Edg\//.test(s) ? 'Edge'
      : /OPR\//.test(s) ? 'Opera'
        : /Firefox\//.test(s) ? 'Firefox'
          : /Chrome\//.test(s) ? 'Chrome'
            : /Safari\//.test(s) ? 'Safari'
              : null;
  const os = /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
      : /Android/.test(s) ? 'Android'
        : /Windows/.test(s) ? 'Windows'
          : /Mac OS X|Macintosh/.test(s) ? 'macOS'
            : /Linux/.test(s) ? 'Linux'
              : null;
  return [browser, os].filter(Boolean).join(', ') || 'Неизвестное устройство';
}

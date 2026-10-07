/*
 * Сервис-воркер Duet: только пуш-уведомления и переход по ним.
 *
 * Кэша страниц здесь нет намеренно: мессенджер без сети бесполезен, а
 * закэшированная старая сборка — источник странных ошибок после выкладки.
 * Для установки на экран «Домой» браузерам хватает манифеста и воркера.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Адрес из уведомления — путь приложения («/messages/marina»); воркер живёт в
// корне приложения (scope), поэтому путь достраивается от него.
const inApp = (path) => new URL(String(path || '/').replace(/^\//, ''), self.registration.scope).href;

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Duet', {
      body: data.body || '',
      // Одна переписка — одно уведомление: новое заменяет прежнее и звенит снова.
      tag: data.tag,
      // «Без звука» — уведомление есть, но не звенит и не вибрирует, как в Телеграме.
      renotify: Boolean(data.tag) && !data.silent,
      silent: Boolean(data.silent),
      icon: inApp('icon-192.png'),
      badge: inApp('badge-96.png'),
      lang: 'ru',
      data: { url: inApp(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    (async () => {
      // Открытое окно приложения — поднять и перевести на нужную переписку.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const own = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (own) {
        await own.focus();
        if ('navigate' in own) await own.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

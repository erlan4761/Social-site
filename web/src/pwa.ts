import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * Приложение на устройстве: сервис-воркер, установка на экран «Домой» и
 * пуш-уведомления. Воркер — public/sw.js; что он делает с пушем — там же.
 */

const demo = import.meta.env.VITE_DEMO === '1';
const base = import.meta.env.BASE_URL;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => undefined);
  });
}

/* ─ Установка ────────────────────────────────────────────────────────────
 * Chrome, Edge и Android сами предлагают установку через событие
 * beforeinstallprompt — его нужно поймать сразу при загрузке и придержать до
 * нажатия кнопки. Safari такого события не знает: там только «Поделиться →
 * На экран „Домой“», и экран настроек так и подсказывает.
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let installPrompt: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
const notifyInstall = () => installListeners.forEach((l) => l());

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    notifyInstall();
  });
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Можно ли прямо сейчас предложить установку кнопкой. */
export const useInstallAvailable = () =>
  useSyncExternalStore(
    (l) => {
      installListeners.add(l);
      return () => {
        installListeners.delete(l);
      };
    },
    () => installPrompt != null,
    () => false,
  );

export async function install() {
  if (!installPrompt) return false;
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  notifyInstall();
  return outcome === 'accepted';
}

/* ─ Пуш-уведомления ──────────────────────────────────────────────────── */

export type PushState = 'unsupported' | 'demo' | 'denied' | 'off' | 'on';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration() {
  return navigator.serviceWorker.getRegistration(base);
}

export async function pushState(): Promise<PushState> {
  if (demo) return 'demo';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await (await registration())?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Ключ VAPID приходит строкой base64url, браузер ждёт байты. */
function keyBytes(base64url: string) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Включить на этом устройстве: разрешение → подписка у браузера → сервер. */
export async function enablePush(): Promise<PushState> {
  if (Notification.permission !== 'granted') {
    const answer = await Notification.requestPermission();
    if (answer !== 'granted') return answer === 'denied' ? 'denied' : 'off';
  }
  const reg = (await registration()) ?? (await navigator.serviceWorker.register(`${base}sw.js`, { scope: base }));
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.savePushSubscription({ endpoint: json.endpoint, keys: json.keys });
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (sub) {
    await api.deletePushSubscription(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
  return 'off';
}

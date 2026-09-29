import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Чего нет в jsdom, но что трогают компоненты и засев витрины: адреса для
 * «голосового» из памяти, медиазапросы (проверка «сенсорный экран») и
 * модальный <dialog>. Заглушки — ровно чтобы код не падал, поведение
 * браузера они не изображают.
 */
URL.createObjectURL ??= () => 'blob:test';
URL.revokeObjectURL ??= () => undefined;

window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList;

HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

afterEach(() => cleanup());

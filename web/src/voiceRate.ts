import { useEffect, useState } from 'react';

/**
 * Скорость голосовых и «кружков» — 1×, 1,5×, 2×, как в Телеграме. Одна на
 * все плееры: переключили у одного голосового — так же играют и остальные, а
 * выбор помнит браузер (localStorage — удобство одного человека на одном
 * устройстве, не настройка аккаунта). Хранилище бывает закрыто (приватный
 * режим) — тогда скорость живёт до перезагрузки вкладки.
 */

export const RATES = [1, 1.5, 2] as const;
const KEY = 'voice-rate';
const EVENT = 'voice-rate';

let fallback = 1;

function readRate(): number {
  try {
    const stored = Number(localStorage.getItem(KEY));
    if ((RATES as readonly number[]).includes(stored)) return stored;
  } catch {
    // хранилище закрыто — остаётся скорость этой вкладки
  }
  return fallback;
}

/** «1,5×» — с запятой, как пишут дроби по-русски. */
export const rateLabel = (rate: number) => `${String(rate).replace('.', ',')}×`;

/** Текущая скорость и «следующая по кругу». */
export function useVoiceRate(): [number, () => void] {
  const [rate, setRate] = useState(readRate);

  useEffect(() => {
    const sync = () => setRate(readRate());
    window.addEventListener(EVENT, sync);
    // Другая вкладка сменила скорость — эта узнаёт из события хранилища.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const next = () => {
    const i = (RATES as readonly number[]).indexOf(rate);
    const value = RATES[(i + 1) % RATES.length];
    fallback = value;
    try {
      localStorage.setItem(KEY, String(value));
    } catch {
      // не запомнится между перезагрузками — и только
    }
    setRate(value);
    window.dispatchEvent(new Event(EVENT));
  };

  return [rate, next];
}

import { useEffect, useRef } from 'react';

const REPO = 'https://github.com/erlan4761/Social-site';

/**
 * Витрина обязана честно говорить, что она витрина: иначе человек решит, что
 * зарегистрировался, и удивится, куда всё делось после перезагрузки.
 */
export function DemoBanner() {
  const ref = useRef<HTMLDivElement>(null);

  // Высота плашки уходит в --banner-h: мессенджер занимает ровно экран, и без
  // этой поправки его поле ввода уезжало бы под нижний край на высоту плашки.
  // Меряем, а не зашиваем число: на узком экране текст переносится.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    // Вверх, а не offsetHeight: тот округляет до ближайшего, и лишние полпикселя
    // дробной высоты давали бы прокрутку страницы на один пиксель.
    const observer = new ResizeObserver(() =>
      root.style.setProperty('--banner-h', `${Math.ceil(el.getBoundingClientRect().height)}px`),
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--banner-h');
    };
  }, []);

  if (import.meta.env.VITE_DEMO !== '1') return null;

  return (
    <div className="demo-banner" ref={ref}>
      <p>
        <strong>Демо-режим.</strong> Данные живут только в этой вкладке и сбрасываются при
        перезагрузке — GitHub&nbsp;Pages раздаёт статику и не может запустить сервер с базой.
        Полная версия с Express и SQLite —{' '}
        <a href={REPO} target="_blank" rel="noreferrer">
          в репозитории
        </a>
        .
      </p>
    </div>
  );
}

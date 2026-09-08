const REPO = 'https://github.com/erlan4761/Social-site';

/**
 * Витрина обязана честно говорить, что она витрина: иначе человек решит, что
 * зарегистрировался, и удивится, куда всё делось после перезагрузки.
 */
export function DemoBanner() {
  if (import.meta.env.VITE_DEMO !== '1') return null;

  return (
    <div className="demo-banner">
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

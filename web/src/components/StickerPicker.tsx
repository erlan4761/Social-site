import { useState } from 'react';
import { STICKER_PACKS, StickerArt } from '../stickers';

/**
 * Панель стикеров над полем ввода: вкладки наборов и сетка. Открыта, пока
 * человек выбирает; щелчок по стикеру сразу отправляет его, как в Телеграме.
 * Последний открытый набор помнится в браузере — возвращаться к любимому.
 */
const KEY = 'chronicle-sticker-pack';

function readPack() {
  try {
    const saved = localStorage.getItem(KEY);
    return STICKER_PACKS.some((p) => p.id === saved) ? saved! : STICKER_PACKS[0].id;
  } catch {
    return STICKER_PACKS[0].id;
  }
}

export function StickerPicker({ onPick, disabled }: { onPick: (id: string) => void; disabled: boolean }) {
  const [packId, setPackId] = useState(readPack);
  const pack = STICKER_PACKS.find((p) => p.id === packId) ?? STICKER_PACKS[0];

  function choose(id: string) {
    setPackId(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // приватное окно — не беда, просто не запомним
    }
  }

  return (
    <div className="sticker-picker" role="dialog" aria-label="Стикеры">
      <div className="sticker-tabs" role="tablist">
        {STICKER_PACKS.map((p) => (
          <button
            key={p.id}
            className={p.id === pack.id ? 'sticker-tab on' : 'sticker-tab'}
            type="button"
            role="tab"
            aria-selected={p.id === pack.id}
            title={p.title}
            onClick={() => choose(p.id)}
          >
            <StickerArt id={p.stickers[0].id} size={28} />
            <span>{p.title}</span>
          </button>
        ))}
      </div>
      <div className="sticker-grid" role="tabpanel" aria-label={pack.title}>
        {pack.stickers.map((s) => (
          <button key={s.id} className="sticker-cell" type="button" disabled={disabled} title={s.label} onClick={() => onPick(s.id)}>
            <StickerArt id={s.id} size={72} />
          </button>
        ))}
      </div>
    </div>
  );
}

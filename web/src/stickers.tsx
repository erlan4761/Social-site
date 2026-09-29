import type { ReactNode } from 'react';

/**
 * Встроенные стикеры. Рисуются здесь же, SVG-разметкой: ни загрузок, ни
 * внешнего сервиса, ни файлов в сборке — стикер весит столько, сколько его
 * JSX. Сервер знает только имена (STICKERS в messageExtras.js) — новый стикер
 * добавляется в двух местах: имя там и рисунок здесь.
 *
 * «Плёночка» — фирменный персонаж: катушка 35-мм плёнки с лицом, двенадцать
 * настроений. «Настроения» — крупные эмодзи на цветном круге.
 */

export type StickerPack = { id: string; title: string; stickers: { id: string; label: string }[] };

export const STICKER_PACKS: StickerPack[] = [
  {
    id: 'plenka',
    title: 'Плёночка',
    stickers: [
      { id: 'plenka/hi', label: 'Привет' },
      { id: 'plenka/ok', label: 'Отлично' },
      { id: 'plenka/yay', label: 'Ура' },
      { id: 'plenka/lol', label: 'Смешно' },
      { id: 'plenka/sad', label: 'Грустно' },
      { id: 'plenka/love', label: 'Люблю' },
      { id: 'plenka/think', label: 'Хм' },
      { id: 'plenka/thanks', label: 'Спасибо' },
      { id: 'plenka/sleep', label: 'Сплю' },
      { id: 'plenka/wow', label: 'Ого' },
      { id: 'plenka/coffee', label: 'Кофе' },
      { id: 'plenka/fire', label: 'Огонь' },
    ],
  },
  {
    id: 'mood',
    title: 'Настроения',
    stickers: [
      { id: 'mood/joy', label: 'До слёз' },
      { id: 'mood/heart', label: 'Сердце' },
      { id: 'mood/clap', label: 'Браво' },
      { id: 'mood/party', label: 'Праздник' },
      { id: 'mood/cry', label: 'Плачу' },
      { id: 'mood/angry', label: 'Злюсь' },
      { id: 'mood/cool', label: 'Круто' },
      { id: 'mood/star', label: 'Восторг' },
    ],
  },
];

const LABELS = new Map(STICKER_PACKS.flatMap((p) => p.stickers.map((s) => [s.id, s.label] as const)));
export const stickerLabel = (id: string) => LABELS.get(id) ?? 'Стикер';

/* ─ Плёночка ─────────────────────────────────────────────────────────── */

const INK = '#2d2a26';
const BODY = '#f4c542';
const BAND = '#e0492f';
const CAP = '#3b3a38';
const CHEEK = '#f28c6b';

const line = { stroke: INK, strokeWidth: 4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };

/** Рука: от бока к кисти. */
const arm = (d: string, hand: [number, number]) => (
  <>
    <path d={d} {...line} />
    <circle cx={hand[0]} cy={hand[1]} r="6" fill={BODY} stroke={INK} strokeWidth="3.5" />
  </>
);

const eyesDot = (
  <>
    <circle cx="58" cy="92" r="5" fill={INK} />
    <circle cx="86" cy="92" r="5" fill={INK} />
  </>
);
const eyesHappy = (
  <>
    <path d="M52 94 Q58 86 64 94" {...line} />
    <path d="M80 94 Q86 86 92 94" {...line} />
  </>
);
const eyesClosed = (
  <>
    <path d="M52 92 Q58 97 64 92" {...line} />
    <path d="M80 92 Q86 97 92 92" {...line} />
  </>
);
const smile = <path d="M62 106 Q72 116 82 106" {...line} />;
const cheeks = (
  <>
    <circle cx="49" cy="104" r="5" fill={CHEEK} opacity="0.7" />
    <circle cx="95" cy="104" r="5" fill={CHEEK} opacity="0.7" />
  </>
);
const heart = (x: number, y: number, s = 1, fill = BAND) => (
  <path
    transform={`translate(${x} ${y}) scale(${s})`}
    d="M0 4 C0 -2 8 -4 10 2 C12 -4 20 -2 20 4 C20 11 10 16 10 18 C10 16 0 11 0 4 Z"
    fill={fill}
    stroke={INK}
    strokeWidth="2.5"
    strokeLinejoin="round"
  />
);

/** Катушка: хвост плёнки, корпус с полосой, крышки. Лицо и руки — поверх. */
function Canister({ behind, face, front }: { behind?: ReactNode; face: ReactNode; front?: ReactNode }) {
  return (
    <>
      {behind}
      <rect x="98" y="62" width="50" height="26" rx="3" fill={INK} />
      {[106, 117, 128, 139].map((x) => (
        <g key={x} fill="#e9e3d6">
          <rect x={x} y="65" width="5" height="4" rx="1" />
          <rect x={x} y="81" width="5" height="4" rx="1" />
        </g>
      ))}
      <rect x="62" y="16" width="20" height="12" rx="3" fill={CAP} stroke={INK} strokeWidth="3" />
      <rect x="42" y="25" width="60" height="18" rx="6" fill={CAP} stroke={INK} strokeWidth="3.5" />
      <rect x="36" y="40" width="72" height="94" rx="14" fill={BODY} stroke={INK} strokeWidth="4" />
      <rect x="38" y="56" width="68" height="13" fill={BAND} />
      <rect x="42" y="130" width="60" height="12" rx="5" fill={CAP} stroke={INK} strokeWidth="3.5" />
      {face}
      {front}
    </>
  );
}

const PLENKA: Record<string, ReactNode> = {
  hi: (
    <Canister
      face={<>{eyesDot}{smile}{cheeks}</>}
      front={
        <>
          {arm('M106 98 Q124 86 128 64', [129, 60])}
          <path d="M140 50 Q146 56 144 64 M136 44 Q148 46 152 56" {...line} strokeWidth={3} />
        </>
      }
    />
  ),
  ok: (
    <Canister
      face={<>{eyesHappy}{smile}{cheeks}</>}
      front={
        <>
          <path d="M106 104 Q118 106 122 100" {...line} />
          {/* Кулак с поднятым большим пальцем. */}
          <rect x="119" y="66" width="11" height="24" rx="5.5" fill={BODY} stroke={INK} strokeWidth="3.5" />
          <rect x="114" y="86" width="22" height="18" rx="7" fill={BODY} stroke={INK} strokeWidth="3.5" />
        </>
      }
    />
  ),
  yay: (
    <Canister
      behind={
        <g>
          <rect x="14" y="30" width="7" height="7" fill={BAND} transform="rotate(20 17 33)" />
          <rect x="130" y="18" width="7" height="7" fill="#3a8fd8" transform="rotate(-15 133 21)" />
          <circle cx="24" cy="70" r="4" fill="#3a8fd8" />
          <circle cx="146" cy="106" r="4" fill={BAND} />
          <rect x="18" y="112" width="6" height="6" fill="#48b27a" transform="rotate(35 21 115)" />
        </g>
      }
      face={<>{eyesHappy}<path d="M60 104 Q72 124 84 104 Z" fill={INK} />{cheeks}</>}
      front={
        <>
          {arm('M38 94 Q22 80 20 58', [19, 54])}
          {arm('M106 94 Q122 80 124 58', [125, 54])}
        </>
      }
    />
  ),
  lol: (
    <Canister
      face={
        <>
          <path d="M52 88 L63 93 L52 98" {...line} />
          <path d="M92 88 L81 93 L92 98" {...line} />
          <path d="M58 104 Q72 128 86 104 Z" fill={INK} />
          <path d="M66 112 Q72 116 78 112" stroke={BAND} strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M46 98 Q40 108 44 114" stroke="#5aa9e6" strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M98 98 Q104 108 100 114" stroke="#5aa9e6" strokeWidth="4" strokeLinecap="round" fill="none" />
        </>
      }
    />
  ),
  sad: (
    <Canister
      face={
        <>
          <path d="M52 86 L63 90" {...line} />
          <path d="M92 86 L81 90" {...line} />
          {eyesDot}
          <path d="M62 112 Q72 102 82 112" {...line} />
          <path d="M88 100 Q84 108 88 112 Q92 108 88 100 Z" fill="#5aa9e6" stroke={INK} strokeWidth="2" />
        </>
      }
    />
  ),
  love: (
    <Canister
      behind={<>{heart(120, 18, 1.1)}{heart(10, 40, 0.8)}{heart(132, 104, 0.7)}</>}
      face={<>{heart(49, 84, 0.7)}{heart(77, 84, 0.7)}{smile}{cheeks}</>}
    />
  ),
  think: (
    <Canister
      behind={
        <>
          <circle cx="132" cy="30" r="18" fill="#fff" stroke={INK} strokeWidth="3" />
          <circle cx="116" cy="52" r="4" fill="#fff" stroke={INK} strokeWidth="2.5" />
          <text x="132" y="38" textAnchor="middle" fontSize="24" fontWeight="700" fontFamily="sans-serif" fill={INK}>?</text>
        </>
      }
      face={
        <>
          <path d="M51 84 L64 82" {...line} />
          <path d="M80 86 L93 86" {...line} />
          {eyesDot}
          <path d="M64 110 L80 107" {...line} />
        </>
      }
      front={arm('M38 116 Q50 124 62 118', [66, 116])}
    />
  ),
  thanks: (
    <Canister
      face={<>{eyesClosed}{smile}{cheeks}</>}
      front={
        <>
          {arm('M38 110 Q52 124 64 122', [68, 122])}
          {arm('M106 110 Q92 124 80 122', [76, 122])}
          {heart(62, 98, 0.9)}
        </>
      }
    />
  ),
  sleep: (
    <Canister
      behind={
        <g fill={INK} fontFamily="sans-serif" fontWeight="700">
          <text x="112" y="40" fontSize="22">Z</text>
          <text x="130" y="24" fontSize="16">z</text>
          <text x="144" y="12" fontSize="11">z</text>
        </g>
      }
      face={
        <>
          {eyesClosed}
          <ellipse cx="72" cy="110" rx="5" ry="4" fill={INK} />
          <circle cx="92" cy="112" r="5" fill="#bfe3ff" stroke={INK} strokeWidth="2" />
        </>
      }
    />
  ),
  wow: (
    <Canister
      behind={
        <g {...line} strokeWidth={4}>
          <path d="M20 40 L30 50" />
          <path d="M14 62 L28 64" />
          <path d="M124 14 L118 28" />
        </g>
      }
      face={
        <>
          <circle cx="58" cy="92" r="8" fill="#fff" stroke={INK} strokeWidth="3" />
          <circle cx="86" cy="92" r="8" fill="#fff" stroke={INK} strokeWidth="3" />
          <circle cx="58" cy="93" r="3.5" fill={INK} />
          <circle cx="86" cy="93" r="3.5" fill={INK} />
          <ellipse cx="72" cy="113" rx="7" ry="9" fill={INK} />
        </>
      }
    />
  ),
  coffee: (
    <Canister
      face={<>{eyesHappy}<path d="M64 106 Q72 112 80 106" {...line} />{cheeks}</>}
      front={
        <>
          {arm('M106 106 Q116 112 116 118', [116, 120])}
          <path d="M104 112 H134 V130 Q134 140 124 140 H114 Q104 140 104 130 Z" fill="#fff" stroke={INK} strokeWidth="3.5" strokeLinejoin="round" />
          <path d="M134 116 Q144 118 142 126 Q140 132 134 130" {...line} strokeWidth={3} />
          <rect x="107" y="114" width="24" height="5" fill="#8a5a3b" />
          <path d="M112 104 Q108 96 114 90 M122 104 Q118 94 124 86" stroke="#b9b3a8" strokeWidth="3" strokeLinecap="round" fill="none" />
        </>
      }
    />
  ),
  fire: (
    <Canister
      behind={
        <g stroke={INK} strokeWidth="3.5" strokeLinejoin="round">
          {/* Языки пламени по бокам — корпус закрывает середину. */}
          <path d="M50 146 C14 140 2 102 16 58 C22 80 28 84 32 78 C26 48 38 22 56 8 L56 146 Z" fill="#ff8a3d" />
          <path d="M94 146 C130 140 142 102 128 58 C122 80 116 84 112 78 C118 48 106 22 88 8 L88 146 Z" fill="#ff8a3d" />
          <path d="M44 146 C24 140 14 116 22 92 C26 106 32 108 36 102 C34 88 38 76 44 68 Z" fill="#ffd23f" />
          <path d="M100 146 C120 140 130 116 122 92 C118 106 112 108 108 102 C110 88 106 76 100 68 Z" fill="#ffd23f" />
        </g>
      }
      face={
        <>
          <path d="M50 86 L64 90" {...line} />
          <path d="M94 86 L80 90" {...line} />
          {eyesDot}
          <path d="M60 106 Q72 118 84 106 Z" fill={INK} />
        </>
      }
      front={arm('M106 104 Q120 100 124 90', [126, 88])}
    />
  ),
};

/* ─ Настроения ───────────────────────────────────────────────────────── */

const MOOD: Record<string, [string, string]> = {
  joy: ['😂', '#ffe08a'],
  heart: ['❤️', '#ffc9cf'],
  clap: ['👏', '#ffe3b8'],
  party: ['🥳', '#d6ecff'],
  cry: ['😭', '#cfe7ff'],
  angry: ['😡', '#ffd0c2'],
  cool: ['😎', '#d9f2e3'],
  star: ['🤩', '#fff0b3'],
};

/** Стикер по имени. Незнакомое имя — пустой круг, а не падение: сервер мог
 *  узнать о стикере раньше, чем обновилась вкладка. */
export function StickerArt({ id, size = 144 }: { id: string; size?: number }) {
  const [pack, name] = id.split('/');
  let art: ReactNode = <circle cx="80" cy="80" r="60" fill="#e9e3d6" />;
  if (pack === 'plenka' && PLENKA[name]) art = PLENKA[name];
  if (pack === 'mood' && MOOD[name]) {
    const [emoji, bg] = MOOD[name];
    art = (
      <>
        <circle cx="80" cy="80" r="62" fill={bg} />
        <text x="80" y="84" textAnchor="middle" dominantBaseline="middle" fontSize="80">
          {emoji}
        </text>
      </>
    );
  }
  return (
    <svg className="sticker-art" viewBox="0 0 160 160" width={size} height={size} role="img" aria-label={`Стикер «${stickerLabel(id)}»`}>
      {art}
    </svg>
  );
}

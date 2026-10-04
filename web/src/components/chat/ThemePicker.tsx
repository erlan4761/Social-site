import { useId } from 'react';
import { THEMES, type ChatTheme } from '../../chatThemes';

/**
 * Выбор темы переписки — образцы с фоном и своим пузырём, как они будут
 * выглядеть. Радиогруппа: стрелки ходят по образцам, выбор применяется сразу.
 */
export function ThemePicker({ value, onChange }: { value: ChatTheme | null; onChange: (t: ChatTheme | null) => void }) {
  const name = useId();
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Оформление переписки">
      {THEMES.map((t) => (
        <label key={t.key ?? 'default'} className={value === t.key ? 'theme-option on' : 'theme-option'}>
          <input className="theme-radio" type="radio" name={name} checked={value === t.key} onChange={() => onChange(t.key)} />
          <span className="theme-swatch" data-chat-theme={t.key ?? undefined} aria-hidden="true">
            <span className="theme-swatch-bubble" />
            <span className="theme-swatch-bubble mine" />
          </span>
          <span className="theme-name">{t.name}</span>
        </label>
      ))}
    </div>
  );
}

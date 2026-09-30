import { AUTO_DELETE_OPTIONS } from '../../api';
import { Icon } from '../Icon';

/**
 * Автоудаление — выбор таймера и плашка над полем ввода. Таймер касается
 * только новых сообщений: отправленное раньше исчезнет по своему правилу.
 */
export const autoDeleteLabel = (s: number) =>
  s === 0 ? 'выключено' : s === 86_400 ? 'через сутки' : s === 604_800 ? 'через неделю' : s === 2_592_000 ? 'через месяц' : `через ${s} с`;

export function AutoDeleteSelect({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (s: number) => void }) {
  return (
    <label className="field auto-delete-field">
      <span>Автоудаление новых сообщений</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {AUTO_DELETE_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {autoDeleteLabel(s)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AutoDeleteNote({ seconds }: { seconds: number }) {
  if (!seconds) return null;
  return (
    <p className="auto-delete-note" role="status">
      <Icon name="clock" size={16} />
      Новые сообщения исчезают {autoDeleteLabel(seconds)} после отправки
    </p>
  );
}

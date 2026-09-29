import { useId } from 'react';
import { COUNTRIES } from '../phone';

export type PhoneValue = { dial: string; number: string };
export const EMPTY_PHONE: PhoneValue = { dial: COUNTRIES[0].dial, number: '' };

/** Код страны списком и номер полем — на входе и в настройках одинаково. */
export function PhoneField({
  value,
  onChange,
  label = 'Номер телефона',
  autoFocus = false,
}: {
  value: PhoneValue;
  onChange: (next: PhoneValue) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <span id={`${id}-l`}>{label}</span>
      <div className="phone-row" role="group" aria-labelledby={`${id}-l`}>
        <select aria-label="Код страны" value={value.dial} onChange={(e) => onChange({ ...value, dial: e.target.value })}>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.dial}>
              {c.dial} {c.name}
            </option>
          ))}
        </select>
        <input
          type="tel"
          aria-label="Номер без кода страны"
          value={value.number}
          onChange={(e) => onChange({ ...value, number: e.target.value })}
          autoComplete="tel-national"
          inputMode="tel"
          placeholder="555 123 456"
          autoFocus={autoFocus}
          required
        />
      </div>
    </div>
  );
}

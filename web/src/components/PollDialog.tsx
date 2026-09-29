import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { ApiError, type PollInput } from '../api';
import { Icon } from './Icon';

const OPTIONS_MIN = 2;
const OPTIONS_MAX = 10;

type Props = {
  /** Где появится опрос — «в чате «Проявка»» или «в канале». */
  where: string;
  onSubmit: (poll: PollInput) => Promise<void>;
  onClose: () => void;
};

/**
 * «Новый опрос»: вопрос, от двух до десяти вариантов, «несколько ответов» и
 * «анонимно». Новое поле варианта появляется само, когда заполнено последнее, —
 * как в Телеграме, без кнопки «Добавить». Нативный `<dialog>`, как «Новый чат».
 */
export function PollDialog({ where, onSubmit, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.showModal();
    const onNativeClose = () => closeHandler.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current && !busy) dialog.current.close();
  }

  function setOption(index: number, value: string) {
    setOptions((prev) => {
      const next = prev.map((o, i) => (i === index ? value : o));
      // Заполнили последнее — следом пустое, пока не упёрлись в потолок.
      if (index === next.length - 1 && value.trim() && next.length < OPTIONS_MAX) next.push('');
      return next;
    });
  }

  function removeOption(index: number) {
    setOptions((prev) => (prev.length <= OPTIONS_MIN ? prev : prev.filter((_, i) => i !== index)));
  }

  const filled = options.map((o) => o.trim()).filter(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return setError('Напишите вопрос.');
    if (filled.length < OPTIONS_MIN) return setError('Нужно хотя бы два варианта ответа.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ question: question.trim(), options: filled, multiple, anonymous });
      dialog.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать опрос');
      setBusy(false);
    }
  }

  return (
    <dialog className="sheet poll-sheet" ref={dialog} onClick={backdrop} aria-labelledby={`${id}-title`}>
      <form onSubmit={submit}>
        <h2 className="sheet-title" id={`${id}-title`}>
          Новый опрос
        </h2>
        <p className="sheet-subject">{where}</p>
        {error && <p className="error">{error}</p>}

        <label className="field" htmlFor={`${id}-q`}>
          <span>Вопрос</span>
          <input
            id={`${id}-q`}
            type="text"
            value={question}
            maxLength={255}
            placeholder="Например: какую плёнку берём?"
            autoFocus
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>

        <fieldset className="poll-fieldset">
          <legend>
            Варианты ответа — {filled.length} из {OPTIONS_MAX}
          </legend>
          <ol className="poll-inputs">
            {options.map((o, i) => (
              <li key={i}>
                <input
                  type="text"
                  value={o}
                  maxLength={100}
                  aria-label={`Вариант ${i + 1}`}
                  placeholder={i < OPTIONS_MIN ? `Вариант ${i + 1}` : 'Ещё вариант'}
                  onChange={(e) => setOption(i, e.target.value)}
                />
                {options.length > OPTIONS_MIN && (o.trim() || i < options.length - 1) && (
                  <button className="icon-btn" type="button" aria-label={`Убрать вариант ${i + 1}`} onClick={() => removeOption(i)}>
                    <Icon name="close" size={16} />
                  </button>
                )}
              </li>
            ))}
          </ol>
        </fieldset>

        <fieldset className="folder-fieldset">
          <legend>Настройки</legend>
          <label className="check">
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
            Анонимный
          </label>
          <label className="check">
            <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
            Несколько ответов
          </label>
        </fieldset>

        <div className="sheet-foot">
          <button className="btn ghost" type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            Отмена
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Создаю…' : 'Создать опрос'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

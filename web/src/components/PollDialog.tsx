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
  const [quiz, setQuiz] = useState(false);
  /** Номер правильного варианта в списке полей (с пустыми). */
  const [correct, setCorrect] = useState<number | null>(null);
  const [explanation, setExplanation] = useState('');
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
    if (options.length <= OPTIONS_MIN) return;
    setOptions((prev) => prev.filter((_, i) => i !== index));
    // Отмеченный правильным сдвигается вместе со списком.
    setCorrect((c) => (c == null ? c : c === index ? null : c > index ? c - 1 : c));
  }

  const filled = options.map((o) => o.trim()).filter(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return setError('Напишите вопрос.');
    if (filled.length < OPTIONS_MIN) return setError('Нужно хотя бы два варианта ответа.');
    if (quiz && (correct == null || !options[correct]?.trim())) return setError('Отметьте правильный ответ викторины.');
    setBusy(true);
    setError(null);
    // Сервер считает номер правильного среди заполненных вариантов.
    const correctIndex = quiz && correct != null ? options.slice(0, correct).filter((o) => o.trim()).length : undefined;
    try {
      await onSubmit({
        question: question.trim(),
        options: filled,
        multiple: quiz ? false : multiple,
        anonymous,
        ...(quiz ? { quiz: true, correct: correctIndex, explanation: explanation.trim() || undefined } : {}),
      });
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
          {quiz ? 'Новая викторина' : 'Новый опрос'}
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
            {quiz && ', отметьте правильный'}
          </legend>
          <ol className="poll-inputs">
            {options.map((o, i) => (
              <li key={i}>
                {quiz && (
                  <input
                    className="poll-correct"
                    type="radio"
                    name={`${id}-correct`}
                    checked={correct === i}
                    disabled={!o.trim()}
                    aria-label={`Вариант ${i + 1} — правильный ответ`}
                    onChange={() => setCorrect(i)}
                  />
                )}
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
            <input type="checkbox" checked={multiple && !quiz} disabled={quiz} onChange={(e) => setMultiple(e.target.checked)} />
            Несколько ответов
          </label>
          <label className="check">
            <input type="checkbox" checked={quiz} onChange={(e) => setQuiz(e.target.checked)} />
            Викторина — один правильный ответ
          </label>
        </fieldset>

        {quiz && (
          <label className="field" htmlFor={`${id}-explain`}>
            <span>Пояснение — покажем после ответа (необязательно)</span>
            <textarea
              id={`${id}-explain`}
              rows={2}
              maxLength={200}
              value={explanation}
              placeholder="Например: Gold — цветной негатив, остальные — чёрно-белые."
              onChange={(e) => setExplanation(e.target.value)}
            />
          </label>
        )}

        <div className="sheet-foot">
          <button className="btn ghost" type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            Отмена
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Создаю…' : quiz ? 'Создать викторину' : 'Создать опрос'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

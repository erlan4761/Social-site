import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { api, ApiError, type ReportReason, type ReportTargetType } from '../api';

const LIMIT = 300;

/** Причины сервер принимает только из этого списка — чужая даёт 400. */
const REASONS: { value: ReportReason; label: string; hint: string }[] = [
  { value: 'spam', label: 'Спам', hint: 'Реклама, рассылка, накрутка' },
  { value: 'abuse', label: 'Оскорбления', hint: 'Травля, угрозы, вражда' },
  { value: 'adult', label: '«Взрослый» контент', hint: 'Не для этой ленты' },
  { value: 'other', label: 'Другое', hint: 'Опишите в комментарии' },
];

type Props = {
  targetType: ReportTargetType;
  targetId: number;
  /** О чём жалоба, человеческим языком: «Запись @boris». */
  subject: string;
  onClose: () => void;
};

/**
 * Общая форма жалобы для записи, ответа и профиля.
 *
 * Взят нативный `<dialog>` с `showModal()`: он сам уводит фокус внутрь, сам
 * возвращает его на кнопку при закрытии и сам понимает Esc. Своя реализация
 * модального окна стоила бы ловушки фокуса и обработчиков клавиатуры — при
 * нулевом выигрыше.
 */
export function ReportDialog({ targetType, targetId, subject, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const group = useId();

  const [reason, setReason] = useState<ReportReason>('spam');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null — форма; 'new' — жалоба принята; 'again' — на этот объект уже жаловались.
  const [sent, setSent] = useState<null | 'new' | 'again'>(null);

  // onClose живёт в ref: эффект открытия должен отработать ровно один раз,
  // а обработчик родителя не обязан быть стабильным между рендерами.
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.showModal();

    // Слушатель вешается руками: закрытие по Esc, по кнопке и по клику мимо
    // окна приходит одним нативным событием `close` — это надёжнее, чем
    // рассчитывать на его синтетическую обёртку.
    const onNativeClose = () => closeHandler.current();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, []);

  // После ответа сервера окно закрывается само: держать человека в диалоге,
  // где больше нечего делать, незачем. Кнопка «Закрыть» остаётся для тех,
  // кто не хочет ждать.
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => dialog.current?.close(), 1800);
    return () => clearTimeout(timer);
  }, [sent]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      const res = await api.report({
        targetType,
        targetId,
        reason,
        note: note.trim() || undefined,
      });
      setSent(res.alreadyReported ? 'again' : 'new');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отправить жалобу');
    } finally {
      setBusy(false);
    }
  }

  /** Клик мимо окна — по самому `<dialog>`, а не по его содержимому. */
  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current) dialog.current.close();
  }

  const left = LIMIT - note.length;

  return (
    <dialog className="sheet" ref={dialog} onClick={backdrop} aria-labelledby={`${group}-title`}>
      <h2 className="sheet-title" id={`${group}-title`}>
        Пожаловаться
      </h2>
      <p className="sheet-subject">{subject}</p>

      {sent ? (
        <>
          <p className="sheet-done">
            {sent === 'new'
              ? 'Жалоба отправлена. Спасибо.'
              : 'Вы уже жаловались на это — сигнал у нас записан.'}
          </p>
          <div className="sheet-foot">
            <button className="btn ghost" type="button" onClick={() => dialog.current?.close()}>
              Закрыть
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={send}>
          {error && <p className="error">{error}</p>}

          <fieldset className="choices">
            <legend>Что не так с этим?</legend>

            {REASONS.map((item) => (
              <label className="choice" key={item.value}>
                <input
                  type="radio"
                  name={`${group}-reason`}
                  value={item.value}
                  checked={reason === item.value}
                  onChange={() => setReason(item.value)}
                />
                <span>
                  <strong>{item.label}</strong>
                  <span className="choice-hint">{item.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="field" htmlFor={`${group}-note`}>
            <span>Комментарий — если есть что добавить</span>
            <textarea
              id={`${group}-note`}
              rows={3}
              value={note}
              placeholder="Необязательно"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <div className="sheet-foot">
            {left <= 60 && <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>}
            <button className="btn ghost" type="button" onClick={() => dialog.current?.close()} disabled={busy}>
              Отмена
            </button>
            <button className="btn" type="submit" disabled={busy || left < 0}>
              {busy ? 'Отправляю…' : 'Отправить'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

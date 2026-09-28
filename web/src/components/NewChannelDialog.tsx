import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { api, ApiError, type Channel } from '../api';

const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 255;
/** Те же правила, что на сервере: подсказываем раньше, чем он откажет. */
const HANDLE_RE = /^[a-z][a-z0-9_]{3,31}$/;

type Props = { onClose: () => void; onCreated: (channel: Channel) => void };

/** Транслитерация названия в адрес-подсказку: «Плёнка и свет» → plenka_i_svet.
 *  Только подсказка — адрес можно переписать. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function suggestHandle(title: string) {
  const latin = [...title.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('');
  return latin.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '').slice(0, 32);
}

/**
 * Окно «Новый канал». Устроено как «Новый чат»: нативный `<dialog>`, фокус и
 * Esc достаются от платформы. Адрес подсказывается из названия, пока человек
 * не начал писать его сам.
 */
export function NewChannelDialog({ onClose, onCreated }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [title, setTitle] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [description, setDescription] = useState('');
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

  const shownHandle = handleTouched ? handle : suggestHandle(title);
  const handleOk = HANDLE_RE.test(shownHandle) && shownHandle !== 'search';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      setError('У канала должно быть название.');
      return;
    }
    if (!handleOk) {
      setError('Адрес: 4–32 символа, латиница, цифры и _, начинается с буквы.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createChannel({ title: title.trim(), handle: shownHandle, description: description.trim() });
      dialog.current?.close();
      onCreated(res.channel);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать канал');
      setBusy(false);
    }
  }

  function backdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialog.current) dialog.current.close();
  }

  return (
    <dialog className="sheet" ref={dialog} onClick={backdrop} aria-labelledby={`${id}-title`}>
      <h2 className="sheet-title" id={`${id}-title`}>
        Новый канал
      </h2>
      <p className="sheet-subject">
        Публикуете вы, остальные подписываются, читают и комментируют. Канал открыт всем, кто вошёл на сайт.
      </p>

      <form onSubmit={submit}>
        {error && <p className="error">{error}</p>}

        <label className="field" htmlFor={`${id}-name`}>
          <span>Название</span>
          <input
            id={`${id}-name`}
            type="text"
            value={title}
            maxLength={TITLE_LIMIT}
            placeholder="Например: Заметки о плёнке"
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="field" htmlFor={`${id}-handle`}>
          <span>Адрес</span>
          <span className="handle-input">
            <span aria-hidden="true">@</span>
            <input
              id={`${id}-handle`}
              type="text"
              value={shownHandle}
              maxLength={32}
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={`${id}-handle-hint`}
              aria-invalid={shownHandle.length > 0 && !handleOk}
              onChange={(e) => {
                setHandleTouched(true);
                setHandle(e.target.value.toLowerCase().replace(/^@/, ''));
              }}
            />
          </span>
        </label>
        <p className={shownHandle && !handleOk ? 'hint over' : 'hint'} id={`${id}-handle-hint`}>
          Латиница, цифры и _, от 4 символов. По адресу канал находят в поиске.
        </p>

        <label className="field" htmlFor={`${id}-about`}>
          <span>Описание</span>
          <textarea
            id={`${id}-about`}
            rows={2}
            value={description}
            maxLength={DESCRIPTION_LIMIT}
            placeholder="О чём канал — необязательно"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="sheet-foot">
          <button className="btn ghost" type="button" onClick={() => dialog.current?.close()}>
            Отмена
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Создаю…' : 'Создать канал'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

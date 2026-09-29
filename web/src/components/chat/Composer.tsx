import { useEffect, useId, useRef, useState } from 'react';
import { type AttachmentInput, type Author } from '../../api';
import { canRecord, mmss, useRecorder } from '../../voice';
import { Icon } from '../Icon';
import { Monogram } from '../Monogram';
import { ScheduleDialog } from '../Scheduled';
import { StickerPicker } from '../StickerPicker';
import { fileSize } from './format';
import { VideoNotePreview } from './attachments';
import { mentionQuery, fold } from './MessageText';

/* ─ Поле ввода ──────────────────────────────────────────────────────────
   Текст, файлы, голосовые и «кружки», упоминания, стикеры, «отправить позже». */

const LIMIT = 1000;
/** Счётчик символов появляется, только когда до потолка осталось немного. */
const COUNTER_FROM = 120;
/** «Печатает…» уходит на сервер не чаще, чем раз в столько: сервер держит
 *  отметку шесть секунд, и трёх хватает, чтобы она не мигала. */
const TYPING_EVERY_MS = 3_000;

/** На сенсорных экранах Enter — перевод строки, как в мобильном Телеграме:
 *  отправка там — кнопкой, а случайная отправка недописанного обидна. */
const touch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/** Над полем — полоса «ответ на …» или «редактирование». */
export type ComposerMode =
  | { kind: 'reply'; id: number; who: string; body: string }
  | { kind: 'edit'; id: number; body: string }
  | null;

/** Потолок вложения — как у сервера: больше он всё равно не примет. */
const FILE_MAX = 40 * 1024 * 1024;
/** Что предлагает окно выбора файла. Решает всё равно сервер — по содержимому. */
const ACCEPT = 'image/*,video/*,audio/*,.pdf,.zip,.docx,.xlsx,.pptx';

type ComposerProps = {
  placeholder: string;
  /** Отправка или сохранение правки. `true` — готово, поле очищается;
   *  `false` — ошибка, текст остаётся. */
  onSend: (text: string) => Promise<boolean>;
  /** Отправка с вложением: файл с подписью или голосовое. Без неё скрепки и
   *  микрофона нет. */
  onSendAttachment?: (input: Omit<AttachmentInput, 'replyTo'>) => Promise<boolean>;
  mode?: ComposerMode;
  onCancelMode?: () => void;
  /** Стрелка вверх в пустом поле — править последнее своё, как в Телеграме. */
  onEditLast?: () => void;
  onTyping?: () => void;
  autoFocus?: boolean;
  /** Кого можно упомянуть через @ — участники группы без себя. */
  mentionables?: Author[];
  /** Создать опрос — кнопка рядом со скрепкой, только в группах и каналах. */
  onCreatePoll?: () => void;
  /** «Отправить позже»: правый клик или долгое нажатие на кнопку отправки.
   *  Ошибку бросает — окно выбора времени её покажет. */
  onSchedule?: (text: string, sendAt: Date) => Promise<void>;
  /** Отправить стикер — кнопка со смайликом у поля ввода. */
  onSendSticker?: (id: string) => Promise<boolean>;
};

export function Composer({
  placeholder,
  onSend,
  onSendAttachment,
  mode = null,
  onCancelMode,
  onEditLast,
  onTyping,
  autoFocus = false,
  mentionables,
  onCreatePoll,
  onSchedule,
  onSendSticker,
}: ComposerProps) {
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const id = useId();
  const [caret, setCaret] = useState(0);
  const [pickIndex, setPickIndex] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const lastTyping = useRef(0);
  const editing = mode?.kind === 'edit';
  const left = LIMIT - text.length;
  const ready = (text.trim().length > 0 || pending != null) && left >= 0 && !sending;
  const attachable = Boolean(onSendAttachment) && !editing;

  const voice = useRecorder((rec) => {
    if (!onSendAttachment) return;
    setSending(true);
    void onSendAttachment(
      rec.kind === 'video'
        ? { file: rec.blob, name: rec.name, videoNote: { duration: rec.duration } }
        : { file: rec.blob, name: rec.name, voice: { duration: rec.duration, wave: rec.wave } },
    ).finally(() => setSending(false));
  });

  // Вход в правку подставляет текст сообщения, выход из неё — очищает поле:
  // иначе после «Отмена» в поле остался бы старый текст, похожий на черновик.
  const modeKey = mode ? `${mode.kind}:${mode.id}` : '';
  const editBody = mode?.kind === 'edit' ? mode.body : null;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editBody != null) {
      setText(editBody);
      wasEditing.current = true;
    } else if (wasEditing.current) {
      setText('');
      wasEditing.current = false;
    }
    if (modeKey) field.current?.focus();
  }, [modeKey, editBody]);

  // Миниатюра выбранного фото — через object URL, который надо отпускать.
  useEffect(() => {
    if (!pending || !pending.type.startsWith('image/')) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(pending);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);

  function pick(file: File | null | undefined) {
    setFileError(null);
    if (!file) return;
    if (file.size > FILE_MAX) {
      setFileError('Файл больше 40 МБ — такой не отправить.');
      return;
    }
    setPending(file);
    field.current?.focus();
  }

  async function submit() {
    const trimmed = text.trim();
    if ((!trimmed && !pending) || trimmed.length > LIMIT || sending) return;
    setSending(true);
    const ok =
      pending && onSendAttachment && !editing
        ? await onSendAttachment({ file: pending, name: pending.name, body: trimmed })
        : await onSend(trimmed);
    setSending(false);
    if (ok) {
      setText('');
      setPending(null);
      wasEditing.current = false;
    }
    field.current?.focus();
  }

  // Подсказка упоминаний: «@» и начало логина или имени — до шести участников.
  const query = mentionables?.length ? mentionQuery(text, caret) : null;
  const suggestions =
    query && dismissed !== query.start
      ? mentionables!
          .filter((a) => a.username.startsWith(query.q) || fold(a.displayName).split(/\s+/).some((w) => w.startsWith(query.q)))
          .slice(0, 6)
      : [];
  const active = Math.min(pickIndex, Math.max(0, suggestions.length - 1));

  function insertMention(a: Author) {
    if (!query) return;
    const before = text.slice(0, query.start);
    const after = text.slice(caret);
    const next = `${before}@${a.username} ${after.replace(/^\s+/, '')}`;
    const at = before.length + a.username.length + 2;
    setText(next);
    setCaret(at);
    setPickIndex(0);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(at, at);
    });
  }

  // Пустое поле без файла — вместо «Отправить» микрофон, как в Телеграме.
  const showMic = attachable && canRecord() && !text.trim() && !pending;

  return (
    <div className="composer-wrap">
      {mode && (
        <div className={mode.kind === 'edit' ? 'composer-mode edit' : 'composer-mode'}>
          <Icon name={mode.kind === 'edit' ? 'edit' : 'reply'} size={20} />
          {/* Имя автора, а не «Ответ Марине»: склонять имена надёжно нельзя,
              а стрелка ответа рядом и так говорит, что это ответ. */}
          <span className="composer-mode-text">
            <strong>
              {mode.kind === 'edit' ? (
                'Редактирование'
              ) : (
                <>
                  <span className="sr-only">Ответ на сообщение: </span>
                  {mode.who}
                </>
              )}
            </strong>
            <span>{mode.body}</span>
          </span>
          <button className="icon-btn" type="button" aria-label="Отменить" onClick={onCancelMode}>
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {pending && (
        <div className="composer-file">
          {preview ? (
            <img className="composer-file-thumb" src={preview} alt="" />
          ) : (
            <span className="composer-file-icon">
              <Icon name={pending.type.startsWith('audio/') ? 'music' : 'file'} size={22} />
            </span>
          )}
          <span className="composer-file-text">
            <strong>{pending.name}</strong>
            <span>{fileSize(pending.size)}</span>
          </span>
          <button className="icon-btn" type="button" aria-label="Убрать файл" onClick={() => setPending(null)}>
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {(fileError || voice.error) && (
        <p className="composer-error" role="alert">
          {fileError ?? voice.error}
        </p>
      )}

      {suggestions.length > 0 && (
        <ul className="mention-pop" role="listbox" id={`${id}-mentions`} aria-label="Кого упомянуть">
          {suggestions.map((a, i) => (
            <li
              key={a.id}
              id={`${id}-mention-${a.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : undefined}
              // mousedown, а не click: поле не должно терять фокус и каретку.
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(a);
              }}
            >
              <Monogram username={a.username} displayName={a.displayName} avatarUrl={a.avatarUrl} size="sm" />
              <strong>{a.displayName}</strong>
              <span>@{a.username}</span>
            </li>
          ))}
        </ul>
      )}

      {stickersOpen && onSendSticker && !voice.recording && (
        <StickerPicker
          disabled={sending}
          onPick={(sticker) => {
            setSending(true);
            void onSendSticker(sticker).then((ok) => {
              setSending(false);
              if (ok) setStickersOpen(false);
            });
          }}
        />
      )}

      {scheduling != null && onSchedule && (
        <ScheduleDialog
          title="Отправить позже"
          preview={scheduling}
          submitLabel="Запланировать"
          onSubmit={async (at) => {
            await onSchedule(scheduling, at);
            setText('');
          }}
          onClose={() => {
            setScheduling(null);
            field.current?.focus();
          }}
        />
      )}

      {voice.recording === 'video' && voice.stream && (
        <VideoNotePreview stream={voice.stream} elapsed={voice.elapsed} />
      )}

      {voice.recording ? (
        <div
          className="composer recording"
          role="group"
          aria-label={voice.recording === 'video' ? 'Запись видеосообщения' : 'Запись голосового'}
        >
          <button className="icon-btn" type="button" aria-label="Отменить запись" onClick={() => voice.stop(true)}>
            <Icon name="trash" />
          </button>
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time" aria-live="off">
            {mmss(voice.elapsed)}
          </span>
          <span className="rec-hint">Идёт запись — отправьте, когда закончите</span>
          <button
            className="composer-send"
            type="button"
            aria-label={voice.recording === 'video' ? 'Отправить видеосообщение' : 'Отправить голосовое'}
            onClick={() => voice.stop(false)}
          >
            <Icon name="send" size={20} />
          </button>
        </div>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {attachable && (
            <>
              <button
                className="icon-btn composer-attach"
                type="button"
                aria-label="Прикрепить файл"
                title="Фото, видео, музыка или документ"
                onClick={() => picker.current?.click()}
              >
                <Icon name="paperclip" />
              </button>
              {onCreatePoll && (
                <button
                  className="icon-btn composer-poll"
                  type="button"
                  aria-label="Создать опрос"
                  title="Опрос"
                  onClick={onCreatePoll}
                >
                  <Icon name="poll" />
                </button>
              )}
              <input
                ref={picker}
                type="file"
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </>
          )}

          <label className="sr-only" htmlFor={id}>
            {editing ? 'Новый текст сообщения' : pending ? 'Подпись к файлу' : 'Сообщение'}
          </label>
          <textarea
            id={id}
            ref={field}
            rows={1}
            value={text}
            placeholder={pending ? 'Подпись' : placeholder}
            autoFocus={autoFocus && !touch()}
            aria-autocomplete={mentionables ? 'list' : undefined}
            aria-controls={suggestions.length ? `${id}-mentions` : undefined}
            aria-activedescendant={suggestions.length ? `${id}-mention-${suggestions[active].id}` : undefined}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setPickIndex(0);
              const now = Date.now();
              if (onTyping && e.target.value.trim() && !editing && now - lastTyping.current > TYPING_EVERY_MS) {
                lastTyping.current = now;
                onTyping();
              }
            }}
            // Вставка картинки из буфера (скриншот) — сразу вложение, как в Телеграме.
            onPaste={(e) => {
              const file = attachable ? e.clipboardData.files[0] : undefined;
              if (file) {
                e.preventDefault();
                pick(file);
              }
            }}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setPickIndex((active + step + suggestions.length) % suggestions.length);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  insertMention(suggestions[active]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDismissed(query!.start);
                  return;
                }
              }
              if (e.key === 'Escape' && (mode || pending)) {
                e.preventDefault();
                if (pending) setPending(null);
                else onCancelMode?.();
                return;
              }
              if (e.key === 'ArrowUp' && !text && !mode && !pending && onEditLast) {
                e.preventDefault();
                onEditLast();
                return;
              }
              // isComposing — набор через IME: Enter там подтверждает слово, а не
              // отправляет сообщение.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touch()) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {left <= COUNTER_FROM && <span className={left < 0 ? 'counter over' : 'counter'}>{left}</span>}
          {onSendSticker && !editing && (
            <button
              className={stickersOpen ? 'icon-btn composer-sticker on' : 'icon-btn composer-sticker'}
              type="button"
              aria-label={stickersOpen ? 'Закрыть стикеры' : 'Стикеры'}
              aria-expanded={stickersOpen}
              title="Стикеры"
              onClick={() => setStickersOpen((v) => !v)}
            >
              <Icon name="sticker" />
            </button>
          )}
          {showMic ? (
            <>
              {/* «Кружок» — отдельной кнопкой рядом с микрофоном: в вебе явная
                  кнопка понятнее переключателя «нажми — сменится режим». */}
              {canRecord('video') && (
                <button
                  className="icon-btn composer-video"
                  type="button"
                  aria-label="Записать видеосообщение"
                  title="Видеосообщение — до минуты"
                  disabled={sending}
                  onClick={() => {
                    voice.clearError();
                    void voice.start('video');
                  }}
                >
                  <Icon name="video" />
                </button>
              )}
              <button
                className="composer-send mic"
                type="button"
                aria-label="Записать голосовое"
                disabled={sending}
                onClick={() => {
                  voice.clearError();
                  void voice.start('voice');
                }}
              >
                <Icon name="mic" size={20} />
              </button>
            </>
          ) : (
            <button
              className="composer-send"
              type="submit"
              disabled={!ready}
              aria-label={editing ? 'Сохранить' : 'Отправить'}
              title={onSchedule && !mode ? 'Отправить. Правый клик или долгое нажатие — отправить позже' : undefined}
              onContextMenu={(e) => {
                // Отложить можно обычное сообщение — без ответа, правки и файла.
                if (!onSchedule || mode || pending || !ready) return;
                e.preventDefault();
                setScheduling(text.trim());
              }}
            >
              <Icon name={editing ? 'check' : 'send'} size={20} />
            </button>
          )}
        </form>
      )}
    </div>
  );
}

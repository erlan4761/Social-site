import { useEffect, useId, useRef, useState } from 'react';
import { type AttachmentInput, type Author } from '../../api';
import { canRecord, mmss, useRecorder } from '../../voice';
import { Icon } from '../Icon';
import { Monogram } from '../Monogram';
import { ScheduleDialog } from '../Scheduled';
import { StickerPicker } from '../StickerPicker';
import { fileSize } from './format';
import { VideoNotePreview } from './attachments';
import { useDraft, type DraftTarget } from './draft';
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
/** Файлов за раз — как фото в альбоме у сервера и в Телеграме. */
const FILES_MAX = 10;

const isMedia = (f: File) => f.type.startsWith('image/') || f.type.startsWith('video/');
/** Код нового альбома — его придумывает клиент (см. messageExtras.js на сервере). */
export const newAlbumId = () => crypto.randomUUID().replace(/-/g, '');
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
  /** Черновик этого чата на сервере. Родитель даёт полю `key` по чату. */
  draft?: DraftTarget;
  /** Несколько фото и видео уходят альбомом (ЛС и группы); иначе — по одному. */
  albums?: boolean;
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
  draft,
  albums = false,
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
  const [pending, setPending] = useState<File[]>([]);
  const [previews, setPreviews] = useState<(string | null)[]>([]);
  const [dropping, setDropping] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const lastTyping = useRef(0);
  const editing = mode?.kind === 'edit';
  const left = LIMIT - text.length;
  const ready = (text.trim().length > 0 || pending.length > 0) && left >= 0 && !sending;
  const attachable = Boolean(onSendAttachment) && !editing;
  const drafts = useDraft(draft, text, setText, editing);

  const voice = useRecorder((rec) => {
    if (!onSendAttachment) return;
    setSending(true);
    void onSendAttachment(
      rec.kind === 'video'
        ? { file: rec.blob, name: rec.name, videoNote: { duration: rec.duration } }
        : { file: rec.blob, name: rec.name, voice: { duration: rec.duration, wave: rec.wave } },
    ).finally(() => setSending(false));
  });

  // Вход в правку подставляет текст сообщения, выход из неё возвращает
  // черновик (или пустое поле): иначе после «Отмена» в поле остался бы старый
  // текст сообщения, похожий на черновик.
  const modeKey = mode ? `${mode.kind}:${mode.id}` : '';
  const editBody = mode?.kind === 'edit' ? mode.body : null;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editBody != null) {
      if (!wasEditing.current) drafts.flush();
      setText(editBody);
      wasEditing.current = true;
    } else if (wasEditing.current) {
      setText(drafts.body());
      wasEditing.current = false;
    }
    if (modeKey) field.current?.focus();
  }, [modeKey, editBody]);

  // Миниатюры выбранных фото — через object URL, которые надо отпускать.
  useEffect(() => {
    const urls = pending.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null));
    setPreviews(urls);
    return () => urls.forEach((u) => u && URL.revokeObjectURL(u));
  }, [pending]);

  /** Добавить файлы — из окна выбора, перетаскиванием или вставкой из буфера. */
  function pick(files: FileList | File[] | null | undefined) {
    setFileError(null);
    const list = [...(files ?? [])];
    if (list.length === 0) return;
    const fits = list.filter((f) => f.size <= FILE_MAX);
    const problems: string[] = [];
    if (fits.length < list.length) problems.push('Файлы больше 40 МБ не отправить — их пропустили.');
    let next = [...pending, ...fits];
    if (next.length > FILES_MAX) {
      next = next.slice(0, FILES_MAX);
      problems.push(`За раз — не больше ${FILES_MAX} файлов.`);
    }
    if (problems.length) setFileError(problems.join(' '));
    setPending(next);
    field.current?.focus();
  }

  /**
   * Файлы по одному запросу на каждый. Фото и видео (два и больше) — альбомом:
   * общий код, подпись у первого, как в Телеграме. Не ушёл какой-то — он и
   * следующие остаются в поле, отправленные уже не повторяются.
   */
  async function sendFiles(caption: string) {
    const album = albums && pending.length > 1 && pending.every(isMedia) ? newAlbumId() : undefined;
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i];
      const ok = await onSendAttachment!({ file: f, name: f.name, body: i === 0 ? caption : '', album });
      if (!ok) {
        if (i > 0) {
          setPending(pending.slice(i));
          drafts.clear();
          setText('');
        }
        return false;
      }
    }
    return true;
  }

  async function submit() {
    const trimmed = text.trim();
    if ((!trimmed && pending.length === 0) || trimmed.length > LIMIT || sending) return;
    setSending(true);
    const ok = pending.length > 0 && onSendAttachment && !editing ? await sendFiles(trimmed) : await onSend(trimmed);
    setSending(false);
    if (ok) {
      if (editing) {
        // Правка сохранена — в поле возвращается то, что было до неё.
        setText(drafts.body());
      } else {
        drafts.clear();
        setText('');
      }
      setPending([]);
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

  // Перетащить файлы можно на всю переписку, а не только на поле ввода:
  // слушаем ближайшую панель чата (.pane), подсветка — там же.
  const wrap = useRef<HTMLDivElement>(null);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    const zone = wrap.current?.closest<HTMLElement>('.pane');
    if (!zone || !attachable) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDropping(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      pickRef.current(e.dataTransfer?.files);
    };
    zone.addEventListener('dragenter', enter);
    zone.addEventListener('dragover', over);
    zone.addEventListener('dragleave', leave);
    zone.addEventListener('drop', drop);
    return () => {
      zone.removeEventListener('dragenter', enter);
      zone.removeEventListener('dragover', over);
      zone.removeEventListener('dragleave', leave);
      zone.removeEventListener('drop', drop);
    };
  }, [attachable]);

  // Пустое поле без файла — вместо «Отправить» микрофон, как в Телеграме.
  const showMic = attachable && canRecord() && !text.trim() && pending.length === 0;

  return (
    <div className="composer-wrap" ref={wrap}>
      {dropping && (
        <div className="drop-hint" aria-hidden="true">
          Отпустите — файлы прикрепятся{albums ? ' (фото и видео уйдут альбомом)' : ''}
        </div>
      )}
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

      {pending.length === 1 && (
        <div className="composer-file">
          {previews[0] ? (
            <img className="composer-file-thumb" src={previews[0]} alt="" />
          ) : (
            <span className="composer-file-icon">
              <Icon name={pending[0].type.startsWith('audio/') ? 'music' : 'file'} size={22} />
            </span>
          )}
          <span className="composer-file-text">
            <strong>{pending[0].name}</strong>
            <span>{fileSize(pending[0].size)}</span>
          </span>
          <button className="icon-btn" type="button" aria-label="Убрать файл" onClick={() => setPending([])}>
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      {pending.length > 1 && (
        <div className="composer-files">
          <ul>
            {pending.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {previews[i] ? (
                  <img className="composer-file-thumb" src={previews[i]!} alt="" />
                ) : (
                  <span className="composer-file-icon" title={f.name}>
                    <Icon name={f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'music' : 'file'} size={20} />
                  </span>
                )}
                <button
                  className="composer-files-remove"
                  type="button"
                  aria-label={`Убрать «${f.name}»`}
                  onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <span className="composer-files-note">
            {albums && pending.every(isMedia) ? `Альбом: ${pending.length} — подпись будет у первого` : `Файлов: ${pending.length} — каждый отдельным сообщением`}
          </span>
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
                multiple
                hidden
                onChange={(e) => {
                  pick(e.target.files);
                  e.target.value = '';
                }}
              />
            </>
          )}

          <label className="sr-only" htmlFor={id}>
            {editing ? 'Новый текст сообщения' : pending.length ? 'Подпись к файлу' : 'Сообщение'}
          </label>
          <textarea
            id={id}
            ref={field}
            rows={1}
            value={text}
            placeholder={pending.length ? 'Подпись' : placeholder}
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
              if (attachable && e.clipboardData.files.length > 0) {
                e.preventDefault();
                pick(e.clipboardData.files);
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
              if (e.key === 'Escape' && (mode || pending.length)) {
                e.preventDefault();
                if (pending.length) setPending([]);
                else onCancelMode?.();
                return;
              }
              if (e.key === 'ArrowUp' && !text && !mode && !pending.length && onEditLast) {
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
                if (!onSchedule || mode || pending.length || !ready) return;
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

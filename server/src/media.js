import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './dataDir.js';
import { bad } from './validate.js';

export const uploadsDir = join(dataDir, 'uploads');

const dirFor = {
  avatar: join(uploadsDir, 'avatars'),
  media: join(uploadsDir, 'media'),
  // Вложения переписки — НЕ под uploadsDir: тот раздаётся статикой любому,
  // у кого есть ссылка, а фото из личного чата должно открываться только его
  // участникам. Отдаёт их routes/attachments.js, с той же проверкой доступа,
  // что и у самого сообщения.
  attachment: join(dataDir, 'attachments'),
};
for (const dir of Object.values(dirFor)) mkdirSync(dir, { recursive: true });

/**
 * File type is decided by sniffing magic bytes, never by the client's declared
 * MIME type or filename extension — those are just labels an attacker can lie
 * about. A renamed .html served back as "image.jpg" is how stored XSS happens.
 */
const SIGNATURES = [
  { kind: 'image', mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: 'image', mime: 'image/gif', ext: 'gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { kind: 'image', mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { kind: 'video', mime: 'video/mp4', ext: 'mp4', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  { kind: 'video', mime: 'video/webm', ext: 'webm', test: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3', test: (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { kind: 'audio', mime: 'audio/ogg', ext: 'ogg', test: (b) => b.subarray(0, 4).toString('latin1') === 'OggS' },
  { kind: 'audio', mime: 'audio/wav', ext: 'wav', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE' },
  // Документы — только во вложениях переписки и только скачиванием (см.
  // routes/attachments.js). ZIP — это и docx/xlsx/pptx: внутри они архивы.
  { kind: 'file', mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { kind: 'file', mime: 'application/zip', ext: 'zip', test: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
];

/** Sniffs a buffer's real format. Returns null when nothing recognised matches. */
export function detectSignature(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return SIGNATURES.find((sig) => sig.test(buffer)) ?? null;
}

const KIND_LABELS = { image: 'изображение', video: 'видео', audio: 'аудио', file: 'PDF или архив/документ Office' };

/**
 * Validates a buffer against an allowed set of kinds and writes it to disk
 * under a random name — user input never reaches the filesystem path.
 * Throws a 400 HttpError (via `bad`) when the content doesn't match anything
 * allowed, so callers can just await this inside their route handler.
 */
export async function storeUpload(buffer, { allowedKinds, into }) {
  const sig = detectSignature(buffer);
  if (!sig || !allowedKinds.includes(sig.kind)) {
    const allowed = allowedKinds.map((k) => KIND_LABELS[k]).join(', ');
    throw bad(`Файл не похож на поддерживаемый формат (${allowed}). Проверьте, что это не переименованный файл.`);
  }

  const filename = `${randomUUID()}.${sig.ext}`;
  await writeFile(join(dirFor[into], filename), buffer);

  return { filename, kind: sig.kind, mime: sig.mime };
}

/**
 * Имя файла из multipart в человеческом виде. Браузеры шлют его байтами UTF-8,
 * а multer разбирает их как latin1 — «Договор.pdf» превращается в «ÐÐ¾Ð³…».
 * Переразбираем, но только если строка действительно похожа на такую ошибку:
 * символ за пределами latin1 значит, что имя уже прочитано правильно, а
 * U+FFFD после переразбора — что это были не UTF-8 байты.
 */
export function fileName(original) {
  const name = String(original ?? '');
  if (/[^\u0000-ÿ]/.test(name)) return name;
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}

/** Полный путь к сохранённому файлу — для отдачи через sendFile. */
export const uploadPath = (into, filename) => join(dirFor[into], filename);

/** Копия под новым случайным именем: у пересланного вложения своя жизнь —
 *  оригинал удалят, а копия должна остаться. */
export async function copyUpload(into, filename) {
  const ext = filename.slice(filename.lastIndexOf('.'));
  const copy = `${randomUUID()}${ext}`;
  await copyFile(join(dirFor[into], filename), join(dirFor[into], copy));
  return copy;
}

/** Best-effort delete — a missing file is not an error worth failing the request over. */
export function deleteUpload(into, filename) {
  if (!filename) return;
  try {
    unlinkSync(join(dirFor[into], filename));
  } catch {
    // already gone, or never existed — fine either way
  }
}

export const publicUrl = (into, filename) => (filename ? `/uploads/${into === 'avatar' ? 'avatars' : 'media'}/${filename}` : null);

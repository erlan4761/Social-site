import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './dataDir.js';
import { bad } from './validate.js';

export const uploadsDir = join(dataDir, 'uploads');

const dirFor = { avatar: join(uploadsDir, 'avatars'), media: join(uploadsDir, 'media') };
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
];

/** Sniffs a buffer's real format. Returns null when nothing recognised matches. */
export function detectSignature(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return SIGNATURES.find((sig) => sig.test(buffer)) ?? null;
}

const KIND_LABELS = { image: 'изображение', video: 'видео', audio: 'аудио' };

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

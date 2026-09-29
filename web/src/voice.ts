import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Запись в браузере — голосового и «кружка». MediaRecorder пишет поток, а
 * AnalyserNode по дороге снимает громкость: у голосового из неё получается
 * «волна», которую рисует пузырь. Всё на стороне браузера, без библиотек.
 */

export type RecordKind = 'voice' | 'video';

/** Столько столбиков у «волны» — и столько же цифр уходит на сервер. */
const BARS = 48;
/** Громкость снимается десять раз в секунду. */
const SAMPLE_MS = 100;
/** Потолки сервера: голосовое — пять минут, «кружок» — минута. На них
 *  запись останавливается сама. */
export const VOICE_MAX_S = 300;
export const VIDEO_NOTE_MAX_S = 60;

/** Chrome и Firefox пишут WebM/Ogg, Safari — MP4. Берём первое, что умеет браузер. */
const FORMATS: Record<RecordKind, { mime: string; ext: string }[]> = {
  voice: [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
    { mime: 'audio/mp4', ext: 'm4a' },
  ],
  video: [
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
    { mime: 'video/mp4', ext: 'mp4' },
  ],
};

export type Recorded = { kind: RecordKind; blob: Blob; name: string; duration: number; wave: string };

export const canRecord = (kind: RecordKind = 'voice') =>
  typeof window !== 'undefined' &&
  'MediaRecorder' in window &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  (kind === 'voice' || FORMATS.video.some((f) => MediaRecorder.isTypeSupported(f.mime)));

/** Громкости по времени → строка из BARS цифр 0–9, нормированная по самому громкому месту. */
function toWave(levels: number[]) {
  if (levels.length === 0) return '0'.repeat(BARS);
  const buckets = Array.from({ length: BARS }, (_, i) => {
    const from = Math.floor((i * levels.length) / BARS);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / BARS));
    const part = levels.slice(from, to);
    return part.reduce((s, x) => s + x, 0) / part.length;
  });
  const peak = Math.max(...buckets, 1e-6);
  return buckets.map((b) => Math.min(9, Math.round((b / peak) * 9))).join('');
}

/** Квадратная картинка с фронтальной камеры — «кружок» вырезается из неё. */
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: 'user',
  width: { ideal: 480 },
  height: { ideal: 480 },
  aspectRatio: { ideal: 1 },
};

export function useRecorder(onDone: (rec: Recorded) => void) {
  const [recording, setRecording] = useState<RecordKind | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Поток камеры — для живого предпросмотра «кружка». */
  const [stream, setStream] = useState<MediaStream | null>(null);

  const state = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    audio: AudioContext;
    timer: number;
    cancelled: boolean;
  } | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const cleanup = useCallback(() => {
    const s = state.current;
    if (!s) return;
    window.clearInterval(s.timer);
    s.stream.getTracks().forEach((t) => t.stop());
    void s.audio.close().catch(() => undefined);
    state.current = null;
    setRecording(null);
    setStream(null);
    setElapsed(0);
  }, []);

  const stop = useCallback((cancel = false) => {
    const s = state.current;
    if (!s) return;
    s.cancelled = cancel;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
  }, []);

  const start = useCallback(async (kind: RecordKind) => {
    if (state.current) return;
    setError(null);
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia(
        kind === 'video' ? { audio: true, video: VIDEO_CONSTRAINTS } : { audio: true },
      );
    } catch {
      setError(
        kind === 'video'
          ? 'Нет доступа к камере или микрофону. Разрешите их в настройках браузера.'
          : 'Нет доступа к микрофону. Разрешите его в настройках браузера.',
      );
      return;
    }

    const format = FORMATS[kind].find((f) => MediaRecorder.isTypeSupported(f.mime)) ?? null;
    const recorder = new MediaRecorder(media, format ? { mimeType: format.mime } : undefined);
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(media).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const chunks: Blob[] = [];
    const levels: number[] = [];
    const started = Date.now();
    const max = kind === 'video' ? VIDEO_NOTE_MAX_S : VOICE_MAX_S;

    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      // RMS — «средняя громкость» кадра: пики одиночных щелчков её не рвут.
      levels.push(Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length));
      const secs = (Date.now() - started) / 1000;
      setElapsed(secs);
      if (secs >= max) stop(false);
    }, SAMPLE_MS);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const cancelled = state.current?.cancelled ?? true;
      const duration = Math.round((Date.now() - started) / 1000);
      cleanup();
      // Меньше секунды — случайное нажатие, а не сообщение.
      if (cancelled || duration < 1 || chunks.length === 0) return;
      const type = recorder.mimeType || format?.mime || (kind === 'video' ? 'video/webm' : 'audio/webm');
      const ext = FORMATS[kind].find((f) => type.startsWith(f.mime.split(';')[0]))?.ext ?? 'webm';
      done.current({
        kind,
        blob: new Blob(chunks, { type }),
        name: `${kind === 'video' ? 'videonote' : 'voice'}.${ext}`,
        duration: Math.min(duration, max),
        wave: toWave(levels),
      });
    };

    state.current = { recorder, stream: media, audio, timer, cancelled: false };
    recorder.start();
    setRecording(kind);
    if (kind === 'video') setStream(media);
  }, [cleanup, stop]);

  // Ушли со страницы посреди записи — камера и микрофон должны погаснуть.
  useEffect(() => () => stop(true), [stop]);

  return { recording, elapsed, error, stream, start, stop, clearError: () => setError(null) };
}

/** `83` → `1:23`. */
export const mmss = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

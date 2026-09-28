import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Запись голосового в браузере: MediaRecorder пишет звук, AnalyserNode по
 * дороге снимает громкость — из неё получается «волна», которую рисует
 * пузырь. Всё на стороне браузера, без библиотек.
 */

/** Столько столбиков у «волны» — и столько же цифр уходит на сервер. */
const BARS = 48;
/** Громкость снимается десять раз в секунду. */
const SAMPLE_MS = 100;
/** Потолок сервера — пять минут; на нём запись останавливается сама. */
export const VOICE_MAX_S = 300;

/** Chrome и Firefox пишут WebM/Ogg с Opus, Safari — MP4. Берём первое, что умеет браузер. */
const FORMATS = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mime: 'audio/mp4', ext: 'm4a' },
];

export type Recorded = { blob: Blob; name: string; duration: number; wave: string };

export const canRecord = () =>
  typeof window !== 'undefined' && 'MediaRecorder' in window && Boolean(navigator.mediaDevices?.getUserMedia);

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

export function useVoiceRecorder(onDone: (rec: Recorded) => void) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const state = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    audio: AudioContext;
    timer: number;
    started: number;
    levels: number[];
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
    setRecording(false);
    setElapsed(0);
  }, []);

  const stop = useCallback((cancel = false) => {
    const s = state.current;
    if (!s) return;
    s.cancelled = cancel;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (state.current) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Нет доступа к микрофону. Разрешите его в настройках браузера.');
      return;
    }

    const format = FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime)) ?? null;
    const recorder = new MediaRecorder(stream, format ? { mimeType: format.mime } : undefined);
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const chunks: Blob[] = [];
    const levels: number[] = [];
    const started = Date.now();

    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      // RMS — «средняя громкость» кадра: пики одиночных щелчков её не рвут.
      levels.push(Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length));
      const secs = (Date.now() - started) / 1000;
      setElapsed(secs);
      if (secs >= VOICE_MAX_S) stop(false);
    }, SAMPLE_MS);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const s = state.current;
      const cancelled = s?.cancelled ?? true;
      const duration = Math.round((Date.now() - started) / 1000);
      cleanup();
      // Меньше секунды — случайное нажатие, а не сообщение.
      if (cancelled || duration < 1 || chunks.length === 0) return;
      const type = recorder.mimeType || format?.mime || 'audio/webm';
      const ext = FORMATS.find((f) => type.startsWith(f.mime.split(';')[0]))?.ext ?? 'webm';
      done.current({
        blob: new Blob(chunks, { type }),
        name: `voice.${ext}`,
        duration: Math.min(duration, VOICE_MAX_S),
        wave: toWave(levels),
      });
    };

    state.current = { recorder, stream, audio, timer, started, levels, cancelled: false };
    recorder.start();
    setRecording(true);
  }, [cleanup, stop]);

  // Ушли со страницы посреди записи — микрофон должен погаснуть.
  useEffect(() => () => stop(true), [stop]);

  return { recording, elapsed, error, start, stop, clearError: () => setError(null) };
}

/** `83` → `1:23`. */
export const mmss = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

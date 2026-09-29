import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from './api';
import { Icon } from './components/Icon';
import { Monogram } from './components/Monogram';
import { useLive, type CallEvent } from './live';

/**
 * Звонки один на один — голос и видео (WebRTC). Звук и картинка идут
 * напрямую между браузерами, сервер только сводит их: «предложение», «ответ»
 * и сетевые кандидаты (server/src/calls.js). Провайдер живёт в оболочке, так
 * что входящий звонок застаёт человека на любом экране.
 *
 * Без TURN-сервера соединение проходит не через все сети — тогда звонок
 * честно говорит «не удалось соединиться», а не висит молча.
 */

export type CallPeer = { id: number; username: string; displayName: string; avatarUrl: string | null };

type Phase = 'dialing' | 'incoming' | 'connecting' | 'active' | 'ended';

type CallState = {
  id: string | null;
  peer: CallPeer;
  video: boolean;
  phase: Phase;
  /** Почему закончился — словами для экрана. */
  note?: string;
  startedAt?: number;
};

type CallApi = { startCall: (peer: CallPeer, video: boolean) => void; busy: boolean };

const CallContext = createContext<CallApi>({ startCall: () => undefined, busy: false });
export const useCalls = () => useContext(CallContext);

const REASONS: Record<string, (outgoing: boolean) => string> = {
  declined: () => 'Собеседник отклонил звонок',
  cancelled: () => 'Звонок отменён',
  missed: (outgoing) => (outgoing ? 'Нет ответа' : 'Пропущенный звонок'),
  hangup: () => 'Звонок завершён',
  gone: () => 'Связь прервалась',
};

const errorText = (err: unknown) => {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DOMException && err.name === 'NotAllowedError') return 'Нет доступа к микрофону или камере — разрешите его в браузере';
  if (err instanceof DOMException && err.name === 'NotFoundError') return 'Микрофон или камера не найдены';
  return 'Не удалось позвонить';
};

export function CallProvider({ children }: { children: ReactNode }) {
  const [call, setCall] = useState<CallState | null>(null);
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  const pc = useRef<RTCPeerConnection | null>(null);
  const callId = useRef<string | null>(null);
  const outgoing = useRef(false);
  const offer = useRef<RTCSessionDescriptionInit | null>(null);
  /** Кандидаты собеседника, пришедшие раньше его описания. */
  const remoteIce = useRef<RTCIceCandidateInit[]>([]);
  /** Свои кандидаты, найденные раньше, чем сервер выдал id звонка. */
  const localIce = useRef<RTCIceCandidateInit[]>([]);
  const current = useRef<CallState | null>(null);
  current.current = call;

  const cleanup = useCallback(() => {
    pc.current?.close();
    pc.current = null;
    setLocal((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
    setRemote(null);
    callId.current = null;
    offer.current = null;
    remoteIce.current = [];
    localIce.current = [];
    setMuted(false);
    setCameraOff(false);
  }, []);

  /** Показать итог пару секунд и убрать экран звонка. */
  const finish = useCallback(
    (note: string) => {
      cleanup();
      setCall((c) => (c ? { ...c, phase: 'ended', note } : c));
      window.setTimeout(() => setCall((c) => (c?.phase === 'ended' ? null : c)), 2500);
    },
    [cleanup],
  );

  async function connect(video: boolean) {
    // Сначала сервер: если звонить некуда (витрина, нет сети), камеру и
    // микрофон незачем и спрашивать.
    const { iceServers } = await api.callConfig();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    setLocal(stream);
    const peer = new RTCPeerConnection({ iceServers });
    pc.current = peer;
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.onicecandidate = (e) => {
      if (!e.candidate) return;
      const candidate = e.candidate.toJSON();
      if (callId.current) void api.sendIce(callId.current, candidate).catch(() => undefined);
      else localIce.current.push(candidate);
    };
    peer.ontrack = (e) => setRemote(e.streams[0] ?? new MediaStream([e.track]));
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setCall((c) => (c && c.phase !== 'active' ? { ...c, phase: 'active', startedAt: Date.now() } : c));
      }
      if (peer.connectionState === 'failed') {
        if (callId.current) void api.endCall(callId.current).catch(() => undefined);
        finish('Не удалось соединиться: сеть не пропускает прямое соединение (нужен TURN-сервер)');
      }
    };
    return peer;
  }

  async function flushRemoteIce() {
    const peer = pc.current;
    if (!peer?.remoteDescription) return;
    for (const c of remoteIce.current.splice(0)) await peer.addIceCandidate(c).catch(() => undefined);
  }

  const startCall = useCallback(
    (peer: CallPeer, video: boolean) => {
      if (current.current) return;
      outgoing.current = true;
      setCall({ id: null, peer, video, phase: 'dialing' });
      void (async () => {
        try {
          const conn = await connect(video);
          const desc = await conn.createOffer();
          await conn.setLocalDescription(desc);
          const res = await api.startCall(peer.username, video, { type: 'offer', sdp: desc.sdp ?? '' });
          callId.current = res.call.id;
          setCall((c) => (c ? { ...c, id: res.call.id } : c));
          for (const c of localIce.current.splice(0)) void api.sendIce(res.call.id, c).catch(() => undefined);
        } catch (err) {
          finish(errorText(err));
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finish],
  );

  async function accept() {
    const c = current.current;
    if (!c?.id || !offer.current) return;
    setCall({ ...c, phase: 'connecting' });
    try {
      const conn = await connect(c.video);
      await conn.setRemoteDescription(offer.current);
      await flushRemoteIce();
      const desc = await conn.createAnswer();
      await conn.setLocalDescription(desc);
      await api.answerCall(c.id, { type: 'answer', sdp: desc.sdp ?? '' });
    } catch (err) {
      void api.endCall(c.id).catch(() => undefined);
      finish(errorText(err));
    }
  }

  function hangUp() {
    const id = callId.current ?? current.current?.id;
    if (id) void api.endCall(id).catch(() => undefined);
    finish(current.current?.phase === 'incoming' ? 'Звонок отклонён' : 'Звонок завершён');
  }

  useLive((event) => {
    if (event.t !== 'call') return;
    const e = event as CallEvent;
    const c = current.current;
    if (e.kind === 'ring') {
      if (c) return; // сервер и так не звонит занятому, это на всякий случай
      outgoing.current = false;
      callId.current = e.id;
      offer.current = e.sdp;
      setCall({ id: e.id, peer: e.from, video: e.video, phase: 'incoming' });
      navigator.vibrate?.([300, 200, 300]);
      return;
    }
    if (!c || e.id !== (callId.current ?? c.id)) return;
    if (e.kind === 'answer') {
      setCall({ ...c, phase: 'connecting' });
      void pc.current?.setRemoteDescription(e.sdp).then(flushRemoteIce).catch(() => undefined);
    } else if (e.kind === 'ice') {
      if (pc.current?.remoteDescription) void pc.current.addIceCandidate(e.candidate).catch(() => undefined);
      else remoteIce.current.push(e.candidate);
    } else if (e.kind === 'end') {
      finish(REASONS[e.reason]?.(outgoing.current) ?? 'Звонок завершён');
    }
  });

  // Закрыли вкладку посреди звонка — собеседник узнает от сервера, а здесь
  // отпускаем камеру и микрофон.
  useEffect(() => cleanup, [cleanup]);

  function toggleMute() {
    local?.getAudioTracks().forEach((t) => (t.enabled = muted));
    setMuted(!muted);
  }

  function toggleCamera() {
    local?.getVideoTracks().forEach((t) => (t.enabled = cameraOff));
    setCameraOff(!cameraOff);
  }

  return (
    <CallContext.Provider value={{ startCall, busy: call != null }}>
      {children}
      {call && (
        <CallScreen
          call={call}
          local={local}
          remote={remote}
          muted={muted}
          cameraOff={cameraOff}
          onAccept={() => void accept()}
          onHangUp={hangUp}
          onMute={toggleMute}
          onCamera={toggleCamera}
        />
      )}
    </CallContext.Provider>
  );
}

function useClock(since: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type ScreenProps = {
  call: CallState;
  local: MediaStream | null;
  remote: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  onAccept: () => void;
  onHangUp: () => void;
  onMute: () => void;
  onCamera: () => void;
};

function CallScreen({ call, local, remote, muted, cameraOff, onAccept, onHangUp, onMute, onCamera }: ScreenProps) {
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const clock = useClock(call.phase === 'active' ? call.startedAt : undefined);

  useEffect(() => {
    if (remoteVideo.current) remoteVideo.current.srcObject = remote;
    if (remoteAudio.current) remoteAudio.current.srcObject = remote;
  }, [remote]);
  useEffect(() => {
    if (localVideo.current) localVideo.current.srcObject = local;
  }, [local]);

  const status =
    call.phase === 'dialing' ? 'Звоню…'
      : call.phase === 'incoming' ? (call.video ? 'Входящий видеозвонок' : 'Входящий звонок')
        : call.phase === 'connecting' ? 'Соединение…'
          : call.phase === 'active' ? clock
            : call.note;
  const showVideo = call.video && call.phase !== 'ended' && call.phase !== 'incoming';

  return (
    <section className={showVideo ? 'call video' : 'call'} role="dialog" aria-label={`Звонок: ${call.peer.displayName}`}>
      {showVideo ? (
        <div className="call-stage">
          <video className="call-remote" ref={remoteVideo} autoPlay playsInline />
          <video className="call-local" ref={localVideo} autoPlay playsInline muted />
        </div>
      ) : (
        <>
          <audio ref={remoteAudio} autoPlay />
          <Monogram username={call.peer.username} displayName={call.peer.displayName} avatarUrl={call.peer.avatarUrl} />
        </>
      )}
      <div className="call-info">
        <strong>{call.peer.displayName}</strong>
        <span role="status">{status}</span>
      </div>
      {call.phase !== 'ended' && (
        <div className="call-actions">
          {call.phase === 'incoming' ? (
            <>
              <button className="call-btn accept" type="button" onClick={onAccept} aria-label="Принять">
                <Icon name={call.video ? 'video' : 'phone'} />
              </button>
              <button className="call-btn hangup" type="button" onClick={onHangUp} aria-label="Отклонить">
                <Icon name="phone" />
              </button>
            </>
          ) : (
            <>
              <button className="call-btn" type="button" aria-pressed={muted} onClick={onMute} aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'}>
                <Icon name="mic" />
              </button>
              {call.video && (
                <button className="call-btn" type="button" aria-pressed={cameraOff} onClick={onCamera} aria-label={cameraOff ? 'Включить камеру' : 'Выключить камеру'}>
                  <Icon name="video" />
                </button>
              )}
              <button className="call-btn hangup" type="button" onClick={onHangUp} aria-label="Положить трубку">
                <Icon name="phone" />
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

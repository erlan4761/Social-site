import { randomUUID } from 'node:crypto';
import { emit, hasStream, onStreamsGone } from './live.js';

/**
 * Звонки один на один — голос и видео, как в Телеграме, но без своего медиа-
 * сервера: звук и картинка идут напрямую между браузерами (WebRTC), сервер
 * только сводит их — передаёт «предложение», «ответ» и сетевые кандидаты.
 *
 * Это единственное место, где живой поток несёт данные, а не толчок «перечитай»:
 * описание соединения (SDP) и кандидаты живут секунды, перечитывать их
 * запросом бессмысленно. Состояние звонков — в памяти процесса: звонок не
 * переживает перезапуск сервера, как не переживает его и само соединение.
 *
 * Без TURN-сервера соединение не пройдёт через некоторые сети (симметричный
 * NAT мобильных операторов, строгие корпоративные сети). TURN можно задать
 * переменными TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL — см. README.
 */

/** Сколько звонить, прежде чем звонок станет пропущенным. */
const RING_MS = Number(process.env.CALL_RING_MS) || 45_000;

const calls = new Map();
const userCall = new Map();

export function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const urls = (process.env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length) {
    servers.push({ urls, username: process.env.TURN_USERNAME ?? '', credential: process.env.TURN_CREDENTIAL ?? '' });
  }
  return servers;
}

export const callOf = (userId) => calls.get(userCall.get(userId)) ?? null;
export const callById = (id) => calls.get(id) ?? null;
export const otherSide = (call, userId) => (call.callerId === userId ? call.calleeId : call.callerId);

function finish(call) {
  clearTimeout(call.timer);
  calls.delete(call.id);
  if (userCall.get(call.callerId) === call.id) userCall.delete(call.callerId);
  if (userCall.get(call.calleeId) === call.id) userCall.delete(call.calleeId);
}

/** Завершить звонок и сказать об этом участникам (кроме `except`). */
export function endCall(call, reason, except = null) {
  finish(call);
  const to = [call.callerId, call.calleeId].filter((id) => id !== except);
  emit(to, { t: 'call', kind: 'end', id: call.id, reason });
}

/** Начать звонок: `from` — карточка звонящего для экрана входящего вызова. */
export function startCall({ callerId, calleeId, video, sdp, from }) {
  const call = { id: randomUUID(), callerId, calleeId, video, state: 'ringing', startedAt: Date.now() };
  calls.set(call.id, call);
  userCall.set(callerId, call.id);
  userCall.set(calleeId, call.id);
  call.timer = setTimeout(() => {
    if (calls.get(call.id)?.state === 'ringing') endCall(call, 'missed');
  }, RING_MS);
  call.timer.unref?.();
  emit([calleeId], { t: 'call', kind: 'ring', id: call.id, video, from, sdp });
  return call;
}

export function answerCall(call, sdp) {
  call.state = 'active';
  clearTimeout(call.timer);
  emit([call.callerId], { t: 'call', kind: 'answer', id: call.id, sdp });
}

export function relayIce(call, fromId, candidate) {
  emit([otherSide(call, fromId)], { t: 'call', kind: 'ice', id: call.id, candidate });
}

export const isReachable = (userId) => hasStream(userId);

// Закрылась последняя вкладка участника — звонок без него не продолжится.
onStreamsGone((userId) => {
  const call = callOf(userId);
  if (call) endCall(call, 'gone', userId);
});

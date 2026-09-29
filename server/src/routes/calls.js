import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { isBlockedPair } from '../blocks.js';
import { publicUrl } from '../media.js';
import {
  answerCall, callById, callOf, endCall, iceServers, isReachable, otherSide, relayIce, startCall,
} from '../calls.js';

/**
 * Сигнализация звонков (см. calls.js). Всё — только участникам звонка; чужой
 * и завершённый звонок неотличимы — 404.
 */
export const router = Router();
router.use(requireAuth);

const SDP_MAX = 20_000;
const NOT_FOUND = { error: 'Звонок не найден или уже завершён' };

function readSdp(raw, type) {
  if (!raw || typeof raw !== 'object' || raw.type !== type || typeof raw.sdp !== 'string' || raw.sdp.length > SDP_MAX) return null;
  return { type, sdp: raw.sdp };
}

function readCandidate(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.candidate !== 'string' || raw.candidate.length > 1000) return null;
  const out = { candidate: raw.candidate };
  if (typeof raw.sdpMid === 'string' && raw.sdpMid.length <= 64) out.sdpMid = raw.sdpMid;
  if (Number.isInteger(raw.sdpMLineIndex) && raw.sdpMLineIndex >= 0 && raw.sdpMLineIndex < 16) out.sdpMLineIndex = raw.sdpMLineIndex;
  return out;
}

/** Своя роль в звонке по id из пути, или null. */
function mine(req) {
  const call = callById(String(req.params.id));
  return call && (call.callerId === req.user.id || call.calleeId === req.user.id) ? call : null;
}

router.get('/config', (_req, res) => {
  res.json({ iceServers: iceServers() });
});

router.post('/', (req, res) => {
  const me = req.user.id;
  const target = db.prepare('SELECT id, username, display_name, avatar_path FROM users WHERE username = ?')
    .get(String(req.body?.to ?? '').toLowerCase());
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.id === me) return res.status(400).json({ error: 'Себе не позвонить' });
  // Тот же текст, что у переписки: по нему не понять, кто кого заблокировал.
  if (isBlockedPair(me, target.id)) return res.status(403).json({ error: 'Звонок этому пользователю недоступен' });
  const sdp = readSdp(req.body?.sdp, 'offer');
  if (!sdp) return res.status(400).json({ error: 'Нужно описание соединения (offer)' });
  if (callOf(me)) return res.status(409).json({ error: 'Вы уже в звонке' });
  if (callOf(target.id)) return res.status(409).json({ error: 'Занято: собеседник сейчас в другом звонке' });
  // Звонок доходит только до открытой вкладки: будить телефон пушем ради
  // звонка, который он не сможет принять без открытого сайта, — обман.
  if (!isReachable(target.id)) return res.status(409).json({ error: 'Собеседник не в сети — звонок не дойдёт' });

  const u = db.prepare('SELECT username, display_name, avatar_path FROM users WHERE id = ?').get(me);
  const call = startCall({
    callerId: me,
    calleeId: target.id,
    video: req.body?.video === true,
    sdp,
    from: { id: me, username: u.username, displayName: u.display_name, avatarUrl: publicUrl('avatar', u.avatar_path) },
  });
  res.status(201).json({ call: { id: call.id, video: call.video } });
});

router.post('/:id/answer', (req, res) => {
  const call = mine(req);
  if (!call) return res.status(404).json(NOT_FOUND);
  if (call.calleeId !== req.user.id || call.state !== 'ringing') return res.status(409).json({ error: 'Этот звонок уже не ждёт ответа' });
  const sdp = readSdp(req.body?.sdp, 'answer');
  if (!sdp) return res.status(400).json({ error: 'Нужно описание соединения (answer)' });
  answerCall(call, sdp);
  res.json({ ok: true });
});

router.post('/:id/ice', (req, res) => {
  const call = mine(req);
  if (!call) return res.status(404).json(NOT_FOUND);
  const candidate = readCandidate(req.body?.candidate);
  if (!candidate) return res.status(400).json({ error: 'Некорректный сетевой кандидат' });
  relayIce(call, req.user.id, candidate);
  res.json({ ok: true });
});

/**
 * Положить трубку. Причину видит собеседник: отменил звонящий, отклонил
 * вызываемый — или обычное «завершён».
 */
router.post('/:id/end', (req, res) => {
  const call = mine(req);
  if (!call) return res.status(404).json(NOT_FOUND);
  const me = req.user.id;
  const reason = call.state === 'ringing' ? (me === call.callerId ? 'cancelled' : 'declined') : 'hangup';
  endCall(call, reason, me);
  res.json({ ok: true, reason, with: otherSide(call, me) });
});

/**
 * Small in-memory fixed-window limiter. Enough to blunt password guessing on a
 * single-process deployment; swap for a shared store if this ever runs on more
 * than one instance.
 */
export function rateLimit({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
    }
    next();
  };
}

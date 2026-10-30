import { randomUUID } from 'node:crypto';
export const NAV_WAIT = '/api/island-navigation/wait';
export const NAV_ACK = '/api/island-navigation/ack';
export function validSessionId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value); }
/** Event-driven long wait on DSH's authenticated owner-only Fetch carrier. */
export function createNavigation({ now = Date.now, waitMs = 20_000, ttlMs = 15_000, onResult = () => {}, onConnected = () => {} } = {}) {
  let pending = null, closed = false, clientSeen = false;
  const waiters = new Set();
  function current() {
    if (pending && now() - pending.createdAt >= ttlMs) {
      const expired = pending; pending = null;
      onResult({ ...expired, ok: false, reason: 'client-unavailable' });
    }
    return pending;
  }
  function publish(sessionId) {
    if (closed || !validSessionId(sessionId)) return false;
    pending = { id: randomUUID(), sessionId, createdAt: now() };
    for (const resolve of [...waiters]) resolve(pending);
    return true;
  }
  function wait(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    if (closed) return Promise.resolve(null);
    const ready = current();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      let timer;
      const clean = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener('abort', abort); };
      const done = value => { clean(); resolve(value); };
      const abort = () => { clean(); reject(signal.reason ?? new Error('aborted')); };
      waiters.add(done); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => done(null), waitMs); timer.unref?.();
    });
  }
  function acknowledge(result) {
    const value = current();
    if (!value || result?.id !== value.id || result?.sessionId !== value.sessionId || typeof result.ok !== 'boolean') return false;
    pending = null;
    onResult({ ...value, ok: result.ok, reason: typeof result.reason === 'string' ? result.reason.slice(0,200) : undefined });
    return true;
  }
  function stop() { closed = true; pending = null; for (const resolve of [...waiters]) resolve(null); }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type':'application/json', 'cache-control':'no-store' } });
  const routes = [
    { path: NAV_WAIT, methods: ['GET'], requestBody: 'buffered', fetch: async request => {
      try { if (!clientSeen) { clientSeen = true; onConnected(); } return json({ open: await wait(request.signal) }); }
      catch { return new Response(null, { status: 204 }); }
    } },
    { path: NAV_ACK, methods: ['POST'], requestBody: 'buffered', fetch: async request => {
      try {
        const text = await request.text();
        if (text.length > 2048) return json({ accepted:false },413);
        return json({ accepted: acknowledge(JSON.parse(text)) });
      } catch { return json({ accepted:false },400); }
    } },
  ];
  return { publish, wait, acknowledge, stop, routes };
}

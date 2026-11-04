import { randomUUID } from 'node:crypto';

// A prepare/commit exchange binds an island click to one actual Client object.
// Re-check the Host request before committing, and the Client object before
// answering, so a delayed click cannot approve a replacement request.
export function createApprovalRelay({ isPending, canBind = () => true, now = Date.now, ttlMs = 15_000, waitMs = 20_000 } = {}) {
  const commands = new Map(), waiters = new Set();
  let closed = false;
  const wake = () => { for (const done of [...waiters]) done(); };
  function current() {
    for (const [id, c] of commands) if (now() - c.createdAt >= ttlMs || !isPending(c.requestId)) commands.delete(id);
    return commands.values().next().value ?? null;
  }
  function publish(request, outcome) {
    current();
    if (closed || !isPending(request.requestId) || !['allowed-once', 'rejected'].includes(outcome)) return false;
    if ([...commands.values()].some(c => c.requestId === request.requestId)) return false;
    const id = randomUUID();
    commands.set(id, { id, phase: 'prepare', requestId: request.requestId, sessionId: request.sessionId,
      toolName: request.toolName, callId: request.callId, reason: request.reason,
      outcome, createdAt: now(), expiresAt: now() + ttlMs });
    wake(); return true;
  }
  async function wait(signal) {
    if (closed || signal.aborted) return null;
    if (current()) return current();
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); waiters.delete(done); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, waitMs); timer.unref?.();
      waiters.add(done); signal.addEventListener('abort', done, { once: true });
    });
    return current();
  }
  function acknowledge(result) {
    current();
    const c = commands.get(result.id);
    if (!c || result.phase !== c.phase) return false;
    if (result.ok !== true) { commands.delete(c.id); wake(); return true; }
    if (c.phase === 'prepare') {
      if (!canBind(c)) { commands.delete(c.id); wake(); return false; }
      if (typeof result.key !== 'string' || !result.key || result.key.length > 200) return false;
      c.key = result.key; c.phase = 'commit'; wake(); return true;
    }
    commands.delete(c.id); wake(); return true;
  }
  function cancel(requestId) { for (const [id, c] of commands) if (c.requestId === requestId) commands.delete(id); wake(); }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const routes = [
    { path: '/api/island-approval/wait', methods: ['GET'], requestBody: 'buffered', fetch: async req => json({ command: await wait(req.signal) }) },
    { path: '/api/island-approval/ack', methods: ['POST'], requestBody: 'buffered', fetch: async req => {
      try { const body = await req.text(); if (body.length > 2048) return json({}, 413); return json({ accepted: acknowledge(JSON.parse(body)) }); }
      catch { return json({}, 400); }
    } }
  ];
  return { publish, acknowledge, current, cancel, routes, stop() { closed = true; commands.clear(); wake(); } };
}

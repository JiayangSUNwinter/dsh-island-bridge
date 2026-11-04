import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApprovalRelay } from '../lib/approval-relay.js';

const request = { requestId: 'r1', sessionId: 's1', toolName: 'bash', callId: 'c1', reason: '读取配置' };
test('准备阶段不裁决，只有原请求仍存在时才提交，重复点击和错误阶段被拒绝', () => {
  const relay = createApprovalRelay({ isPending: () => true });
  assert.equal(relay.publish(request, 'allowed-once'), true);
  const command = relay.current();
  assert.equal(command.phase, 'prepare');
  assert.equal(relay.publish(request, 'rejected'), false);
  assert.equal(relay.acknowledge({ id: command.id, phase: 'commit', ok: true }), false);
  assert.equal(relay.acknowledge({ id: command.id, phase: 'prepare', ok: true, key: 'approval:1' }), true);
  assert.equal(relay.current().phase, 'commit');
  assert.equal(relay.current().key, 'approval:1');
  assert.equal(relay.acknowledge({ id: command.id, phase: 'commit', ok: true }), true);
  assert.equal(relay.current(), null); relay.stop();
  const ambiguous = createApprovalRelay({ isPending: () => true, canBind: () => false });
  ambiguous.publish(request, 'allowed-once');
  assert.equal(ambiguous.acknowledge({ id: ambiguous.current().id, phase: 'prepare', ok: true, key: 'approval:1' }), false);
  assert.equal(ambiguous.current(), null); ambiguous.stop();
});
test('本地已答、请求取消和断线过期均使旧点击失效，不会应用到后续审批', () => {
  let active = true, now = 0;
  const relay = createApprovalRelay({ isPending: () => active, now: () => now });
  relay.publish(request, 'allowed-once'); const old = relay.current(); active = false;
  assert.equal(relay.acknowledge({ id: old.id, phase: 'prepare', ok: true, key: 'approval:1' }), false);
  active = true; relay.publish(request, 'rejected'); now = 15_001;
  assert.equal(relay.current(), null);
  relay.publish(request, 'allowed-once'); relay.cancel(request.requestId); assert.equal(relay.current(), null);
  relay.stop(); assert.equal(relay.publish(request, 'allowed-once'), false);
});
test('审批relay仅接受原生发布的合法动词，路由限制输入并在停用时释放等待', async () => {
  const relay = createApprovalRelay({ isPending: () => true });
  assert.equal(relay.publish(request, 'allowed-always'), false);
  const [wait, ack] = relay.routes;
  assert.equal((await ack.fetch(new Request('http://localhost', { method: 'POST', body: 'x'.repeat(2049) }))).status, 413);
  assert.equal((await ack.fetch(new Request('http://localhost', { method: 'POST', body: 'invalid' }))).status, 400);
  const waiting = wait.fetch(new Request('http://localhost')); relay.stop();
  assert.equal((await (await waiting).json()).command, null);
});
test('提交前对象替换或命令在传输中过期均不批准，即使callId等字段完全相同', async t => {
 for (const stale of ['replaced', 'expired']) {
  const relay = createApprovalRelay({ isPending: () => true });
  const routes = new Map(relay.routes.map(r => [r.path, r]));
  let registration, calls = 0, commitSeen = false;
  const stops = [];
  const pending = key => ({ kind: 'approval', key, toolName: request.toolName, callId: request.callId,
    reason: request.reason, answerable: true, answer: async () => { calls++; } });
  let current = pending('approval:1');
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { location: { protocol: 'dsh-app:' }, __ModuleLoader__: { load: r => registration = r } },
    AbortController, Promise, Map, setTimeout, clearTimeout, console,
    fetch: async (url, options = {}) => {
      if (url.startsWith('/api/island-navigation')) return new Promise(resolve => options.signal.addEventListener('abort', () => resolve(new Response('{}')), { once: true }));
      const response = await routes.get(url).fetch(new Request('http://localhost' + url, options));
      if (url.endsWith('/wait')) {
        const body = await response.clone().json();
        if (body.command?.phase === 'commit') {
          commitSeen = true;
          if (stale === 'replaced') current = pending('approval:2');
          else { body.command.expiresAt = Date.now() - 1; return new Response(JSON.stringify(body)); }
        }
      }
      return response;
    }
  });
  registration.factory().apply({
    get: key => key === 'uiSession' ? { sessionStatus: { getSnapshot: () => new Map([['s1', { pendingInteraction: current }]]) } } : {},
    effect: fn => { stops.push(fn()); }
  });
  t.after(() => { stops.forEach(stop => stop?.()); relay.stop(); });
  relay.publish(request, 'allowed-once');
  for (let i = 0; i < 200 && (!commitSeen || relay.current()); i++) await delay(5);
  assert.equal(commitSeen, true); assert.equal(relay.current(), null); assert.equal(calls, 0);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRegistry } from '../lib/registry.js';

const root = new URL('..', import.meta.url);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error('interaction state timeout');
}

// Run the real bridge/registry with a recording stdio helper; no desktop UI.
async function runtime(t) {
  const temp = await mkdtemp(path.join(tmpdir(), 'dsh-island-interaction-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const state = path.join(temp, 'dsh-island-bridge');
  await mkdir(state);
  const capture = path.join(temp, 'frames.jsonl');
  const source = await readFile(new URL('helper/island-helper.swift', root));
  await writeFile(path.join(state, 'island-helper.sha256'), createHash('sha256').update(source).digest('hex').slice(0, 32) + '\n');
  const binary = path.join(state, 'island-helper');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write('{"type":"ready"}\\n');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const i = buffer.indexOf('\\n');
    const frame = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(frame) + '\\n');
    if (frame.type === 'shutdown') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  await chmod(binary, 0o755);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = temp;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  const mod = await import(new URL('lib/index.js?interaction=' + path.basename(temp), root));
  const session = { header: { id: 'session-question', cwd: '/tmp' }, seq: 1 };
  const agent = { id: session.header.id, status: 'running', session };
  const listeners = new Map(), cleanup = [];
  const services = {
    agents: { list: () => [agent], get: () => agent },
    sessions: { get: () => session },
    sessionProjections: { snapshot: () => ({ values: { sessionListMetadata: { blank: false } } }) },
    sessionQuery: { readTitleSnapshots: async () => [] }
  };
  const ctx = {
    inject: (deps, fn) => fn({ connection: { fetch: { register: () => () => {} } } }),
    get: key => services[key],
    on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); },
    effect: fn => { const stop = fn(); cleanup.push(stop); return stop; }
  };
  t.after(() => cleanup.reverse().forEach(stop => stop?.()));
  await mod.apply(ctx);
  const frames = async () => {
    try { return (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch { return []; }
  };
  const row = async () => (await frames()).filter(frame => frame.type === 'update').at(-1)?.sessions.find(item => item.id === agent.id);
  await waitFor(async () => Boolean(await row()));
  return {
    agent, frames, row,
    question: (request, next) => listeners.get('user-questions/request')({ agent, ...request }, next),
    approval: (request, next) => listeners.get('approval/request')({ agent, ...request }, next),
    refresh: () => listeners.get('session/event')()
  };
}

test('在DSH回答后移除提问卡，运行期间刷新不复活，后续新问题正常出现', async t => {
  const host = await runtime(t);
  const local = deferred();
  const result = host.question({ questions: [{ id: 'q1', question: '仓库可见性' }] }, () => local.promise);
  await waitFor(async () => (await host.row())?.pending?.kind === 'ask_user_question');
  const requestId = (await host.row()).pending.requestId;
  const answer = { answers: [{ id: 'q1', selected: ['Public'] }] };
  local.resolve(answer);
  assert.strictEqual(await result, answer);
  await waitFor(async () => (await host.row())?.pending === null);
  for (let i = 0; i < 3; i++) { host.refresh(); await delay(175); }
  assert.equal((await host.row()).pending, null);
  assert.equal(host.agent.status, 'running');
  const nextLocal = deferred();
  const nextResult = host.question({ questions: [{ id: 'q2', question: '另一个问题' }] }, () => nextLocal.promise);
  await waitFor(async () => Boolean((await host.row())?.pending));
  assert.notEqual((await host.row()).pending.requestId, requestId);
  assert.equal((await host.row()).pending.questions[0].id, 'q2');
  nextLocal.resolve({ answers: [{ id: 'q2', selected: ['确认'] }] });
  await nextResult;
  await waitFor(async () => (await host.row())?.pending === null);
});

test('DSH提问超时或失败立即移除镜像，原错误保留，下游只调用一次', async t => {
  const host = await runtime(t);
  const local = deferred();
  let calls = 0;
  const result = host.question({ questions: [{ id: 'q1', question: '选择方案' }] }, () => { calls++; return local.promise; });
  const error = Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' });
  const rejected = assert.rejects(result, actual => actual === error);
  await waitFor(async () => Boolean((await host.row())?.pending));
  local.reject(error);
  await rejected;
  await waitFor(async () => (await host.row())?.pending === null);
  assert.equal(calls, 1);
});

test('取消DSH提问不伪造空答案，保留原信号和错误并移除镜像', async t => {
  const host = await runtime(t);
  const controller = new AbortController();
  const error = Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' });
  const result = host.question({ signal: controller.signal, questions: [{ id: 'q1', question: '等待输入' }] }, () =>
    new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(error), { once: true }))
  );
  const rejected = assert.rejects(result, actual => actual === error);
  await waitFor(async () => Boolean((await host.row())?.pending));
  controller.abort();
  await rejected;
  await waitFor(async () => (await host.row())?.pending === null);
});

test('本地审批返回cancelled或unavailable也移除镜像，不要求是岛上裁决动词', async t => {
  const host = await runtime(t);
  for (const outcome of ['cancelled', 'unavailable']) {
    const local = deferred();
    const result = host.approval({ toolName: 'bash', reason: '读取配置' }, () => local.promise);
    await waitFor(async () => Boolean((await host.row())?.pending));
    local.resolve(outcome);
    assert.equal(await result, outcome);
    await waitFor(async () => (await host.row())?.pending === null);
  }
});

test('已经取消的请求不在注册表残留', async () => {
  let dismissed = 0;
  const registry = createRegistry({ onDismissed: () => dismissed++ });
  const signal = AbortSignal.abort();
  const question = registry.askUser({ sessionId: 's', questions: [{ id: 'q' }], signal });
  const permission = registry.ask({ sessionId: 's', signal });
  assert.equal(registry.size(), 0);
  assert.equal(dismissed, 2);
  assert.deepEqual(await question.answered, { answers: [{ id: 'q', selected: [] }] });
  assert.equal(await permission.answered, 'cancelled');
});

test('镜像清理独立于答案类型且幂等，权限裁决不能回答提问', async () => {
  const registry = createRegistry();
  const question = registry.askUser({ sessionId: 's', questions: [{ id: 'q' }] });
  assert.deepEqual(registry.settleOutcome(question.requestId, 'allowed-once'), { accepted: false });
  assert.equal(registry.size(), 1);
  assert.deepEqual(registry.dismiss(question.requestId), { accepted: true });
  assert.deepEqual(registry.dismiss(question.requestId), { accepted: false });
  assert.equal(registry.size(), 0);
  await question.answered;
});

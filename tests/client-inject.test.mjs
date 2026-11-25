import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

function moduleObject() {
  let registration;
  vm.runInNewContext(source, {
    window: { location: { protocol: 'dsh-app:' }, __ModuleLoader__: { load: row => { registration = row; } } },
    AbortController, Promise, Map, Set, setTimeout, clearTimeout, console,
    fetch: async () => new Response('{}'),
  });
  assert.ok(registration, 'client.js must register through window.__ModuleLoader__');
  return registration.factory();
}

test('Cordis inject 覆盖客户端真正读取的服务名', () => {
  const module = moduleObject();
  assert.ok(Array.isArray(module.inject), 'plugin must declare inject');
  const declared = new Set(module.inject);

  // ctx.get('name') 绕过 Cordis 的注入检查，仍要求声明，避免“读了没声明”的同类缺陷。
  for (const [, name] of source.matchAll(/ctx\.get\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assert.ok(declared.has(name), `ctx.get('${name}') is read but not declared in inject`);
  }

  // 拆分出来的子服务是独立服务名（DSH ≥ 0.2.2-rc.2 起 uiSession.sessionStatus），
  // 未声明就读取会抛 cannot get property "…" without inject，插件无法同步。
  for (const [path] of source.matchAll(/\buiSession\.(sessionStatus|pendingInteractions)\b/g)) {
    assert.ok(declared.has(path), `injected service path '${path}' is read but not declared in inject`);
  }

  assert.ok(declared.has('uiSession.sessionStatus'), 'session status service must be injected to mirror pending approvals');
});

test('注入声明包含工作区与会话两个服务，且每个声明项都是非空字符串', () => {
  const module = moduleObject();
  const declared = new Set(module.inject);
  for (const required of ['uiWorkspace', 'uiSession', 'uiSession.sessionStatus']) {
    assert.ok(declared.has(required), `inject must contain '${required}'`);
  }
  for (const name of module.inject) {
    assert.equal(typeof name, 'string');
    assert.ok(name.trim().length > 0);
  }
});

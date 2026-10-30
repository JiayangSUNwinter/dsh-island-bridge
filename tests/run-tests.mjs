import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(root + '/build', { recursive: true });
execFileSync('swiftc', ['-O', '-module-cache-path', root + '/build/cache', '-o', root + '/build/island-helper', root + '/helper/island-helper.swift'], { timeout: 120_000 });
const source = await readFile(root + '/helper/island-helper.swift', 'utf8');
const core = source.split('\nstruct NotchShape: Shape {')[0];
await writeFile(root + '/build/core-regressions.swift', core + '\n' + await readFile(root + '/tests/core-regressions.swift', 'utf8'));
execFileSync('swiftc', ['-module-cache-path', root + '/build/cache', '-o', root + '/build/core-regressions', root + '/build/core-regressions.swift'], { timeout: 120_000 });
console.log(execFileSync(root + '/build/core-regressions', { encoding: 'utf8' }).trim());
async function start(t, args = []) {
  const child = spawn(root + '/build/island-helper', ['--test-protocol', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const timer = setTimeout(() => child.kill(), 12_000);
  child.once('exit', () => clearTimeout(timer));
  let buffer = '';
  const queue = [];
  const pending = [];
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line);
        const index = pending.findIndex(wait => wait.type === value.type);
        if (index < 0) queue.push(value);
        else pending.splice(index, 1)[0].resolve(value);
      } catch {}
    }
  });
  child.next = type => {
    const index = queue.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise(resolve => pending.push({ type, resolve }));
  };
  child.send = data => child.stdin.write(JSON.stringify(data) + '\n');
  await child.next('ready');
  return child;
}
test('关闭宿主输入管道后 helper 退出，不残留窗口', { timeout: 15_000 }, async t => {
  const child = await start(t);
  const exit = once(child, 'exit'); child.stdin.end();
  assert.deepEqual(await exit, [0, null]);
});
test('shutdown 帧支持分块传输并正常退出', { timeout: 15_000 }, async t => {
  const child = await start(t);
  const exit = once(child, 'exit');
  child.stdin.write('{"type":"shut'); child.stdin.write('down"}\n');
  assert.deepEqual(await exit, [0, null]);
});
test('无效 JSON 不会破坏后续更新和退出', { timeout: 15_000 }, async t => {
  const child = await start(t);
  const exit = once(child, 'exit');
  child.stdin.write('bad-json\n{"type":"update","sessions":[],"completed":[]}\n{"type":"shutdown"}\n');
  assert.deepEqual(await exit, [0, null]);
});
test('审批独占、长正文完整、队列稳定、处理后恢复任务，实际窗口均不超178pt', { timeout: 15_000 }, async t => {
  const child = await start(t, ['--test-protocol']);
  const inspect = async () => { child.send({ type: 'inspect' }); return child.next('inspection'); };
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: 'task-' + i, title: '运行任务' + i, running: true }));
  const long = '审批完整正文\n'.repeat(600) + '全文末尾验证标记';
  const approval = (id, text) => ({ id, title: '审批来源' + id, running: true, pending: { requestId: id, kind: 'permission', reason: text } });
  const a = approval('approval-a', long), b = approval('approval-b', '第二条审批');
  child.send({ type: 'update', sessions: [...tasks, a, b], completed: [{ id: 'done', title: '完成的其他任务' }] });
  let state = await inspect();
  assert.equal(state.height, 178); assert.equal(state.width, 392);
  assert.equal(state.panelVisible, false); assert.equal(state.mouseMonitorCount, 0);
  assert.deepEqual(state.visibleTaskIds, []); assert.deepEqual(state.visibleCompletionIds, []);
  assert.equal(state.runningCount, 0); assert.equal(state.body, long);
  child.send({ type: 'test-next-approval' });
  state = await inspect(); assert.equal(state.selectedRequestId, 'approval-b');
  child.send({ type: 'update', sessions: [approval('new', '新到审批'), ...tasks, a, b], completed: [] });
  state = await inspect(); assert.equal(state.selectedRequestId, 'approval-b');
  child.send({ type: 'update', sessions: tasks, completed: [] });
  state = await inspect(); assert.equal(state.mode, 'compact'); assert.equal(state.visibleTaskIds.length, 12);
  assert.equal(state.intentVisible, true);
  child.send({ type: 'toggle' });
  state = await inspect(); assert.equal(state.height, 178); assert.equal(state.runningCount, 12);
  const exit = once(child, 'exit'); child.send({ type: 'shutdown' }); assert.deepEqual(await exit, [0, null]);
});


test('完成窄提示复用原窗口、连续完成不叠加、自动收回并动态收紧', { timeout: 15_000 }, async t => {
  const child = await start(t, ['--test-protocol']);
  const inspect = async () => { child.send({ type: 'inspect' }); return child.next('inspection'); };
  const tasks = [{id:'running',title:'仍在运行',running:true}];
  child.send({type:'update',sessions:tasks,completed:[]});
  let state = await inspect();
  assert.equal(state.intentVisible, true);
  const window = state.windowNumber;
  child.send({type:'update',sessions:tasks,completed:[{id:'done-a',title:'资料整理'}]});
  state = await inspect();
  assert.equal(state.completionToast,'资料整理 已完成');
  assert.equal(state.height,62); assert.equal(state.panelCount,1); assert.equal(state.windowNumber,window);
  assert.equal(state.panelVisible,false); assert.equal(state.mouseMonitorCount,0);
  child.send({type:'update',sessions:tasks,completed:[{id:'done-b',title:'配置检查'}]});
  state = await inspect();
  assert.equal(state.completionToast,'配置检查 已完成');
  assert.equal(state.panelCount,1); assert.equal(state.windowNumber,window);
  await new Promise(resolve=>setTimeout(resolve,3200));
  state = await inspect(); assert.equal(state.completionToast,''); assert.equal(state.height,32);
  child.send({type:'toggle'}); state = await inspect(); assert.equal(state.height,96);
  child.send({type:'update',sessions:[...tasks,{id:'second',title:'另一个任务',running:true}],completed:[]});
  state = await inspect(); assert.equal(state.height,124);
  assert.equal(state.panelVisible,false);
  child.send({type:'update',sessions:[...tasks,{id:'urgent',title:'审批来源',running:true,pending:{requestId:'urgent',kind:'permission',reason:'审批优先'}}],completed:[{id:'other',title:'不应覆盖审批'}]});
  state = await inspect(); assert.equal(state.completionToast,''); assert.deepEqual(state.visibleTaskIds,[]);
  assert.equal(state.windowNumber,window); assert.equal(state.panelCount,1);
  const exit=once(child,'exit');child.send({type:'shutdown'});assert.deepEqual(await exit,[0,null]);
});

test('意图可见性：空状态不显示，有任务时判定为应显示，清空后回落', { timeout: 15_000 }, async t => {
  const child = await start(t, ['--test-protocol']);
  const inspect = async () => { child.send({ type: 'inspect' }); return child.next('inspection'); };
  child.send({ type: 'update', sessions: [], completed: [] });
  let state = await inspect();
  assert.equal(state.intentVisible, false); assert.equal(state.panelVisible, false);
  child.send({ type: 'update', sessions: [{ id: 'vis', title: '应显示的任务', running: true }], completed: [] });
  state = await inspect();
  assert.equal(state.intentVisible, true); assert.equal(state.panelVisible, false);
  child.send({ type: 'update', sessions: [], completed: [] });
  state = await inspect();
  assert.equal(state.intentVisible, false);
  const exit = once(child, 'exit'); child.send({ type: 'shutdown' }); assert.deepEqual(await exit, [0, null]);
});

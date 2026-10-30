import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHelperHost } from '../lib/helper-host.js';
function fixture() {
 let sequence=0, timerId=0;
 const children=[], timers=new Map();
 const make=()=>{
  const child=new EventEmitter();child.pid=++sequence;child.kills=0;child.writes=[];
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdout.setEncoding=child.stderr.setEncoding=()=>{};
  child.stdin.write=(value,done)=>{child.writes.push(value);done?.();return true;};
  child.stdin.end=()=>{};child.kill=()=>{child.kills++;return true;};children.push(child);return child;
 };
 const host=createHelperHost({spawnChild:make,setTimer:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});
 const run=ms=>{const pair=[...timers].find(([,t])=>t.ms===ms);assert.ok(pair,'timer '+ms);timers.delete(pair[0]);pair[1].fn();};
 return {host,children,timers,run};
}
test('重复启动和完成帧始终只使用当前一个进程',()=>{
 const {host,children}=fixture();host.start();host.start();host.start();
 host.send(JSON.stringify({type:'update',sessions:[],completed:[{id:'done'}]}));
 assert.equal(children.length,1);assert.equal(children[0].writes.length,1);host.stop();
});
test('多次管道错误合并为一次重启，旧进程退出后才创建替代者',()=>{
 const {host,children,timers,run}=fixture();const first=host.start();
 first.stdin.emit('error',new Error('EPIPE'));first.stdin.emit('error',new Error('EPIPE'));host.start();
 assert.equal(first.kills,1);assert.equal(children.length,1);assert.equal(timers.size,0);
 first.emit('exit',1);first.emit('exit',1);run(1000);
 assert.equal(children.length,2);const second=host.child;
 first.emit('exit',1);first.stdout.emit('data','{"type":"ready"}\n');
 assert.equal(host.child,second);assert.equal(timers.size,0);host.stop();
});
test('连续崩溃最多重启三次，ready 不立刻清空预算',()=>{
 const {host,children,timers,run}=fixture();host.start();
 for(const delay of [1000,2000,4000]) {
  host.child.stdout.emit('data','{"type":"ready"}\n');host.child.emit('exit',1);run(delay);
 }
 host.child.stdout.emit('data','{"type":"ready"}\n');host.child.emit('exit',1);
 assert.equal(children.length,4);assert.equal(timers.size,0);host.stop();
});
test('持续健康30秒后才重置重启预算，停用取消延迟重启',()=>{
 const {host,children,timers,run}=fixture();host.start();host.child.emit('exit',1);run(1000);
 host.child.stdout.emit('data','{"type":"ready"}\n');run(30000);
 host.child.emit('exit',1);assert.ok([...timers.values()].some(x=>x.ms===1000));
 host.stop();assert.equal(timers.size,0);assert.equal(children.length,2);
});

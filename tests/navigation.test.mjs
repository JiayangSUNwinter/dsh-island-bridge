import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createNavigation, validSessionId, NAV_WAIT, NAV_ACK } from '../lib/navigation.js';
async function until(check) { for(let i=0;i<200;i++){if(check())return;await delay(5);}throw new Error('navigation timeout'); }
test('合法会话ID；点击在界面连接之前发生也可送达',async()=>{
 const nav=createNavigation();assert.equal(nav.publish(''),false);assert.equal(nav.publish('session-a\nmalformed'),false);
 assert.equal(validSessionId('session-a'),true);assert.equal(nav.publish('session-a'),true);
 const cmd=await nav.wait();assert.equal(cmd.sessionId,'session-a');
 assert.equal(nav.acknowledge({...cmd,sessionId:'other',ok:true}),false);
 assert.equal(nav.acknowledge({...cmd,ok:true}),true);nav.stop();
});
test('最新点击覆盖旧点击；旧确认不得清除新目标',async()=>{
 const nav=createNavigation();const wait=nav.wait();nav.publish('session-a');const a=await wait;
 nav.publish('session-b');assert.equal(nav.acknowledge({...a,ok:true}),false);
 assert.equal((await nav.wait()).sessionId,'session-b');nav.stop();
});
test('请求取消及插件退出释放等待，过期目标不会在稍后误跳',async()=>{
 let now=0;const results=[];const nav=createNavigation({now:()=>now,onResult:r=>results.push(r)});
 const signal=new AbortController();const waiting=nav.wait(signal.signal);signal.abort();await assert.rejects(waiting);
 nav.publish('session-a');now=16000;const pending=nav.wait();assert.equal(results[0].reason,'client-unavailable');nav.stop();assert.equal(await pending,null);
});
test('Fetch路由输入边界和成功确认',async()=>{
 const nav=createNavigation();const routes=new Map(nav.routes.map(r=>[r.path,r]));nav.publish('session-a');
 const data=await(await routes.get(NAV_WAIT).fetch(new Request('http://localhost'+NAV_WAIT))).json();
 const ack=await routes.get(NAV_ACK).fetch(new Request('http://localhost'+NAV_ACK,{method:'POST',body:JSON.stringify({...data.open,ok:true})}));
 assert.deepEqual(await ack.json(),{accepted:true});
 assert.equal((await routes.get(NAV_ACK).fetch(new Request('http://localhost'+NAV_ACK,{method:'POST',body:'not-json'}))).status,400);
 assert.equal((await routes.get(NAV_ACK).fetch(new Request('http://localhost'+NAV_ACK,{method:'POST',body:'x'.repeat(2050)}))).status,413);nav.stop();
});
const code=await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
async function clientFixture({protocol='dsh-app:',fail=false}={}) {
 const results=[], opened=[];let selected,stop,registration;
 const nav=createNavigation({onResult:x=>results.push(x)});
 const routes=new Map(nav.routes.map(r=>[r.path,r]));
 vm.runInNewContext(code,{
  window:{location:{protocol},__ModuleLoader__:{load:r=>registration=r}},
  AbortController,Promise,setTimeout,clearTimeout,console:{warn:()=>{}},
  fetch:async(url,options={})=>routes.get(url).fetch(new Request('http://localhost'+url,options)),
 });
 const workspace={selection:{getSnapshot:()=>({sessionId:selected})},openSession:id=>{if(fail)throw new Error('missing conversation');opened.push(id);selected=id;}};
 registration.factory().apply({get:key=>key==='uiWorkspace'?workspace:null,effect:fn=>{stop=fn();}});
 return {nav,results,opened,stop:()=>{stop?.();nav.stop();}};
}
test('真实客户端模块经路由打开精确目标并回传确认，不只唤醒窗口',async()=>{
 const f=await clientFixture();f.nav.publish('session-target');await until(()=>f.results.length===1);
 assert.deepEqual(f.opened,['session-target']);assert.equal(f.results[0].ok,true);f.stop();
});
test('打开失败回传失败；普通网页不消费桌面跳转',async()=>{
 const f=await clientFixture({fail:true});f.nav.publish('session-missing');await until(()=>f.results.length===1);
 assert.equal(f.results[0].ok,false);assert.match(f.results[0].reason,/missing conversation/);f.stop();
 const browser=await clientFixture({protocol:'http:'});browser.nav.publish('session-target');await delay(10);assert.equal(browser.opened.length,0);browser.stop();
});

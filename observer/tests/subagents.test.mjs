import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {SubagentObserver} from '../subagents.ts';
function busWith(responder) {
  const listeners=new Map(), requests=[];
  const bus={on(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);return()=>{set.delete(fn);if(!set.size)listeners.delete(name);};},
    emit(name,value){if(name==='subagents:rpc:v1:request'){requests.push(value);responder?.(value,bus);}for(const fn of [...(listeners.get(name)||[])])fn(value);}};
  return {bus,listeners,requests};
}
function reply(bus,request,data){bus.emit(`subagents:rpc:v1:reply:${request.requestId}`,{version:1,requestId:request.requestId,success:true,data});}
const ping={capabilities:{fleetStatus:{version:1}}};
const status=entries=>({fleet:{version:1,entries,totalActive:entries.length,omitted:0}});
test('documented v1 ping/status subscriptions only; private content never inspected',async()=>{
  let entries=[{key:'opaque-a',agent:'Builder',state:'running',model:'model-b',currentTool:'read',get goal(){throw new Error('No task access');},get task(){throw new Error('No task access');},get result(){throw new Error('No result access');}}];
  const harness=busWith((request,bus)=>reply(bus,request,request.method==='ping'?ping:status(entries)));
  const changes=[];const observer=new SubagentObserver(harness.bus,(...args)=>changes.push(args));
  assert.deepEqual([...harness.listeners.keys()],['subagents:rpc:v1:ready','subagent:async-started','subagent:async-complete','subagent:child-status']);
  await observer.refresh();assert.deepEqual(harness.requests.map(x=>x.method),['ping','status']);
  const first=changes.at(-1)[0][0];assert.equal(first.name,'Builder');assert.equal(first.state,'working');assert.equal(first.lifecycle.kind,'start');assert.ok(!('task' in first));
  await observer.refresh();assert.equal(changes.at(-1)[0][0].lifecycle.eventId,first.lifecycle.eventId);
  entries=[{key:'opaque-a',agent:'Builder',state:'completed'}];await observer.refresh();assert.equal(changes.at(-1)[0][0].lifecycle.kind,'stop');
  const marker=changes.at(-1)[0][0].lifecycle.eventId;await observer.refresh();assert.equal(changes.at(-1)[0][0].lifecycle.eventId,marker);
  entries=[];await observer.refresh();assert.deepEqual(changes.at(-1)[0],[]);
  assert.ok(harness.requests.every(r=>['ping','status'].includes(r.method)&&Object.keys(r.params).length===0));
  observer.close();assert.equal(harness.listeners.size,0);
});
test('lifecycle hints refresh authoritative fleet; run IDs never alias opaque keys',async()=>{
  const h=busWith((request,bus)=>reply(bus,request,request.method==='ping'?ping:status([{key:'run-a',agent:'Worker',state:'running'}])));
  const changes=[];const observer=new SubagentObserver(h.bus,(...args)=>changes.push(args));await observer.refresh();
  h.bus.emit('subagent:child-status',{version:1,type:'subagent.child-status',runId:'run-a',childId:'run-a',status:'stopped'});
  await tick();assert.equal(changes.at(-1)[0][0].state,'working');assert.equal(changes.at(-1)[0][0].lifecycle.kind,'start');observer.close();
});
test('max63 deterministic live-first children with explicit overflow and no fabricated tasks',async()=>{
  const entries=Array.from({length:90},(_,i)=>({key:`key-${String(i).padStart(3,'0')}`,agent:`Worker ${i}`,state:i<20?'completed':'running'}));
  const h=busWith((request,bus)=>reply(bus,request,request.method==='ping'?ping:status(entries)));
  const changes=[];const observer=new SubagentObserver(h.bus,(...args)=>changes.push(args));await observer.refresh();
  const [rows,omitted]=changes.at(-1);assert.equal(rows.length,63);assert.equal(omitted,27);assert.ok(rows.every(r=>r.state==='working'));
  const names=rows.map(r=>r.name);entries.reverse();await observer.refresh();assert.deepEqual(changes.at(-1)[0].map(r=>r.name),names);observer.close();
});
test('partial fleet retains previous bounded rows; complete fleet removes missing rows',async()=>{
  let projection=status([{key:'a',agent:'A'},{key:'b',agent:'B'}]);
  const h=busWith((request,bus)=>reply(bus,request,request.method==='ping'?ping:projection));
  const changes=[];const observer=new SubagentObserver(h.bus,(...args)=>changes.push(args));await observer.refresh();
  projection={fleet:{version:1,entries:[{key:'a',agent:'A'}],omitted:1}};await observer.refresh();assert.equal(changes.at(-1)[0].length,2);assert.equal(changes.at(-1)[0].find(row=>row.name==='B').state,'stale');
  projection=status([{key:'a',agent:'A'}]);await observer.refresh();assert.equal(changes.at(-1)[0].length,1);observer.close();
});
test('unsupported plugin emits no status request; missing plugin is canceled cleanly',async()=>{
  const h=busWith((request,bus)=>reply(bus,request,{capabilities:{}}));const observer=new SubagentObserver(h.bus,()=>{});await observer.refresh();await observer.refresh();assert.deepEqual(h.requests.map(r=>r.method),['ping']);observer.close();
  const silent=busWith();const missing=new SubagentObserver(silent.bus,()=>{throw new Error('Must not publish');});const pending=missing.refresh();missing.close();await pending;assert.equal(silent.listeners.size,0);
});
test('one outstanding RPC; late responses after shutdown cannot publish or leak listeners',async()=>{
  const h=busWith();const changes=[];const observer=new SubagentObserver(h.bus,(...args)=>changes.push(args));
  const a=observer.refresh();const b=observer.refresh();assert.equal(h.requests.length,1);const request=h.requests[0];observer.close();reply(h.bus,request,ping);await Promise.all([a,b]);await tick();assert.equal(changes.length,0);assert.equal(h.listeners.size,0);
});
test('stop/resume markers advance even when the wall clock repeats or moves backwards',async()=>{
  let state='running',now=1800000000000;
  const original=Date.now;Date.now=()=>now;
  try{
    const h=busWith((request,bus)=>reply(bus,request,request.method==='ping'?ping:status([{key:'a',agent:'Worker',state}])));
    const changes=[];const observer=new SubagentObserver(h.bus,(...args)=>changes.push(args));await observer.refresh();const a=changes.at(-1)[0][0].lifecycle;
    state='completed';await observer.refresh();const b=changes.at(-1)[0][0].lifecycle;
    state='running';now-=5000;await observer.refresh();const c=changes.at(-1)[0][0].lifecycle;
    assert.equal(b.kind,'stop');assert.equal(c.kind,'start');assert.ok(Date.parse(b.at)>Date.parse(a.at));assert.ok(Date.parse(c.at)>Date.parse(b.at));observer.close();
  }finally{Date.now=original;}
});

const statusFailures = [
  ['null', (request,bus)=>reply(bus,request,null)],
  ['rejection', (request,bus)=>bus.emit(`subagents:rpc:v1:reply:${request.requestId}`,{version:1,requestId:request.requestId,success:false,error:{message:'Private diagnostic'}})],
  ['thrown transport', ()=>{throw new Error('Private plugin failure');}],
  ['missing fleet', (request,bus)=>reply(bus,request,{})],
  ['wrong fleet version', (request,bus)=>reply(bus,request,{fleet:{version:2,entries:[],omitted:0}})],
  ['malformed entries', (request,bus)=>reply(bus,request,{fleet:{version:1,entries:null,omitted:0}})],
  ['missing omission count', (request,bus)=>reply(bus,request,{fleet:{version:1,entries:[]}})],
  ['invalid omission count', (request,bus)=>reply(bus,request,{fleet:{version:1,entries:[],omitted:-1}})],
  ['timeout', ()=>{}],
];
for (const [name,fail] of statusFailures) test(`status ${name} clears cached children and valid idle reconnect restores fresh observations`,async t=>{
  if(name==='timeout')t.mock.timers.enable({apis:['setTimeout']});
  let failed=false,state='running';
  const h=busWith((request,bus)=>{
    if(request.method==='ping')reply(bus,request,ping);
    else if(failed)fail(request,bus);
    else reply(bus,request,status([{key:'recoverable-child',agent:'Private name',state}]));
  });
  const changes=[];const observer=new SubagentObserver(h.bus,(...args)=>changes.push(args));t.after(()=>observer.close());
  await observer.refresh();const original=changes.at(-1)[0][0];assert.equal(original.state,'working');
  failed=true;const failedRefresh=observer.refresh();const oldRequest=h.requests.at(-1);
  if(name==='timeout')t.mock.timers.tick(800);
  await failedRefresh;assert.deepEqual(changes.at(-1),[[],0,false]);
  assert.ok(![...h.listeners.keys()].some(key=>key.startsWith('subagents:rpc:v1:reply:')));
  failed=false;state='idle';await observer.refresh();const restored=changes.at(-1)[0][0];
  assert.equal(restored.id,original.id);assert.equal(restored.state,'idle');assert.equal(restored.lifecycle.kind,'start');assert.notEqual(restored.lifecycle.eventId,original.lifecycle.eventId);assert.ok(Date.parse(restored.lifecycle.at)>Date.parse(original.lifecycle.at));
  const count=changes.length;reply(h.bus,oldRequest,status([{key:'stale-child',agent:'Must stay hidden',state:'running'}]));assert.equal(changes.length,count);
  assert.equal(h.requests.filter(request=>request.method==='ping').length,2);
});

for (const name of ['null','rejection','malformed','timeout']) test(`ready restart clears children immediately even when fresh ping is ${name}`,async t=>{
  if(name==='timeout')t.mock.timers.enable({apis:['setTimeout']});
  let failPing=false;
  const h=busWith((request,bus)=>{
    if(request.method==='status'){reply(bus,request,status([{key:'child',agent:'Worker',state:'running'}]));return;}
    if(!failPing){reply(bus,request,ping);return;}
    if(name==='null')reply(bus,request,null);
    if(name==='malformed')reply(bus,request,{capabilities:null});
    if(name==='rejection')bus.emit(`subagents:rpc:v1:reply:${request.requestId}`,{version:1,requestId:request.requestId,success:false});
  });
  const changes=[];const observer=new SubagentObserver(h.bus,(...args)=>changes.push(args));t.after(()=>observer.close());await observer.refresh();assert.equal(changes.at(-1)[0].length,1);
  failPing=true;h.bus.emit('subagents:rpc:v1:ready',{});assert.deepEqual(changes.at(-1),[[],0,false]);
  if(name==='timeout')t.mock.timers.tick(800);
  await tick();assert.deepEqual(changes.at(-1),[[],0,false]);
  failPing=false;await observer.refresh();assert.equal(changes.at(-1)[0].length,1);assert.equal(changes.at(-1)[2],true);
});

test('ready epoch cancels pending old status and old replies cannot revive children',async()=>{
  let hold=false;const held=[];
  const h=busWith((request,bus)=>{
    if(hold){held.push(request);return;}
    reply(bus,request,request.method==='ping'?ping:status([{key:'child',agent:'Worker',state:'running'}]));
  });
  const changes=[];const observer=new SubagentObserver(h.bus,(...args)=>changes.push(args));await observer.refresh();const previous=changes.at(-1)[0][0];
  hold=true;const oldRefresh=observer.refresh();const old=held.at(-1);assert.equal(old.method,'status');
  h.bus.emit('subagents:rpc:v1:ready',{});assert.deepEqual(changes.at(-1),[[],0,false]);await oldRefresh;await tick();
  const newPing=held.at(-1);assert.equal(newPing.method,'ping');
  const count=changes.length;reply(h.bus,old,status([{key:'old',agent:'Old plugin',state:'running'}]));assert.equal(changes.length,count);
  reply(h.bus,newPing,ping);await tick();const newStatus=held.at(-1);assert.equal(newStatus.method,'status');
  reply(h.bus,newStatus,status([{key:'child',agent:'Worker',state:'idle'}]));await tick();const restored=changes.at(-1)[0][0];
  assert.equal(restored.state,'idle');assert.notEqual(restored.lifecycle.eventId,previous.lifecycle.eventId);assert.ok(Date.parse(restored.lifecycle.at)>Date.parse(previous.lifecycle.at));observer.close();
});

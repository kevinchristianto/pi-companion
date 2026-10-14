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

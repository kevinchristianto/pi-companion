/** Invoked by the Rust integration test against a fresh in-memory test bridge only. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {setImmediate as tick,setTimeout as sleep} from 'node:timers/promises';
import {requestLocal} from '../transport.ts';
import {validateOrigin} from '../connection.ts';
import {installedFixture,fixtureToken} from './installed-fixture.mjs';
const origin=validateOrigin(process.argv[2]);
const deadline=setTimeout(()=>{process.stderr.write('Adapter roundtrip exceeded its 15-second test deadline.\n');process.exit(1);},15_000);deadline.unref();
// Public synthetic test marker, never read from the user's connection file.
const token=fixtureToken;
const connection={url:origin,token};
assert.equal(process.env.PI_COMPANION_CONNECTION_FILE,undefined,'Roundtrip must exercise ordinary no-env discovery');
const installed=await installedFixture();
await installed.connect(origin);
const {installObserver}=await installed.load();
async function readSnapshot(){
  return new Promise((resolve,reject)=>{
    const request=http.get(`${origin}/api/snapshot`,{agent:false,headers:{authorization:`Bearer ${token}`}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>{try{assert.equal(response.statusCode,200);resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(error){reject(error);}});
    });request.on('error',reject);request.setTimeout(2000,()=>request.destroy(new Error('Test snapshot deadline')));
  });
}
let childRows=[{key:'worker-a',agent:'Fixture builder',state:'running',currentTool:'read',model:'fixture-model'},{key:'worker-b',agent:'Fixture reviewer',state:'running',model:'fixture-model'}];
let failStatus=false;
function create(name,options={}){
  const handlers=new Map(),listeners=new Map(),wire=[];
  const bus={on(event,handler){const set=listeners.get(event)||new Set();set.add(handler);listeners.set(event,set);return()=>{set.delete(handler);if(!set.size)listeners.delete(event);};},emit(event,data){
    if(event==='subagents:rpc:v1:request'){
      if(data.method==='status'&&failStatus){bus.emit(`subagents:rpc:v1:reply:${data.requestId}`,{version:1,requestId:data.requestId,success:false});return;}
      const reply=data.method==='ping'?{capabilities:{fleetStatus:{version:1}}}:{fleet:{version:1,entries:childRows,omitted:0,totalActive:childRows.length}};
      bus.emit(`subagents:rpc:v1:reply:${data.requestId}`,{version:1,requestId:data.requestId,success:true,data:reply});
    }
    for(const handler of [...(listeners.get(event)||[])])handler(data);
  }};
  const context={cwd:'/fixture/project',model:{id:'fixture-model'},sessionManager:{getSessionId:()=> 'adapter-roundtrip-session'},isIdle:()=>false};
  const pi={on(event,handler){handlers.set(event,handler);},getSessionName:()=>name,events:bus};
  const adapter=installObserver(pi,{heartbeatMs:options.heartbeatMs,request:async(config,route,body)=>{
    const result=await requestLocal(config,route,body);wire.push({route,body:structuredClone(body),status:result.status});return result;
  }});
  return {adapter,wire,bus,context,emit(event,data={}){return handlers.get(event)?.(data,context);},async flush(){await tick();await adapter.flush();}};
}
const first=create('Original named Pi session');let replacement,heartbeatProbe;
try{
  await first.emit('session_start');await first.flush();
  let snapshot=await readSnapshot();assert.equal(snapshot.agents.length,3);assert.equal(snapshot.agents.find(a=>a.agentId==='main').name,'Original named Pi session');
  assert.deepEqual(new Set(snapshot.agents.filter(a=>a.agentId!=='main').map(a=>a.name)),new Set(['Fixture builder','Fixture reviewer']));
  assert.ok(first.wire.filter(x=>x.route==='/api/ingest').every(x=>x.status===202&&x.body.session.agentsComplete===true&&x.body.streamId));
  await first.emit('session_info_changed',{name:'Renamed from real adapter'});await first.emit('tool_execution_start',{toolCallId:'fixture-tool',toolName:'read',get args(){throw new Error('Private args must not be accessed');}});await first.flush();
  snapshot=await readSnapshot();const root=snapshot.agents.find(a=>a.agentId==='main');assert.equal(root.name,'Renamed from real adapter');assert.equal(root.state,'working');assert.equal(root.tool,'read');
  await first.emit('tool_execution_end',{toolCallId:'fixture-tool',get result(){throw new Error('Private result must not be accessed');}});await first.emit('agent_settled');await first.flush();assert.equal((await readSnapshot()).agents.find(a=>a.agentId==='main').state,'idle');
  // Actual adapter fleet terminal markers must be accepted and retire the child.
  childRows[0]={...childRows[0],state:'completed'};first.bus.emit('subagent:async-complete',{});await first.flush();
  snapshot=await readSnapshot();assert.equal(snapshot.agents.length,2);assert.ok(!snapshot.agents.some(a=>a.name==='Fixture builder'));
  // Complete replacement, unlike a legacy patch, retires the no-longer-reported child.
  childRows=[];first.bus.emit('subagent:async-complete',{});await first.flush();assert.equal((await readSnapshot()).agents.length,1);
  const last=first.wire.filter(x=>x.route==='/api/ingest').at(-1);assert.equal((await requestLocal(connection,'/api/ingest',last.body)).status,409);assert.equal((await readSnapshot()).agents.length,1);
  childRows=Array.from({length:70},(_,i)=>({key:`worker-${String(i).padStart(3,'0')}`,agent:`Worker ${i}`,state:'running'}));first.bus.emit('subagent:async-started',{});await first.flush();
  snapshot=await readSnapshot();assert.equal(snapshot.agents.length,64);assert.equal(snapshot.omittedAgentCount,7);
  childRows=[];replacement=create('New observer activation');await replacement.emit('session_start');await replacement.flush();
  snapshot=await readSnapshot();assert.equal(snapshot.agents.length,1);assert.equal(snapshot.agents[0].name,'New observer activation');
  await first.emit('session_info_changed',{name:'Old activation must never win'});await first.flush();await first.flush();
  assert.equal((await readSnapshot()).agents[0].name,'New observer activation');assert.ok(first.wire.some(x=>x.route==='/api/hello'&&x.status===409));
  await first.adapter.close();await replacement.emit('session_shutdown',{reason:'quit'});assert.equal((await readSnapshot()).agents.length,0);
  // A root heartbeat must never renew cached children after their status source fails.
  childRows=[{key:'idle-child',agent:'Connected idle child',state:'idle'}];
  heartbeatProbe=create('Connected idle root',{heartbeatMs:20});await heartbeatProbe.emit('session_start');await heartbeatProbe.emit('agent_settled');await heartbeatProbe.flush();
  snapshot=await readSnapshot();assert.equal(snapshot.agents.length,2);assert.ok(snapshot.agents.every(agent=>agent.state==='idle'));
  failStatus=true;heartbeatProbe.bus.emit('subagent:async-complete',{});await heartbeatProbe.flush();
  snapshot=await readSnapshot();assert.equal(snapshot.agents.length,1);assert.equal(snapshot.agents[0].name,'Connected idle root');assert.equal(snapshot.agents[0].state,'idle');
  const sequence=heartbeatProbe.wire.filter(entry=>entry.route==='/api/ingest').at(-1).body.source.sequence;
  await sleep(65);await heartbeatProbe.flush();snapshot=await readSnapshot();assert.equal(snapshot.agents.length,1);assert.equal(snapshot.agents[0].state,'idle');
  assert.ok(heartbeatProbe.wire.filter(entry=>entry.route==='/api/ingest').at(-1).body.source.sequence>sequence);
  assert.equal(heartbeatProbe.adapter.snapshot().session.connected,true);
  failStatus=false;heartbeatProbe.bus.emit('subagent:async-started',{});await heartbeatProbe.flush();snapshot=await readSnapshot();
  assert.equal(snapshot.agents.length,2);assert.equal(snapshot.agents.find(agent=>agent.name==='Connected idle child').state,'idle');
  await heartbeatProbe.adapter.close();assert.equal((await readSnapshot()).agents.length,0);
  process.stdout.write('Relocated no-env Node Pi adapter ↔ Rust HTTP bridge roundtrip passed.\n');
} finally {await first.adapter.close();await replacement?.adapter.close();await heartbeatProbe?.adapter.close();await installed.remove();clearTimeout(deadline);}

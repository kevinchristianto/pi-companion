import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {installObserver} from '../index.ts';
import {SnapshotTransport} from '../transport.ts';
import {HEARTBEAT_MS} from '../protocol.ts';
const connection = {url:'http://127.0.0.1:4318',token:'TEST_ONLY_NOT_A_REAL_CREDENTIAL_0123456789'};
const snapshot = (name='One') => ({version:1,session:{id:'session-1',name,cwd:'/repo',model:null,connected:true,agentsComplete:true,agents:[{id:'main',name:'Pi',role:'orchestrator',state:'idle'}]},capabilities:{pi:true,subagents:false,fleet:false,metadataOnly:true,omittedAgents:0}});
function deferred(){let resolve;const promise = new Promise(r=>resolve=r);return {promise,resolve};}
function context(id='session-1',idle=true){return {cwd:'/private/project',model:{id:'model-a'},sessionManager:{getSessionId:()=>id},isIdle:()=>idle};}
function harness(options={}){
  const handlers=new Map(), sent=[], calls=[];let name='Named session';
  const pi={on(event,handler){handlers.set(event,handler);},getSessionName(){return name;},...options.pi};
  const request=options.request||(async(_config,route,body)=>{calls.push({route,body:structuredClone(body)});if(route==='/api/hello')return{status:200,body:{streamId:"test-bridge-stream-1",source:{generation:17}}};sent.push(structuredClone(body));return {status:202,body:null};});
  const observer=installObserver(pi,{loadConnection:async()=>connection,request,...options});
  return {observer,handlers,sent,calls,setName(value){name=value;},emit(event,data={},ctx=context()){return handlers.get(event)?.(data,ctx);}};
}
test('factory only registers documented observational events and opens no resources', async t=>{
  const h=harness();t.after(()=>h.observer.close());
  assert.deepEqual([...h.handlers.keys()],['session_start','session_shutdown','session_info_changed','agent_start','agent_end','agent_settled','tool_execution_start','tool_execution_end','model_select','ui_prompt_start','ui_prompt_end']);
  assert.equal(h.observer.snapshot(),null);assert.equal(h.calls.length,0);assert.equal(HEARTBEAT_MS,10_000);
});
test('start, rename, model, parallel tools, waiting and settled remain metadata-only',async t=>{
  const h=harness();t.after(()=>h.observer.close());await h.emit('session_start');await h.observer.flush();
  assert.equal(h.sent[0].session.name,'Named session');assert.equal(h.sent[0].session.agents[0].state,'idle');
  const marker=h.sent[0].session.agents[0].lifecycle.eventId;
  const secret=()=>{throw new Error('Private field was accessed');};
  await h.emit('agent_start');
  await h.emit('tool_execution_start',{toolCallId:'a',toolName:'read',get args(){return secret();}});
  await h.emit('tool_execution_start',{toolCallId:'b',toolName:'bash',get args(){return secret();}});
  await h.emit('tool_execution_end',{toolCallId:'a',toolName:'read',get result(){return secret();}});
  assert.equal(h.observer.snapshot().session.agents[0].tool,'bash');assert.equal(h.observer.snapshot().session.agents[0].state,'working');
  await h.emit('ui_prompt_start',{get message(){return secret();}});assert.equal(h.observer.snapshot().session.agents[0].state,'waiting');
  await h.emit('ui_prompt_end');await h.emit('tool_execution_end',{toolCallId:'b'});
  await h.emit('agent_end',{get messages(){return secret();}},context('session-1',false));assert.equal(h.observer.snapshot().session.agents[0].state,'thinking');
  await h.emit('agent_settled',{get messages(){return secret();}});
  await h.emit('session_info_changed',{name:'Renamed'});await h.emit('model_select',{model:{id:'model-b'}});await h.observer.flush();
  const last=h.sent.at(-1);assert.equal(last.session.name,'Renamed');assert.equal(last.session.model,'model-b');assert.equal(last.session.agents[0].state,'idle');assert.equal(last.session.agents[0].lifecycle.eventId,marker);
  assert.ok(!JSON.stringify(last).includes('args'));assert.ok(!('task' in last.session.agents[0]));assert.equal(last.source.generation,17);
  assert.ok(h.sent.every((v,i)=>i===0||v.source.sequence>h.sent[i-1].source.sequence));
});
test('idle heartbeat persists without activity and shutdown flushes disconnected state once',async()=>{
  const h=harness({heartbeatMs:25});await h.emit('session_start');await h.observer.flush();
  await sleep(40);await h.observer.flush();assert.ok(h.sent.length>=2);assert.ok(h.sent.every(x=>x.session.agents[0].state==='idle'));
  h.setName('Heartbeat rename');await sleep(35);await h.observer.flush();assert.equal(h.sent.at(-1).session.name,'Heartbeat rename');
  await h.emit('session_shutdown',{reason:'quit'});const count=h.sent.length;
  assert.equal(h.sent.at(-1).session.connected,false);assert.equal(h.sent.at(-1).session.agents[0].lifecycle.kind,'stop');
  await h.emit('session_shutdown',{reason:'quit'});await sleep(100);assert.equal(h.sent.length,count);assert.equal(h.observer.snapshot(),null);
});
test('concurrent start/start/stop never revives canceled startup',async()=>{
  const h=harness();const a=h.emit('session_start',{},context('a'));const b=h.emit('session_start',{},context('b'));const stop=h.emit('session_shutdown',{},context('b'));
  await Promise.all([a,b,stop]);await h.observer.flush();assert.equal(h.observer.snapshot(),null);assert.equal(h.sent.length,0);
  await h.emit('session_start',{},context('c'));await h.observer.flush();assert.equal(h.sent.at(-1).session.id,'c');await h.observer.close();
});
test('switch waits for old disconnect; late old-context callbacks cannot mutate the new session',async()=>{
  const h=harness();await h.emit('session_start',{},context('a'));await h.observer.flush();
  await h.emit('session_start',{},context('b'));await h.observer.flush();
  assert.deepEqual(h.sent.map(s=>[s.session.id,s.session.connected]),[['a',true],['a',false],['b',true]]);
  await h.emit('session_info_changed',{name:'wrong'},context('a'));await h.emit('session_shutdown',{},context('a'));
  assert.equal(h.observer.snapshot().session.id,'b');assert.equal(h.observer.snapshot().session.name,'Named session');await h.observer.close();
});
test('single-flight coalescing and final disconnected snapshot survive an in-flight send',async()=>{
  const gate=deferred();const seen=[];let active=0,max=0;
  const transport=new SnapshotTransport(async()=>connection,'session-1','instance-a',async(_c,route,body)=>{
    active++;max=Math.max(max,active);
    if(route==='/api/hello'){active--;return{status:200,body:{streamId:"test-bridge-stream-1",source:{generation:1}}};}
    seen.push(structuredClone(body));if(seen.length===1)await gate.promise;active--;return{status:202,body:null};
  });
  transport.submit(snapshot('initial'));const first=transport.flush();await sleep(1);
  for(let n=0;n<100;n++)transport.submit(snapshot(`update-${n}`));
  const final=snapshot('shutdown');final.session.connected=false;
  const close=transport.close(final);gate.resolve();await Promise.all([first,close]);
  assert.equal(max,1);assert.deepEqual(seen.map(s=>s.session.name),['initial','shutdown']);
});
test('temporary disconnect re-reads credentials and renegotiates before next complete snapshot',async()=>{
  let fail=true,loads=0;const sent=[];
  const transport=new SnapshotTransport(async()=>{loads++;return connection;},'session-1','instance-a',async(_c,route,body)=>{
    if(fail)throw new Error('secret diagnostic never logged');
    if(route==='/api/hello')return{status:200,body:{streamId:"test-bridge-stream-1",source:{generation:2}}};sent.push(body);return{status:202,body:null};
  });
  transport.submit(snapshot());await transport.flush();assert.equal(loads,1);fail=false;transport.submit(snapshot('latest'));await transport.flush();
  assert.equal(loads,2);assert.equal(sent[0].session.name,'latest');assert.equal(sent[0].source.generation,2);
  await transport.close({...snapshot(),session:{...snapshot().session,connected:false}});
});
test('superseded handshake stops retries without stealing a new instance lease',async()=>{
  let calls=0;const transport=new SnapshotTransport(async()=>connection,'session-1','old-instance',async()=>{calls++;return{status:409,body:{}};});
  transport.submit(snapshot());await transport.flush();transport.submit(snapshot());await transport.flush();await transport.close(snapshot());assert.equal(calls,1);
});
test('malformed handshake never sends an unordered snapshot',async()=>{
  const routes=[];const transport=new SnapshotTransport(async()=>connection,'session-1','instance-a',async(_c,route)=>{routes.push(route);return{status:200,body:{streamId:"test-bridge-stream-1",source:{generation:NaN}}};});
  transport.submit(snapshot());await transport.flush();await transport.close(snapshot());assert.ok(routes.every(route=>route==='/api/hello'));
});
test('overflow warning is content-free, emitted once, and resets after resolution',async()=>{
  let count=70;const listeners=new Map(),warnings=[];
  const bus={on(name,fn){listeners.set(name,fn);return()=>listeners.delete(name);},emit(name,request){
    if(name!=='subagents:rpc:v1:request')return;
    const data=request.method==='ping'?{capabilities:{fleetStatus:{version:1}}}:{fleet:{version:1,omitted:0,entries:Array.from({length:count},(_,i)=>({key:`k${i}`,agent:`Private agent ${i}`,state:'running'}))}};
    listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({version:1,requestId:request.requestId,success:true,data});
  }};
  const h=harness({pi:{events:bus}});const ctx={...context(),hasUI:true,ui:{notify(message){warnings.push(message);}}};
  await h.emit('session_start',{},ctx);await sleep(1);await h.observer.flush();
  assert.equal(warnings.length,1);assert.ok(!warnings[0].includes('Private'));assert.equal(h.sent.at(-1).session.omittedAgentCount,7);assert.equal(h.sent.at(-1).session.agents.length,64);assert.equal(h.sent.at(-1).session.agentsComplete,true);
  await h.emit('agent_settled',{},ctx);await sleep(1);assert.equal(warnings.length,1);
  count=1;await h.emit('agent_settled',{},ctx);await sleep(1);count=70;await h.emit('agent_settled',{},ctx);await sleep(1);assert.equal(warnings.length,2);await h.observer.close();
});
test('display strings preserve whole Unicode characters and cannot emit lone surrogates',async()=>{
  const h=harness();await h.emit('session_start');await h.emit('session_info_changed',{name:'a'.repeat(159)+'🧠'});await h.observer.flush();
  assert.equal(h.sent.at(-1).session.name,'a'.repeat(159)+'🧠');
  await h.emit('session_info_changed',{name:'bad\ud800name'});await h.observer.flush();assert.equal(h.sent.at(-1).session.name,'bad�name');await h.observer.close();
});
test('bridge restart replaces stream lease before sending later snapshots',async()=>{
  let stream='bridge-a',rejectOld=false;const ingests=[];const hellos=[];
  const transport=new SnapshotTransport(async()=>connection,'session-1','instance-a',async(_c,route,body)=>{
    if(route==='/api/hello'){hellos.push(body);return{status:200,body:{streamId:stream,source:{generation:1}}};}
    ingests.push(body);return{status:rejectOld&&body.streamId!==stream?409:202,body:null};
  });
  transport.submit(snapshot('before restart'));await transport.flush();stream='bridge-b';rejectOld=true;
  transport.submit(snapshot('after restart'));await transport.flush();await transport.flush();
  assert.equal(hellos.length,2);assert.equal(hellos[0].instanceId,hellos[1].instanceId);assert.equal(ingests.at(-1).streamId,'bridge-b');assert.equal(ingests.at(-1).session.name,'after restart');await transport.close(snapshot());
});
test('shutdown of pending replacement cancels it even while the prior session is active',async()=>{
  const h=harness();await h.emit('session_start',{},context('a'));await h.observer.flush();
  const start=h.emit('session_start',{},context('b'));const stop=h.emit('session_shutdown',{},context('b'));
  await Promise.all([start,stop]);assert.equal(h.observer.snapshot(),null);assert.deepEqual(h.sent.map(s=>[s.session.id,s.session.connected]),[['a',true],['a',false]]);await h.observer.close();
});
test('late shutdown of old runtime does not cancel the newer pending replacement',async()=>{
  const h=harness();await h.emit('session_start',{},context('a'));await h.observer.flush();
  const start=h.emit('session_start',{},context('b'));const oldStop=h.emit('session_shutdown',{},context('a'));
  await Promise.all([start,oldStop]);await h.observer.flush();assert.equal(h.observer.snapshot().session.id,'b');assert.equal(h.sent.at(-1).session.connected,true);await h.observer.close();
});
test('concurrent transport close calls share the final flush and send only once',async()=>{
  const gate=deferred();let sends=0;
  const transport=new SnapshotTransport(async()=>connection,'session-1','instance-a',async(_c,route)=>{
    if(route==='/api/hello')return{status:200,body:{streamId:'test-stream',source:{generation:1}}};sends++;await gate.promise;return{status:202,body:null};
  });
  const a=transport.close(snapshot()),b=transport.close(snapshot());assert.equal(a,b);await sleep(1);assert.equal(sends,1);gate.resolve();await Promise.all([a,b]);assert.equal(sends,1);
});

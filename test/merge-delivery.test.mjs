import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {createMergeDelivery} from '../dist/merge-delivery.js';
import {hasMergeReceipt} from '../dist/merge-receipt.js';
const model={id:'delivery',name:'delivery',api:'openai-completions',provider:'delivery',baseUrl:'http://unused.invalid',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const merge=id=>({customType:'pi-btw-merge',content:'Explicit merge '+id,display:true,details:{mergeId:id}});
function gate(){let release;const promise=new Promise(r=>release=r);return {promise,release};}
async function fixture(t,{hold=true,startup}={}){
  const cwd=await mkdtemp(join(tmpdir(),'btw-delivery-'));
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  let api,ctx,delivery,calls=0;
  const entered=gate(),toolGate=gate(),requests=[],errors=[];
  const loader=new DefaultResourceLoader({cwd,agentDir:join(cwd,'agent'),settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,extensionFactories:[pi=>{
    api=pi;delivery=createMergeDelivery(pi);
    pi.on('session_start',(_event,c)=>{ctx=c;});
    if(startup)pi.on('before_agent_start',async()=>{startup.entered.release();await startup.gate.promise;});
    pi.registerProvider(model.provider,{apiKey:'dummy',api:model.api,baseUrl:model.baseUrl,models:[model]});
    pi.registerTool({name:'hold',label:'hold',description:'test barrier',parameters:{type:'object',properties:{}},async execute(_id,_args,signal){
      calls++;entered.release();
      await Promise.race([toolGate.promise,new Promise(resolve=>{if(signal?.aborted)resolve();else signal?.addEventListener('abort',resolve,{once:true});})]);
      return {content:[{type:'text',text:signal?.aborted?'cancelled':'released'}],details:undefined};
    }});
  }]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const manager=SessionManager.create(cwd,join(cwd,'sessions'));
  const {session}=await createAgentSession({cwd,agentDir:join(cwd,'agent'),model,resourceLoader:loader,settingsManager,sessionManager:manager});
  await session.bindExtensions({mode:'print',onError:e=>errors.push(e)});
  session.agent.streamFunction=(_model,context,options)=>{
    if(options?.signal?.aborted){
      const stream=createAssistantMessageEventStream();
      stream.push({type:'error',reason:'aborted',error:{role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'aborted',errorMessage:'cancelled before request',timestamp:Date.now()}});
      stream.end();return stream;
    }
    requests.push(context);
    const content=hold&&requests.length===1?[{type:'toolCall',name:'hold',id:'hold-call',arguments:{}}]:[{type:'text',text:'done'}];
    const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:content[0].type==='toolCall'?'toolUse':'stop',timestamp:Date.now()};
    const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
  };
  t.after(async()=>{toolGate.release();startup?.gate.release();await session.abort();session.dispose();await rm(cwd,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  return {session,manager,requests,entered,release:toolGate.release,send:m=>delivery.send(m,ctx),legacy:m=>api.sendMessage(m,{triggerTurn:true,deliverAs:'steer'}),receipt:id=>hasMergeReceipt(manager.getSessionFile(),id),calls:()=>calls};
}
test('regression: native steering merge can be lost when user clears queue and aborts a tool',{timeout:10000},async t=>{
  const h=await fixture(t),running=h.session.prompt('run slow');await h.entered.promise;
  h.legacy(merge('legacy'));assert.equal(h.receipt('legacy'),false);
  h.session.clearQueue();await h.session.abort();await running;
  assert.equal(h.receipt('legacy'),false);assert.equal(h.requests.length,1);
});
for(const clear of [false,true])test('queued merge persists once after tool abort, clearQueue='+clear,{timeout:10000},async t=>{
  const h=await fixture(t),running=h.session.prompt('run slow');await h.entered.promise;
  h.send(merge('saved'));assert.equal(h.receipt('saved'),false);
  if(clear)h.session.clearQueue();await h.session.abort();await running;
  assert.equal(h.receipt('saved'),true);assert.equal(h.requests.length,1,'do not restart after user abort');assert.equal(h.calls(),1);
  const entries=h.manager.getBranch();
  const result=entries.findIndex(e=>e.type==='message'&&e.message.role==='toolResult');
  const injected=entries.findIndex(e=>e.type==='custom_message'&&e.details?.mergeId==='saved');
  assert.ok(result>=0&&injected>result,'merge follows finalized tool results');
  await h.session.prompt('continue explicitly');
  assert.equal(h.requests.length,2);assert.equal(h.calls(),1,'interrupted tool is not replayed');
  assert.equal(h.manager.getBranch().filter(e=>e.type==='custom_message'&&e.details?.mergeId==='saved').length,1);
  assert.match(JSON.stringify(h.requests[1].messages),/Explicit merge saved/);
});
test('normal busy merge continues after the complete tool batch',{timeout:10000},async t=>{
  const h=await fixture(t),running=h.session.prompt('run slow');await h.entered.promise;
  h.send(merge('a'));h.send(merge('b'));assert.equal(h.receipt('a'),false);
  h.release();await running;
  assert.equal(h.requests.length,2);assert.equal(h.receipt('a'),true);assert.equal(h.receipt('b'),true);
  assert.match(JSON.stringify(h.requests[1].messages),/Explicit merge a/);
  assert.match(JSON.stringify(h.requests[1].messages),/Explicit merge b/);
});
test('abort during startup flushes merge at settled without requesting model',{timeout:10000},async t=>{
  const startup={entered:gate(),gate:gate()},h=await fixture(t,{startup});
  const running=h.session.prompt('starting');await startup.entered.promise;
  h.send(merge('startup'));const aborting=h.session.abort();startup.gate.release();
  await aborting;await running;
  assert.equal(h.receipt('startup'),true);assert.equal(h.requests.length,0);
});
test('idle merge retains immediate turn behavior',{timeout:10000},async t=>{
  const h=await fixture(t,{hold:false});
  h.send(merge('idle'));await h.session.waitForIdle();
  assert.equal(h.receipt('idle'),true);assert.equal(h.requests.length,1);
});
test('pending delivery is scoped and cleared on branch or workspace reset',()=>{
  const handlers={},sent=[],pi={on:(name,fn)=>handlers[name]=fn,sendMessage:(...args)=>sent.push(args)};
  let id='a';const ctx={isIdle:()=>false,sessionManager:{getSessionId:()=>id}};
  const delivery=createMergeDelivery(pi),end={entries:[],message:{role:'assistant',stopReason:'stop'}};
  delivery.send(merge('old'),ctx);id='b';assert.equal(handlers.turn_end(end,ctx),undefined);
  delivery.send(merge('tree'),ctx);handlers.session_tree();assert.equal(handlers.turn_end(end,ctx),undefined);
  delivery.send(merge('reset'),ctx);delivery.clear();handlers.agent_settled({},ctx);assert.equal(sent.length,0);
  const existing={type:'custom',customType:'other',data:{}};
  delivery.send(merge('new'),ctx);const result=handlers.turn_end({...end,entries:[existing]},ctx);
  assert.deepEqual(result.entries[0],existing);assert.equal(result.continue,true);
  assert.equal(handlers.turn_end(end,ctx),undefined);
});

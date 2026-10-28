import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, createAgentSession, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { forkSnapshot, rawConversation } from '../dist/snapshot.js';
import { startChild } from '../dist/child.js';
import btw from '../dist/index.js';
import {hasMergeReceipt} from '../dist/merge-receipt.js';
import {Workspace} from '../dist/workspace.js';
import {saveWorkspace,restoreWorkspace,workspaceFile} from '../dist/persistence.js';

async function waitFor(check) {
  const deadline=Date.now()+10000;
  while (!check()) { if(Date.now()>deadline) throw new Error('Condition timed out'); await new Promise(r=>setTimeout(r,20)); }
}
const model = {id:'btw-test',name:'btw-test',api:'openai-completions',provider:'btw-test',baseUrl:'http://unused.invalid',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
async function fixture(t, delay = 80) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-btw-worker-'));
  t.after(async () => { await new Promise(r => setTimeout(r, 150)); await rm(cwd, {recursive:true, force:true}); });
  const extension = join(cwd, 'provider.ts');
  await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi) {
  globalThis.__BTW_CHILD_SENTINEL = true;
  pi.on('session_start',(_event,ctx)=>ctx.ui.setStatus('qa','KEEP_EXISTING_STATUS'));
  pi.registerProvider('btw-test', {apiKey:'dummy',api:'openai-completions',baseUrl:'http://unused.invalid',models:[${JSON.stringify(model)}],
    streamSimple: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        const message = {role:'assistant',content:[{type:'text',text:'child reply: '+JSON.stringify(context.messages)}],api:'openai-completions',provider:'btw-test',model:'btw-test',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
        stream.push({type:'done',reason:'stop',message}); stream.end();
      }, ${delay});
      return stream;
    }
  });
}`);
  const parent = SessionManager.create(cwd, join(cwd, 'sessions'));
  parent.appendMessage({role:'user',content:'parent context',timestamp:1});
  const snapshot = forkSnapshot(parent, cwd);
  const capture = {...snapshot, cwd, agentDir:join(cwd,'agent'), model, thinkingLevel:'off', scopedModels:[], settings:{compaction:{enabled:false},retry:{enabled:false}},tools:['read','bash','edit','write'],extensionPaths:[extension],systemPrompt:'inherited system prompt',trusted:true};
  return {cwd,parent,capture};
}

test('branch context is delayed until first user prompt, once per branch and excluded from merge', {timeout:30000}, async t=>{
  const {parent,capture}=await fixture(t);
  const child=await startChild(capture);t.after(()=>child.session.dispose());
  const branch=()=>SessionManager.open(child.manager.getSessionFile());
  const notes=()=>branch().getBranch().filter(e=>e.type==='custom_message'&&e.customType==='pi-btw-context');
  assert.equal(notes().length,0,'startup must not inject or trigger a turn');
  await child.session.prompt('first branch question');
  assert.equal(notes().length,1);
  assert.match(notes()[0].content,/除非用户明确指定/);
  assert.match(JSON.stringify(child.session.messages.at(-1)),/除非用户明确指定/,'first model request includes safety message');
  await child.session.prompt('second branch question');
  assert.equal(notes().length,1);
  assert.equal(branch().getBranch().filter(e=>e.type==='message'&&e.message.role==='assistant').length,2,'no extra model turn for introduction');
  assert.ok(!rawConversation(branch(),child.boundary).split('\n').map(JSON.parse).some(e=>e.customType==='pi-btw-context'));
  assert.ok(!parent.getBranch().some(e=>e.customType==='pi-btw-context'));
  const nested=await startChild(await child.session.snapshot());t.after(()=>nested.session.dispose());
  const own=()=>rawConversation(SessionManager.open(nested.manager.getSessionFile()),nested.boundary);
  assert.equal(own(),'');
  await nested.session.prompt('nested first question');
  const entries=SessionManager.open(nested.manager.getSessionFile()).getBranch();
  const boundary=entries.findIndex(e=>e.id===nested.boundary);
  assert.equal(entries.slice(boundary+1).filter(e=>e.customType==='pi-btw-context').length,1,'inherited reminder does not suppress nested introduction');
});
test('independent SDK process inherits history/system/tools and does not mutate parent or globals', {timeout:30000}, async t => {
  const {parent,capture} = await fixture(t);
  const before = await readFile(parent.getSessionFile(), 'utf8');
  const child = await startChild(capture);
  t.after(() => child.session.dispose());
  assert.equal(globalThis.__BTW_CHILD_SENTINEL, undefined);
  const events = [];
  child.session.subscribe(event => events.push(event.type));
  const running = child.session.prompt('BTW question');
  assert.equal(child.session.isStreaming, true);
  parent.appendMessage({role:'user',content:'parent continues independently',timestamp:2});
  await running;
  assert.equal(child.session.isStreaming, false);
  assert.ok(events.includes('message_end'));
  assert.match(child.session.preview.join(' '),/BTW question/);
  const footer=await child.session.request('footer',{width:120,theme:'dark'});
  assert.match(footer.join('\n'),/btw-test/);
  assert.match(footer.join('\n'),/KEEP_EXISTING_STATUS/);
  assert.match(footer.join('\n'),/100k/);
  assert.match(footer.join('\n'),/pi-btw-worker-/);
  const raw = await readFile(child.manager.getSessionFile(), 'utf8');
  assert.match(raw, /child reply/);
  assert.match(raw, /parent context/);
  assert.match(raw, /inherited system prompt/);
  assert.doesNotMatch(raw, /parent continues independently/);
  assert.doesNotMatch(await readFile(parent.getSessionFile(), 'utf8'), /BTW question|child reply/);
  assert.ok((await readFile(parent.getSessionFile(), 'utf8')).startsWith(before));
});

test('extension merges only explicitly, queues steering, prevents duplicates, and summarizes', {timeout:30000}, async t => {
  const {parent,capture} = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = capture.agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const handlers = new Map(), commands = new Map(), sent = [], notices = [];
  const pi = {
    on:(event, handler) => handlers.set(event, handler),
    registerCommand:(name, options) => commands.set(name, options.handler),
    registerShortcut:() => {}, getSettings:() => capture.settings,
    getThinkingLevel:() => 'off', getActiveTools:() => capture.tools,
    getAllTools:() => capture.tools.map(name => ({name, sourceInfo:{path:'builtin:'+name}})),
    getCommands:() => [{source:'extension',sourceInfo:{path:capture.extensionPaths[0]}}],
    sendMessage:(message, options) => {
      sent.push({message,options});
      parent.appendCustomMessageEntry(message.customType,message.content,message.display,message.details);
    },
  };
  let summaryRaw, selection, listSelection, summaryFinish;
  let holdSummary=false;
  const choose=async () => undefined;
  let shownTab;
  const dialog=async (factory,options) => {
    if(options?.overlayOptions?.width===76)return selection;
    if(!options)return listSelection;
    const panel=factory({terminal:{rows:40},requestRender(){}},{fg:(_name,text)=>text},undefined,()=>{});
    shownTab=panel.tab;panel.dispose();
    return undefined;
  };
  const ctx = {
    isIdle:()=>true,mode:'tui', cwd:capture.cwd, model, thinkingLevel:'off', scopedModels:[], sessionManager:parent,
    getSystemPrompt:() => capture.systemPrompt, isProjectTrusted:() => true,
    modelRegistry:{streamSimple:(_model, context) => {summaryRaw=JSON.stringify(context.messages);const stream=createAssistantMessageEventStream();const finish=()=>{stream.push({type:'done',reason:'stop',message:{stopReason:'stop',content:[{type:'text',text:'merged summary'}]}});stream.end();};if(holdSummary)summaryFinish=finish;else finish();return stream;}},
    ui:{select:choose, custom:dialog, notify:(message,type) => notices.push({message,type})},
  };
  btw(pi); handlers.get('session_start')({}, ctx);
  t.after(() => handlers.get('session_shutdown')());
  const command = async args => {
    const before=notices.length;
    await commands.get('btw')(args, ctx);
    const started=notices.slice(before).find(n=>/generating summary|preparing merge/.test(n.message));
    if (started) await waitFor(()=>notices.at(-1)!==started);
  };
  assert.equal(sent.length, 0);
  await command('first question');
  const forkedFile=notices.at(-1).message.match(/: (.*)$/)[1];
  await waitFor(()=>/child reply/.test(JSON.stringify(SessionManager.open(forkedFile).buildSessionContext().messages)));
  await waitFor(()=>!shownTab.child.session.isStreaming);
  const forked=SessionManager.open(forkedFile);
  const firstPrompts=forked.buildSessionContext().messages.filter(m=>m.role==='user'&&JSON.stringify(m.content).includes('first question'));
  assert.equal(firstPrompts.length,1,'/btw <question> submits the initial question exactly once');
  assert.match(JSON.stringify(forked.buildSessionContext().messages),/child reply/);
  assert.doesNotMatch(await readFile(parent.getSessionFile(),'utf8'),/first question/);
  await command('merge');
  assert.equal(sent.length,0,'cancelling must not merge');
  selection={destination:0,close:false,summary:false,conversation:'Full'};
  await command('merge');
  assert.equal(sent.length, 1, JSON.stringify(notices));
  assert.match(sent[0].message.content, /first question/);
  assert.equal(sent[0].options.deliverAs, 'steer');
  assert.equal(sent[0].options.triggerTurn, true);
  listSelection={kind:'switch',id:1};
  await command('list');
  await command('merge');
  assert.equal(sent.length, 1);
  assert.match(notices.at(-1).message, /already been merged/);
  await command('second question');
  const secondFile=notices.at(-1).message.match(/: (.*)$/)[1];
  await waitFor(()=>/child reply/.test(JSON.stringify(SessionManager.open(secondFile).buildSessionContext().messages).replace(/parent context/g,'')) && SessionManager.open(secondFile).getBranch().filter(e=>e.type==='message'&&e.message.role==='assistant').length>=2);
  await waitFor(()=>!shownTab.child.session.isStreaming);
  selection={destination:0,close:false,summary:true,conversation:'None'};
  holdSummary=true;
  await commands.get('btw')('merge',ctx);
  assert.equal(sent.length,1,'command returns while summary is still pending');
  assert.match(notices.at(-1).message,/generating summary/);
  await waitFor(()=>!!summaryFinish);summaryFinish();holdSummary=false;
  await waitFor(()=>sent.length===2);
  assert.equal(sent.length, 2, JSON.stringify(notices));
  assert.match(sent[1].message.content, /merged summary/);
  assert.match(summaryRaw, /second question/);
  listSelection={kind:'switch',id:0};
  await command('list');
  await command('merge');
  assert.match(notices.at(-1).message,/Select a BTW/);
  const saved=JSON.parse(await readFile(workspaceFile(parent),'utf8'));
  const originalBtwFile=saved.tabs.find(tab=>tab.id===2).capture.file;
  const originalBtw=await readFile(originalBtwFile,'utf8');
  listSelection={kind:'merge',id:2};
  selection=undefined;
  await command('list');
  assert.equal(sent.length,2,'cancel unified dialog must not merge');
  selection={destination:1,close:false,summary:false,conversation:'Strip'};
  await command('list');
  assert.equal(sent.length,2,'list merge to child must not inject main');
  await waitFor(()=>SessionManager.open(forkedFile).getBranch().some(e=>e.type==='custom_message'&&e.customType==='pi-btw-merge'));
  const mergedSource=SessionManager.open(forkedFile).getBranch().filter(e=>e.type==='custom_message'&&e.customType==='pi-btw-merge');
  assert.equal(mergedSource.length,1);assert.equal(mergedSource[0].details.mode,'conversation');
  assert.equal(await readFile(originalBtwFile,'utf8'),originalBtw,'merge must preserve original BTW');
  assert.equal(shownTab.id,1,'merge focuses the child target');
  listSelection={kind:'switch',id:0};
  await command('list');
  await command('merge');assert.match(notices.at(-1).message,/Select a BTW/);
  // Default close is applied only after delivery, removes the manifest item, and preserves the file.
  ctx.ui.custom=dialog;
  selection={destination:0,close:true,summary:false,conversation:'Full'};
  listSelection={kind:'switch',id:1};
  await command('list');
  await new Promise(r=>setTimeout(r,500));
  const deliver=pi.sendMessage;
  pi.sendMessage=()=>{throw new Error('delivery failed');};
  await command('merge');
  assert.match(notices.at(-1).message,/delivery failed/);
  assert.ok(JSON.parse(await readFile(workspaceFile(parent),'utf8')).tabs.some(tab=>tab.id===1));
  // Queue acceptance alone must NOT mark merged or close the source.
  let queued;
  pi.sendMessage=(message,options)=>{queued={message,options};sent.push(queued);};
  await command('list'); // reselect source after failed delivery left focus at main
  await command('merge');
  assert.equal(sent.length,3,JSON.stringify(notices));
  assert.match(notices.at(-1).message,/waiting for target receipt/);
  assert.ok(JSON.parse(await readFile(workspaceFile(parent),'utf8')).tabs.some(tab=>tab.id===1));
  await command('list');
  await command('merge');assert.equal(sent.length,3,'pending delivery prevents duplicate sends');
  parent.appendCustomMessageEntry(queued.message.customType,queued.message.content,true,queued.message.details);
  await new Promise(r=>setTimeout(r,650));
  pi.sendMessage=deliver;
  const afterClose=JSON.parse(await readFile(workspaceFile(parent),'utf8'));
  assert.ok(!afterClose.tabs.some(tab=>tab.id===1));
  assert.ok(afterClose.tabs.some(tab=>tab.id===2));
  assert.match(await readFile(forkedFile,'utf8'),/first question/);
  listSelection={kind:'switch',id:2};
  await command('list');
  listSelection={kind:'close',id:2};
  await command('list'); // close shortcut needs no confirmation interaction
  assert.equal(JSON.parse(await readFile(workspaceFile(parent),'utf8')).tabs.length,0);
  assert.equal(await readFile(originalBtwFile,'utf8'),originalBtw);
  await command('merge');assert.match(notices.at(-1).message,/Select a BTW/);
});

test('fork while a real parent SDK tool is running never waits for or aborts the parent', {timeout:30000}, async t => {
  const {parent,capture} = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => {release=resolve;});
  const started = new Promise(resolve => {entered=resolve;});
  const settingsManager = SettingsManager.inMemory(capture.settings);
  const resourceLoader = new DefaultResourceLoader({cwd:capture.cwd,agentDir:capture.agentDir,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,
    extensionFactories:[pi => pi.registerProvider(model.provider,{apiKey:'dummy',api:model.api,baseUrl:model.baseUrl,models:[model]})]});
  await resourceLoader.reload();
  const {session} = await createAgentSession({cwd:capture.cwd,agentDir:capture.agentDir,settingsManager,resourceLoader,sessionManager:parent,model,
    customTools:[{name:'gate',label:'gate',description:'hold a parent operation',parameters:{type:'object',properties:{}},execute:async () => {entered();await gate;return {content:[{type:'text',text:'parent completed'}],details:undefined};}}]});
  t.after(() => {release();session.dispose();});
  let calls=0;
  session.agent.streamFunction = (_model,context) => {
    const first=++calls===1;
    if (!first) assert.match(JSON.stringify(context.messages),/queued merge during main tool/,"merge must reach the very next API request");
    const message={role:'assistant',content:first?[{type:'toolCall',id:'running-parent-call',name:'gate',arguments:{}}]:[{type:'text',text:'parent done'}],api:model.api,provider:model.provider,model:model.id,
      usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};
    const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
  };
  const running=session.prompt('start parent tool');
  await started;
  const originalId=parent.getSessionId();
  const originalLeaf=parent.getLeafId();
  const snapshot=forkSnapshot(parent,capture.cwd);
  assert.equal(snapshot.pendingCount,1);
  const child=await startChild({...capture,...snapshot});
  t.after(() => child.session.dispose());
  await child.session.prompt('independent child question');
  assert.equal(session.isStreaming,true);
  assert.equal(parent.getSessionId(),originalId); assert.equal(parent.getLeafId(),originalLeaf);
  child.session.dispose();
  assert.equal(session.isStreaming,true);
  await session.sendCustomMessage({customType:'pi-btw-merge',content:'queued merge during main tool',display:true,details:{mergeId:'busy-main-receipt'}},{triggerTurn:true,deliverAs:'steer'});
  assert.equal(hasMergeReceipt(parent.getSessionFile(),'busy-main-receipt'),false,'queue acknowledgement is not delivery');
  release();await running;
  assert.equal(session.isStreaming,false);
  assert.equal(calls,2);
  assert.equal(hasMergeReceipt(parent.getSessionFile(),'busy-main-receipt'),true);
  assert.match(JSON.stringify(session.messages),/queued merge during main tool/);
});

test('nested BTW captures current child state, runs independently, and explicitly merges to source', {timeout:30000}, async t => {
  const {parent,capture}=await fixture(t);
  const first=await startChild(capture);t.after(()=>first.session.dispose());
  let updates=0;const off=first.session.observe(()=>updates++);t.after(off);
  await first.session.prompt('source conversation');
  const snapshot=await first.session.snapshot();
  assert.equal(snapshot.origin.parentId,first.manager.getSessionId());
  const second=await startChild(snapshot);t.after(()=>second.session.dispose());
  await second.session.prompt('nested question');
  assert.match(JSON.stringify(second.session.messages),/source conversation/);
  assert.match(JSON.stringify(second.session.messages),/nested question/);
  assert.doesNotMatch(JSON.stringify(first.session.messages),/nested question/);
  const message={customType:'pi-btw-merge',content:'explicit nested result',display:true};
  await first.session.merge(message);
  await waitFor(()=>JSON.stringify(first.session.messages).includes('explicit nested result') && !first.session.isStreaming);
  assert.match(JSON.stringify(first.session.messages),/explicit nested result/);
  assert.ok(updates>0);
  assert.doesNotMatch(await readFile(parent.getSessionFile(),'utf8'),/source conversation|nested question|explicit nested result/);
  first.session.dispose();
  await second.session.prompt('source closed but descendant still works');
  assert.match(JSON.stringify(second.session.messages),/source closed but descendant still works/);
});

test('workspace restores list lazily with same session, source, draft and merge state', {timeout:30000}, async t=>{
  const {parent,capture}=await fixture(t);
  const before=await readFile(parent.getSessionFile(),'utf8');
  const w=new Workspace();const first=await startChild(capture);
  await first.session.prompt('persisted conversation');
  const a=w.add(first);a.draft='unfinished draft';a.merged.set(0,'merged-leaf');
  const second=await startChild(await first.session.snapshot());const b=w.add(second);
  const file=workspaceFile(parent);saveWorkspace(file,parent.getSessionId(),w);
  const firstId=first.manager.getSessionId();w.dispose();await new Promise(r=>setTimeout(r,300));
  const interrupted=SessionManager.open(first.manager.getSessionFile());
  const lastAssistant=[...interrupted.buildSessionContext().messages].reverse().find(m=>m.role==='assistant');
  interrupted.appendMessage({...lastAssistant,content:[{type:'toolCall',id:'interrupted-call',name:'bash',arguments:{command:'echo SHOULD_NOT_REPLAY'}}],stopReason:'toolUse'});
  const restored=new Workspace();restoreWorkspace(file,parent.getSessionId(),restored);
  t.after(()=>restored.dispose());
  assert.equal(restored.current,0);assert.equal(restored.tabs.size,2);
  const ra=restored.tabs.get(a.id),rb=restored.tabs.get(b.id);
  assert.equal(rb.source,a.id);assert.equal(ra.draft,'unfinished draft');assert.equal(ra.merged.get(0),'merged-leaf');
  assert.equal(ra.child.session.dormant,true);assert.equal(rb.child.session.dormant,true);
  assert.equal(ra.child.manager.getSessionId(),firstId);
  assert.match(JSON.stringify(ra.child.session.messages),/persisted conversation/);
  await ra.child.session.prompt('after reload');
  assert.equal(ra.child.session.dormant,false);assert.equal(rb.child.session.dormant,true);
  assert.match(JSON.stringify(ra.child.session.messages),/after reload/);
  const sealed=ra.child.session.messages.find(m=>m.role==='toolResult'&&m.toolCallId==='interrupted-call');
  assert.equal(sealed.isError,true);assert.match(JSON.stringify(sealed),/NOT been replayed/);
  assert.equal(await readFile(parent.getSessionFile(),'utf8'),before);
  restored.close(a.id);saveWorkspace(file,parent.getSessionId(),restored);
  const again=new Workspace();restoreWorkspace(file,parent.getSessionId(),again);t.after(()=>again.dispose());
  assert.equal(again.tabs.size,1);assert.equal(again.tabs.get(b.id).source,a.id);
  assert.throws(()=>again.destination(again.tabs.get(b.id),'source'),/closed/);
  assert.throws(()=>restoreWorkspace(file,'different-parent',new Workspace()),/Invalid/);
});

test('prepared BTW is usable before startup; cancelling pending prompt does not send it', {timeout:30000}, async t=>{
  const {capture}=await fixture(t);
  const {prepareChild}=await import('../dist/child.js');
  const child=prepareChild(capture);t.after(()=>child.session.dispose());
  assert.equal(child.session.starting,true);
  assert.equal(child.session.dormant,true);
  assert.match(JSON.stringify(child.session.messages),/parent context/);
  const prompt=child.session.prompt('cancel before initialization');
  const cancelled=assert.rejects(prompt,/cancelled during startup/);
  await child.session.abort();await cancelled;
  assert.equal(child.session.starting,false);
  assert.doesNotMatch(JSON.stringify(child.session.messages),/cancel before initialization/);
  assert.ok(child.session.startupTimings.total>0);
});

test('merge dispatch returns before a slow target response, receipt still requires persistence', {timeout:30000}, async t=>{
  const {capture}=await fixture(t,1500);
  const child=await startChild(capture);t.after(()=>child.session.dispose());
  const start=performance.now();
  await child.session.merge({customType:'pi-btw-merge',content:'slow merge target',display:true,details:{mergeId:'slow-target'}});
  t.diagnostic(`merge dispatch: ${(performance.now()-start).toFixed(1)}ms`);
  assert.ok(!child.session.messages.some(m=>m.role==='assistant'),'dispatch must not wait for model response');
  await waitFor(()=>hasMergeReceipt(child.manager.getSessionFile(),'slow-target'));
  await waitFor(()=>child.session.messages.some(m=>m.role==='assistant')&&!child.session.isStreaming);
});

test('worker target retains queued merge after its running tool is aborted', {timeout:30000}, async t=>{
  const {capture}=await fixture(t);
  await writeFile(capture.extensionPaths[0], `import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
export default function(pi){
  pi.registerTool({name:'hold_merge',label:'hold',description:'abortable test barrier',parameters:{type:'object',properties:{}},async execute(_id,_args,signal){
    await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
    return {content:[{type:'text',text:'cancelled'}],details:undefined};
  }});
  pi.registerProvider('btw-test',{apiKey:'dummy',api:'openai-completions',baseUrl:'http://unused.invalid',models:[${JSON.stringify(model)}],streamSimple:(_model,_context,options)=>{
    const aborted=options?.signal?.aborted;
    const message={role:'assistant',content:aborted?[]:[{type:'toolCall',id:'held',name:'hold_merge',arguments:{}}],api:'openai-completions',provider:'btw-test',model:'btw-test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:aborted?'aborted':'toolUse',timestamp:Date.now()};
    const stream=createAssistantMessageEventStream();stream.push(aborted?{type:'error',reason:'aborted',error:message}:{type:'done',reason:'toolUse',message});stream.end();return stream;
  }});
}`);
  capture.tools.push('hold_merge');
  const child=await startChild(capture);t.after(()=>child.session.dispose());
  let entered=false;
  child.session.subscribe(event=>{if(event.type==='tool_execution_start'&&event.toolName==='hold_merge')entered=true;});
  const running=child.session.prompt('hold until stopped');await waitFor(()=>entered);
  const file=child.manager.getSessionFile();
  await child.session.merge({customType:'pi-btw-merge',content:'merge survives child abort',display:true,details:{mergeId:'worker-abort'}});
  assert.equal(hasMergeReceipt(file,'worker-abort'),false);
  await child.session.abort();await running;
  await waitFor(()=>hasMergeReceipt(file,'worker-abort')&&!child.session.isStreaming);
  const entries=SessionManager.open(file).getBranch();
  assert.equal(entries.filter(e=>e.type==='custom_message'&&e.details?.mergeId==='worker-abort').length,1);
  assert.equal(entries.filter(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='hold_merge').length,1);
});

test('missing inherited tool fails explicitly, without touching parent', {timeout:30000}, async t => {
  const {parent,capture} = await fixture(t);
  capture.tools.push('unavailable-parent-tool');
  const before = await readFile(parent.getSessionFile(), 'utf8');
  await assert.rejects(startChild(capture), /Cannot inherit active tools/);
  assert.equal(await readFile(parent.getSessionFile(), 'utf8'), before);
});

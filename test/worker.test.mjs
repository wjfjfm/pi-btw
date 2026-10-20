import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, createAgentSession, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { forkSnapshot } from '../dist/snapshot.js';
import { startChild } from '../dist/child.js';
import btw from '../dist/index.js';
import {Workspace} from '../dist/workspace.js';
import {saveWorkspace,restoreWorkspace,workspaceFile} from '../dist/persistence.js';

const model = {id:'btw-test',name:'btw-test',api:'openai-completions',provider:'btw-test',baseUrl:'http://unused.invalid',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-btw-worker-'));
  t.after(async () => { await new Promise(r => setTimeout(r, 150)); await rm(cwd, {recursive:true, force:true}); });
  const extension = join(cwd, 'provider.ts');
  await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi) {
  globalThis.__BTW_CHILD_SENTINEL = true;
  pi.registerProvider('btw-test', {apiKey:'dummy',api:'openai-completions',baseUrl:'http://unused.invalid',models:[${JSON.stringify(model)}],
    streamSimple: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        const message = {role:'assistant',content:[{type:'text',text:'child reply: '+JSON.stringify(context.messages)}],api:'openai-completions',provider:'btw-test',model:'btw-test',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
        stream.push({type:'done',reason:'stop',message}); stream.end();
      }, 80);
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
  const raw = await readFile(child.manager.getSessionFile(), 'utf8');
  assert.match(raw, /child reply/);
  assert.match(raw, /parent context/);
  assert.match(raw, /inherited system prompt/);
  assert.doesNotMatch(raw, /parent continues independently/);
  assert.doesNotMatch(await readFile(parent.getSessionFile(), 'utf8'), /BTW question|child reply/);
  assert.ok((await readFile(parent.getSessionFile(), 'utf8')).startsWith(before));
});

test('extension merges only explicitly, queues follow-up, prevents duplicates, and summarizes', {timeout:30000}, async t => {
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
    sendMessage:(message, options) => sent.push({message,options}),
  };
  let summaryRaw, selection;
  const choose=async (_title,choices)=>{
    assert.deepEqual(choices,['summary','conversation','summary with conversation','full conversation with thinking and toolcall']);
    return selection;
  };
  const ctx = {
    mode:'tui', cwd:capture.cwd, model, thinkingLevel:'off', scopedModels:[], sessionManager:parent,
    getSystemPrompt:() => capture.systemPrompt, isProjectTrusted:() => true,
    modelRegistry:{streamSimple:(_model, context) => {summaryRaw=JSON.stringify(context.messages);const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message:{stopReason:'stop',content:[{type:'text',text:'merged summary'}]}});stream.end();return stream;}},
    ui:{select:choose, custom:async () => {}, notify:(message,type) => notices.push({message,type})},
  };
  btw(pi); handlers.get('session_start')({}, ctx);
  t.after(() => handlers.get('session_shutdown')());
  const command = args => commands.get('btw')(args, ctx);
  assert.equal(sent.length, 0);
  await command('first question');
  await new Promise(r => setTimeout(r, 500));
  await command('merge');
  assert.equal(sent.length,0,'cancelling must not merge');
  selection='full conversation with thinking and toolcall';
  await command('merge');
  assert.equal(sent.length, 1, JSON.stringify(notices));
  assert.match(sent[0].message.content, /first question/);
  assert.equal(sent[0].options.deliverAs, 'followUp');
  assert.equal(sent[0].options.triggerTurn, true);
  await command('merge');
  assert.equal(sent.length, 1);
  assert.match(notices.at(-1).message, /already been merged/);
  await command('second question');
  await new Promise(r => setTimeout(r, 500));
  selection='summary';
  await command('merge');
  assert.equal(sent.length, 2, JSON.stringify(notices));
  assert.match(sent[1].message.content, /merged summary/);
  assert.match(summaryRaw, /second question/);
  ctx.ui.select=async (title,choices)=>{
    assert.equal(title,'BTW sessions');
    assert.deepEqual(choices,['main','└─ BTW 1 · source main · idle','   └─ BTW 2 · source 1 · idle']);
    return choices[0];
  };
  await command('list');
  await command('merge');
  assert.match(notices.at(-1).message,/Select a BTW/);
  ctx.ui.select=async (_title,choices)=>choices[1];
  await command('list');
  ctx.ui.select=choose;
  await command('merge');
  assert.match(notices.at(-1).message,/already been merged/);
  ctx.ui.select=async()=>undefined;
  await command('list');
  const count=sent.length;
  await command('merge');
  assert.equal(sent.length,count);
  await command('close');
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
  session.agent.streamFunction = () => {
    const first=++calls===1;
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
  release();await running;
  assert.equal(session.isStreaming,false);
  assert.equal(calls,2);
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
  for(let i=0;i<100 && first.session.isStreaming;i++)await new Promise(r=>setTimeout(r,20));
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

test('missing inherited tool fails explicitly, without touching parent', {timeout:30000}, async t => {
  const {parent,capture} = await fixture(t);
  capture.tools.push('unavailable-parent-tool');
  const before = await readFile(parent.getSessionFile(), 'utf8');
  await assert.rejects(startChild(capture), /Cannot inherit active tools/);
  assert.equal(await readFile(parent.getSessionFile(), 'utf8'), before);
});

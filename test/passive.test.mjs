import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import btw from '../dist/index.js';

test('unused BTW registers no model-facing hooks or tools', () => {
  const events=[],shortcuts=[];
  btw({on:name=>events.push(name),registerCommand:()=>{},registerShortcut:key=>shortcuts.push(key)});
  assert.deepEqual(shortcuts,[]);
  assert.deepEqual(events,['session_start','message_update','message_end','session_shutdown']);
});

test('real SDK model request is identical with unused BTW enabled or disabled', async t => {
  const cwd=await mkdtemp(join(tmpdir(),'pi-btw-passive-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const model={id:'passive',name:'passive',api:'openai-completions',provider:'passive',baseUrl:'http://unused.invalid',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  async function run(enabled) {
    const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
    const resourceLoader=new DefaultResourceLoader({cwd,agentDir:join(cwd,'agent'),settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,
      extensionFactories:[pi=>pi.registerProvider(model.provider,{apiKey:'dummy',api:model.api,baseUrl:model.baseUrl,models:[model]}),...(enabled?[btw]:[])]});
    await resourceLoader.reload();
    const manager=SessionManager.inMemory(cwd);
    const {session}=await createAgentSession({cwd,agentDir:join(cwd,'agent'),model,resourceLoader,settingsManager,sessionManager:manager});
    await session.bindExtensions({mode:'print'});
    let captured;
    session.agent.streamFunction=(_model,context)=>{
      captured=JSON.parse(JSON.stringify(context,(key,value)=>key==='timestamp'?undefined:value));
      const message={role:'assistant',content:[{type:'text',text:'normal reply'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:1};
      const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end();return stream;
    };
    try {await session.prompt('ordinary user question');return {captured,types:manager.getBranch().map(e=>e.type)};}
    finally {session.dispose();}
  }
  const baseline=await run(false);
  const enabled=await run(true);
  assert.deepEqual(enabled,baseline);
});

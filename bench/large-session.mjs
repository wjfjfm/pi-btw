// Synthetic, isolated benchmark. Never reads or modifies user sessions.
// npm run build && node bench/large-session.mjs [turns-per-half=500]
// BTW_BENCH_DIST=/absolute/path/to/dist selects a baseline build.
import {mkdtempSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SessionManager, initTheme} from '@earendil-works/pi-coding-agent';
const dist=process.env.BTW_BENCH_DIST || resolve('dist');
const load=name=>import(pathToFileURL(join(dist,name+'.js')).href);
const {forkSnapshot,rawConversation}=await load('snapshot');
const {prepareChild,ChildSession}=await load('child');
const {childPreview}=await load('preview');
const {mergeContent}=await load('merge');
const {BtwView}=await load('view');
const turns=Number(process.argv[2] || 500);
const dir=mkdtempSync(join(tmpdir(),'btw-large-bench-'));
const results={turnsPerHalf:turns};
async function measure(name,fn) {const t=performance.now(); const value=await fn(); results[name]=Math.round((performance.now()-t)*10)/10; console.log(name,results[name]+' ms'); return value;}
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const model={id:'bench',name:'bench',api:'openai-completions',provider:'bench',baseUrl:'http://unused.invalid',reasoning:false,input:['text'],contextWindow:1000000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
function fill(manager,start) {
  for(let i=start;i<start+turns;i++) {
    const base={role:'assistant',api:model.api,provider:model.provider,model:model.id,usage,timestamp:i};
    manager.appendMessage({role:'user',content:`Question ${i}: investigate query performance`,timestamp:i});
    manager.appendMessage({...base,stopReason:'toolUse',content:[{type:'thinking',thinking:'Inspect query plan and buffers. '.repeat(256)},{type:'toolCall',id:'call-'+i,name:'bash',arguments:{command:'explain query '+i}}]});
    manager.appendMessage({role:'toolResult',toolCallId:'call-'+i,toolName:'bash',content:[{type:'text',text:'query plan: scan rows buffers cost timing\n'.repeat(1200)}],isError:false,timestamp:i});
    manager.appendMessage({...base,stopReason:'stop',content:[{type:'text',text:`Result ${i}: `+'Use index lookup and verify rows. '.repeat(16)}]});
  }
}
let child;
try {
  const parent=SessionManager.create(dir,join(dir,'sessions'));
  await measure('construct',()=>fill(parent,0));
  const snapshot=await measure('forkSnapshot',()=>forkSnapshot(parent,dir));
  await measure('appendBranch',()=>fill(snapshot.manager,turns));
  results.fileMiB=Math.round(statSync(snapshot.manager.getSessionFile()).size/104857.6)/10;
  results.entries=snapshot.manager.getBranch().length;
  console.log('session',results.fileMiB+' MiB',results.entries+' entries');
  const extension=join(dir,'provider.ts');
  writeFileSync(extension,`import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
export default pi=>pi.registerProvider('bench',{apiKey:'dummy',api:'openai-completions',baseUrl:'http://unused.invalid',models:[${JSON.stringify(model)}],streamSimple:()=>{const s=createAssistantMessageEventStream();setTimeout(()=>{s.push({type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'done'}],api:'openai-completions',provider:'bench',model:'bench',usage:${JSON.stringify(usage)},stopReason:'stop',timestamp:Date.now()}});s.end();},1500);return s;}});`);
  const capture={...snapshot,cwd:dir,agentDir:join(dir,'agent'),model,thinkingLevel:'off',scopedModels:[],settings:{compaction:{enabled:false},retry:{enabled:false}},tools:[],extensionPaths:[extension],systemPrompt:'bench',trusted:true};
  child=await measure('prepareView',()=>{
    if (prepareChild) return prepareChild(capture);
    const value={...capture,session:new ChildSession(dir,{...capture,file:snapshot.manager.getSessionFile()})};
    value.session.messages=value.manager.buildSessionContext().messages;
    return value;
  });
  await measure('previewCold',()=>childPreview(child));
  await measure('previewRepeat20',()=>{for(let i=0;i<20;i++)childPreview(child);});
  initTheme('dark');
  const tui={terminal:{rows:40},requestRender:()=>{}};
  const view=new BtwView(tui,{fg:(_name,text)=>text},{id:1,source:0,draft:'',child},()=>{},async()=>{});
  await measure('renderCold',()=>view.render(160));
  await measure('renderRepeat20',()=>{for(let i=0;i<20;i++)view.render(160);});
  view.dispose();
  const raw=await measure('rawConversation',()=>rawConversation(snapshot.manager,snapshot.boundary));
  results.mergeMiB=Math.round(Buffer.byteLength(raw)/104857.6)/10;
  await measure('mergeStrip',()=>mergeContent(raw,'conversation',{}));
  await measure('workerStartup',()=>child.session.ensureStarted());
  results.startupPhases=child.session.startupTimings;
  await measure('mergeDispatch',()=>child.session.merge({customType:'pi-btw-merge',content:'synthetic benchmark result',display:true}));
  console.log(JSON.stringify(results,null,2));
} finally {child?.session.dispose(); await new Promise(r=>setTimeout(r,250)); rmSync(dir,{recursive:true,force:true});}

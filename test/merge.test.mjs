import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { mergeContent } from '../dist/merge.js';
import { prefixContent } from '../dist/transcript.js';
import { convertToLlm } from '@earendil-works/pi-coding-agent';

const raw = JSON.stringify({type:'message',id:'one',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:'Explore exact-path.ts',timestamp:1}});
function context(reason='stop', text='summary', inspect=()=>{}) {
  return {model:{id:'test',contextWindow:100000},modelRegistry:{streamSimple:(model, messages, options)=>{
    inspect(messages, options);
    const stream=createAssistantMessageEventStream();
    const message={role:'assistant',stopReason:reason,content:text?[{type:'text',text}]:[],errorMessage:reason==='error'?'test failure':undefined};
    stream.push(reason==='error'||reason==='aborted'?{type:'error',reason,error:message}:{type:'done',reason,message});
    stream.end();return stream;
  }}};
}
const textOf=value=>typeof value==='string'?value:value.filter(b=>b.type==='text').map(b=>b.text).join('\n');
test('full merge formats dialogue, strips storage metadata and makes no model call', async () => {
  const original=JSON.stringify({type:'message',id:'STORAGE_ID',parentId:'STORAGE_PARENT',timestamp:'STORAGE_TIME',message:{role:'assistant',content:[{type:'text',text:'原文\nexact'}],timestamp:123,model:'RUNTIME_MODEL',provider:'RUNTIME_PROVIDER',usage:{input:999}}});
  const result=await mergeContent(original,'full',{});
  assert.equal(result,'## Assistant\n\n原文\nexact');
  assert.doesNotMatch(result,/STORAGE_|RUNTIME_|parentId|timestamp|usage|\\\\n/);
});
test('summary plus Full uses the same readable transcript', async () => {
  const result=await mergeContent(raw,'summary-with-full',context());
  assert.match(result,/## Summary/);
  assert.ok(result.endsWith(await mergeContent(raw,'full',{})));
  assert.doesNotMatch(result,/parentId|timestamp|Conversation \\(JSONL\\)/);
});
test('summary uses native tree prompt, budget and abort signal', async () => {
  const controller = new AbortController();
  const ctx=context('stop','summary',(messages,options)=>{
    assert.match(JSON.stringify(messages),/Do NOT continue the conversation/);
    const prompt=JSON.stringify(messages.messages);
    assert.match(prompt, /<conversation>/);
    assert.match(prompt, /exact-path.ts/);
    assert.match(prompt, /Next Steps/);
    assert.equal(options.signal,controller.signal);
    assert.equal(options.cacheRetention,'none');
    assert.ok(options.maxTokens<=4096);
  });
  assert.match(await mergeContent(raw,'summary',ctx,controller.signal), /Summary of that exploration:[\s\S]*summary/);
});
for (const reason of ['error','aborted','length']) test('failed summary is not merged: '+reason, async () => {
  await assert.rejects(mergeContent(raw,'summary',context(reason)), /failure|aborted|length|truncat|complete/i);
});
test('four modes distinguish dialogue, summary and full reasoning/tool transcript', async()=>{
  const entries=[
    {type:'message',message:{role:'user',content:[{type:'text',text:'question'},{type:'image',mimeType:'image/png',data:'IMAGE_BASE64'}]}},
    {type:'message',message:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_REASONING'},{type:'text',text:'answer'},{type:'toolCall',id:'call',name:'bash',arguments:{command:'TOOL_ARGUMENTS'}}]}},
    {type:'message',message:{role:'toolResult',toolCallId:'call',toolName:'bash',content:[{type:'text',text:'TOOL_RESULT'}]}},
    {type:'custom_message',customType:'note',display:true,content:'visible note'},
    {type:'custom_message',customType:'hidden',display:false,content:'HIDDEN_NOTE'},
  ].map((entry,i)=>({...entry,id:String(i),parentId:i?String(i-1):null,timestamp:new Date().toISOString()}));
  const transcript=entries.map(e=>JSON.stringify(e)).join('\n');
  const dialogue=await mergeContent(transcript,'conversation',{});
  assert.match(textOf(dialogue),/question/);assert.match(textOf(dialogue),/answer/);assert.match(textOf(dialogue),/visible note/);
  assert.deepEqual(dialogue.filter(b=>b.type==='image'),[{type:'image',mimeType:'image/png',data:'IMAGE_BASE64'}]);
  assert.doesNotMatch(textOf(dialogue),/IMAGE_BASE64|PRIVATE_REASONING|TOOL_ARGUMENTS|TOOL_RESULT|HIDDEN_NOTE|toolCall|parentId|timestamp/);
  const full=await mergeContent(transcript,'full',{});
  assert.match(textOf(full),/Thinking[\s\S]*PRIVATE_REASONING/);
  assert.match(textOf(full),/Tool call #1: bash[\s\S]*TOOL_ARGUMENTS[\s\S]*Tool result #1: bash[\s\S]*TOOL_RESULT/);
  assert.match(textOf(full),/HIDDEN_NOTE/);
  assert.deepEqual(full.filter(b=>b.type==='image'),dialogue.filter(b=>b.type==='image'));
  const combined=await mergeContent(transcript,'summary-with-conversation',context('stop','SUMMARIZED'));
  assert.match(textOf(combined),/## Summary[\s\S]*SUMMARIZED[\s\S]*# Conversation/);
  assert.deepEqual(combined.slice(1),dialogue);
  const summary=await mergeContent(transcript,'summary',context('stop','SUMMARIZED'));
  assert.match(summary,/SUMMARIZED/);assert.doesNotMatch(summary,/IMAGE_BASE64|## Conversation/);
});
test('readable Full preserves tool associations, errors, summaries and code fences', async()=>{
  const entries=[
    {type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'opaque-A',name:'read',arguments:{path:'a'}},{type:'toolCall',id:'opaque-B',name:'read',arguments:{path:'b'}}]}},
    {type:'message',message:{role:'toolResult',toolCallId:'opaque-B',toolName:'read',isError:true,content:[{type:'text',text:'```\nmissing b\n```'}],details:{reason:'not found'}}},
    {type:'message',message:{role:'toolResult',toolCallId:'opaque-A',toolName:'read',content:[{type:'text',text:'contents a'}]}},
    {type:'message',message:{role:'assistant',content:[],stopReason:'aborted'}},
    {type:'branch_summary',summary:'branch summary body',fromId:'STORAGE_PARENT'},
    {type:'compaction',summary:'compaction body',tokensBefore:999999},
    {type:'message',message:{role:'system',content:'RUNTIME_SYSTEM_CONFIG'}},
  ];
  const result=await mergeContent(entries.map(e=>JSON.stringify(e)).join('\n'),'full',{});
  assert.match(result,/Tool call #1: read[\s\S]*Tool call #2: read[\s\S]*Tool result #2: read \(error\)[\s\S]*Tool result #1: read/);
  assert.ok(result.includes('````\n```\nmissing b\n```\n````'));
  assert.match(result,/Tool details[\s\S]*not found/);
  assert.match(result,/Response status: aborted/);
  assert.match(result,/branch summary body[\s\S]*compaction body/);
  assert.doesNotMatch(result,/opaque-A|opaque-B|STORAGE_PARENT|tokensBefore|RUNTIME_SYSTEM_CONFIG/);
});
test('images remain native image blocks in the actual model-facing custom message',async()=>{
  const raw=JSON.stringify({type:'message',message:{role:'user',content:[{type:'text',text:'before image'},{type:'image',mimeType:'image/png',data:'BASE64_PAYLOAD'},{type:'text',text:'after image'}]}});
  for(const mode of ['full','conversation','summary-with-full','summary-with-conversation']) {
    const payload=prefixContent('Quoted BTW history\n\n',await mergeContent(raw,mode,context()));
    const [message]=convertToLlm([{role:'custom',customType:'pi-btw-merge',content:payload,display:true,timestamp:1}]);
    assert.equal(message.role,'user');
    assert.deepEqual(message.content.filter(b=>b.type==='image'),[{type:'image',mimeType:'image/png',data:'BASE64_PAYLOAD'}]);
    assert.match(textOf(message.content),/before image[\s\S]*after image/);
    assert.doesNotMatch(textOf(message.content),/BASE64_PAYLOAD|parentId|timestamp/);
  }
});
test('empty summary and invalid merge requests are rejected', async () => {
  await assert.rejects(mergeContent(raw, 'summary', context('stop','')), /Empty summary/);
  await assert.rejects(mergeContent('', 'full', {}), /No BTW/);
  await assert.rejects(mergeContent(raw, 'other', {}), /Invalid merge mode/);
});

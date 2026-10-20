import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { mergeContent } from '../dist/merge.js';

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
test('full merge preserves exact raw contents and makes no model call', async () => {
  const original = '{"text":"原文\\nexact","image":"AAAA"}\n';
  assert.equal(await mergeContent(original, 'full', {}), original);
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
test('empty summary and invalid merge requests are rejected', async () => {
  await assert.rejects(mergeContent(raw, 'summary', context('stop','')), /Empty summary/);
  await assert.rejects(mergeContent('', 'full', {}), /No BTW/);
  await assert.rejects(mergeContent(raw, 'other', {}), /full\|summary/);
});

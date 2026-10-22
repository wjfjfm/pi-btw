import assert from 'node:assert/strict';
import {test} from 'node:test';
import {visibleWidth} from '@earendil-works/pi-tui';
import {MergeDialog,mergeMode} from '../dist/merge-dialog.js';
function fixture() {
  const results=[];
  const dialog=new MergeDialog({requestRender(){}},{fg:(_color,text)=>text},1,
    [{id:0,label:'main'},{id:2,label:'└─ BTW 2 中文摘要'}],0,value=>results.push(value));
  const key=(...keys)=>keys.forEach(k=>dialog.handleInput(k));
  return {dialog,key,results};
}
test('merge dialog defaults to OK and main/Yes/No/Strip, with Cancel next',()=>{
  const {dialog,key,results}=fixture();
  assert.match(dialog.render(80).join('\n'),/\[OK\]/);
  key('\r');
  assert.deepEqual(results,[{destination:0,close:true,summary:false,conversation:'Strip'}]);
  const cancelled=fixture();cancelled.key('\t','\r');
  assert.deepEqual(cancelled.results,[undefined]);
  const escaped=fixture();escaped.key('\x1b');assert.deepEqual(escaped.results,[undefined]);
});
test('fields cycle, invalid empty merge stays open, rendering fits narrow terminals',()=>{
  const {dialog,key,results}=fixture();
  key('\t','\t','\x1b[C'); // target BTW 2
  key('\t',' '); // close No
  key('\t',' ',' '); // summary Yes, then back to default No
  key('\t','\x1b[C'); // conversation None
  key('\t','\r'); // OK rejected
  assert.equal(results.length,0);
  assert.match(dialog.render(80).join('\n'),/Select Summary or Conversation/);
  key('\x1b[Z','\x1b[C'); // conversation Full
  key('\t','\r');
  assert.deepEqual(results,[{destination:2,close:false,summary:false,conversation:'Full'}]);
  for(const width of [1,10,32,76]) for(const line of dialog.render(width)) assert.ok(visibleWidth(line)<=width);
});
test('Merge to arrows show a plain name; Enter opens tree picker without confirming merge',()=>{
  const {dialog,key,results}=fixture();
  key('\t','\t','\x1b[C');
  let rendered=dialog.render(76).join('\n');
  assert.match(rendered,/Merge to:\s+BTW 2/);
  assert.doesNotMatch(rendered,/└─ BTW|中文摘要/);
  key('\r');
  rendered=dialog.render(76).join('\n');
  assert.match(rendered,/└─ BTW 2 中文摘要/);
  assert.match(rendered,/Enter select · Esc back/);
  assert.equal(dialog.picker.getSelectedItem().value,'2');
  key('\x1b[A','\x1b'); // move to main, cancel picker only
  assert.deepEqual(results,[]);
  assert.match(dialog.render(76).join('\n'),/Merge to:\s+BTW 2/);
  key('\r','\x1b[A','\r'); // choose main
  assert.deepEqual(results,[],'choosing a target does not merge');
  assert.match(dialog.render(76).join('\n'),/Merge to:\s+main/);
  key('\t','\t','\t','\t','\r'); // OK
  assert.deepEqual(results,[{destination:0,close:true,summary:false,conversation:'Strip'}]);
});
test('target picker scrolls through all targets and fits narrow widths',()=>{
  const results=[];
  const rows=[{id:0,label:'main'},...Array.from({length:30},(_,i)=>({id:i+2,label:`└─ BTW ${i+2} preview`}))];
  const dialog=new MergeDialog({requestRender(){}},{fg:(_color,text)=>text},1,rows,0,v=>results.push(v));
  for(const key of ['\t','\t','\r',...Array(30).fill('\x1b[B')])dialog.handleInput(key);
  assert.match(dialog.render(76).join('\n'),/BTW 31 preview/);
  for(const width of [1,10,32,76]) for(const line of dialog.render(width)) assert.ok(visibleWidth(line)<=width);
  dialog.handleInput('\r');
  assert.match(dialog.render(76).join('\n'),/Merge to:\s+BTW 31/);
  assert.deepEqual(results,[]);
});
test('all summary/conversation combinations map explicitly',()=>{
  for(const [summary,conversation,mode] of [[true,'Full','summary-with-full'],[true,'Strip','summary-with-conversation'],[true,'None','summary'],[false,'Full','full'],[false,'Strip','conversation']])
    assert.equal(mergeMode({summary,conversation}),mode);
  assert.throws(()=>mergeMode({summary:false,conversation:'None'}),/Select/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { BtwView } from '../dist/view.js';

function fixture(messages=[]) {
  initTheme('dark');
  const actions=[];let aborted=0,disposed=0,observer;
  const tui={terminal:{rows:24},requestRender:()=>{}};
  const session={isStreaming:false,messages,observe:fn=>{observer=fn;return()=>{disposed++;};},abort:async()=>{aborted++;}};
  const tab={id:2,source:1,draft:'draft',child:{cwd:'/tmp',session}};
  const view=new BtwView(tui,{fg:(_name,text)=>text},tab,a=>actions.push(a),async()=>{});
  return {view,tab,session,actions,changed:()=>observer(),counts:()=>({aborted,disposed})};
}
const assistant=(content,extra={})=>({role:'assistant',content,stopReason:'stop',timestamp:1,...extra});
test('native view fits terminal, preserves draft, and switches without cancelling',()=>{
  const f=fixture([{role:'user',content:'中文界面🙂 '.repeat(80)}]);
  f.view.focused=true;assert.equal(f.view.focused,true);
  for(const width of [12,40,120]){
    const lines=f.view.render(width);assert.equal(lines.length,24);
    for(const line of lines)assert.ok(visibleWidth(line)<=width);
  }
  f.view.handleInput('\x1b');assert.equal(f.actions.at(-1).kind,'main');assert.equal(f.tab.draft,'draft');
  f.view.handleInput('\x03');assert.equal(f.counts().aborted,1);
  f.view.dispose();assert.equal(f.counts().disposed,1);
});
test('native assistant displays fetch errors even without text, and renders streamed/final replies',()=>{
  const f=fixture([assistant([],{stopReason:'error',errorMessage:'fetch failed'})]);
  assert.match(f.view.render(100).join('\n'),/fetch failed/);
  f.session.partial=assistant([{type:'text',text:'**streamed reply**'}]);f.changed();
  let rendered=f.view.render(100).join('\n');assert.match(rendered,/streamed reply/);assert.doesNotMatch(rendered,/\*\*streamed reply\*\*/);
  f.session.partial=undefined;f.session.messages=[...f.session.messages,assistant([{type:'text',text:'final reply'}])];f.changed();
  assert.match(f.view.render(100).join('\n'),/final reply/);
  f.session.error='worker disconnected';f.changed();assert.match(f.view.render(100).join('\n'),/worker disconnected/);
  f.view.dispose();
});
test('bidirectional shortcuts and command-only close confirmation',()=>{
  const f=fixture();
  f.view.handleInput('\x02');assert.equal(f.actions.at(-1).kind,'prev');
  f.view.handleInput('\x06');assert.equal(f.actions.at(-1).kind,'next');
  const before=f.actions.length;
  for(const key of ['\x1b[110;7u','\x1b[109;7u','\x1b[120;7u'])f.view.handleInput(key);
  assert.equal(f.actions.length,before);
  f.view.showClose();const n=f.actions.length;f.view.handleInput('n');assert.equal(f.actions.length,n);
  f.view.showClose();f.view.handleInput('y');assert.equal(f.actions.at(-1).kind,'close');f.view.dispose();
});

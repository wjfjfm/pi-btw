import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { BtwView } from '../dist/view.js';

test('fullscreen view fits terminal, propagates focus and closes without aborting child', () => {
  initTheme('dark');
  let aborted=0, disposed=0, closed;
  const tui = {terminal:{rows:20},requestRender:() => {}};
  const child = {session:{isStreaming:true,messages:[{role:'user',content:'中文界面🙂 '.repeat(80)}],
    subscribe:() => () => {disposed++;},abort:async () => {aborted++;}}};
  const view = new BtwView(tui,{fg:(_name,text) => text},child,'draft',draft => {closed=draft;},async () => {});
  view.focused=true; assert.equal(view.focused,true);
  for (const width of [12,40,120]) {
    const lines=view.render(width);
    assert.equal(lines.length,20);
    for (const line of lines) assert.ok(visibleWidth(line)<=width);
  }
  view.handleInput('\u001b');
  assert.equal(closed,'draft'); assert.equal(aborted,0);
  view.handleInput('\u0003'); assert.equal(aborted,1);
  view.dispose(); assert.equal(disposed,1);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {visibleWidth} from '@earendil-works/pi-tui';
import {sessionPreview} from '../dist/preview.js';

const user=text=>({role:'user',content:text,timestamp:1});
test('preview contains first and latest own dialogue, not inherited history, reasoning or tools',()=>{
  const manager=SessionManager.inMemory('/tmp');
  manager.appendMessage(user('inherited parent question'));
  const boundary=manager.appendCustomEntry('origin',{});
  assert.deepEqual(sessionPreview(manager,boundary),['暂无新对话']);
  manager.appendMessage(user('first BTW question'));
  manager.appendMessage({role:'assistant',content:[{type:'thinking',thinking:'HIDDEN_THINKING'},{type:'text',text:'latest answer'},{type:'toolCall',id:'call',name:'bash',arguments:{command:'TOOL_ARGUMENTS'}}],timestamp:2});
  manager.appendMessage({role:'toolResult',toolCallId:'call',toolName:'bash',content:[{type:'text',text:'SECRET_RESULT'}],timestamp:3});
  const before=structuredClone(manager.getEntries());
  assert.deepEqual(sessionPreview(manager,boundary),['首：first BTW question','末：latest answer']);
  assert.deepEqual(manager.getEntries(),before);
  manager.appendMessage(user('new follow-up'));
  assert.deepEqual(sessionPreview(manager,boundary),['首：first BTW question','末：new follow-up']);
  assert.match(sessionPreview(manager)[0],/inherited parent question/);
});
test('preview sanitizes terminal controls, bounds wide text and handles missing boundary',()=>{
  const manager=SessionManager.inMemory('/tmp');
  manager.appendMessage(user('\x1b[31m中文\x1b[0m\n\t'+ '很长🙂'.repeat(100)));
  const preview=sessionPreview(manager);
  assert.equal(preview.length,2);
  for(const line of preview){assert.doesNotMatch(line,/[\x00-\x1f\x7f]/);assert.ok(visibleWidth(line)<=68);}
  assert.deepEqual(sessionPreview(manager,'missing'),['预览不可用：分支起点缺失']);
});

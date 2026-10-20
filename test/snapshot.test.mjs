import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { forkSnapshot, rawConversation } from '../dist/snapshot.js';

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-btw-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, parent: SessionManager.create(cwd, join(cwd, 'sessions')) };
}
const user = content => ({ role: 'user', content, timestamp: Date.now() });
const assistant = content => ({role:'assistant',content,api:'openai-completions',provider:'test',model:'test',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()});

test('native fork preserves projection, edits, labels and custom state without mutating parent', t => {
  const { cwd, parent } = setup(t);
  const first = parent.appendMessage(user('original'));
  parent.appendLabelChange(first, 'checkpoint');
  parent.appendCustomEntry('state', { nested: { value: 1 } });
  parent.appendCustomMessageEntry('goal', 'goal set: work', true);
  parent.appendContextEdit(first, { content: 'replacement' });
  const before = structuredClone(parent.getEntries());
  const leaf = parent.getLeafId();
  const fork = forkSnapshot(parent, cwd);
  assert.notEqual(fork.manager.getSessionId(), parent.getSessionId());
  assert.equal(fork.manager.getHeader().parentSession, parent.getSessionFile());
  assert.deepEqual(fork.manager.buildSessionContext().messages, parent.buildSessionContext().messages);
  assert.equal(fork.manager.getLabel(first), 'checkpoint');
  assert.deepEqual(parent.getEntries(), before);
  assert.equal(parent.getLeafId(), leaf);
  fork.manager.appendMessage(user('child only'));
  parent.appendMessage(user('parent only'));
  assert.doesNotMatch(JSON.stringify(parent.getEntries()), /child only/);
  assert.doesNotMatch(JSON.stringify(fork.manager.getEntries()), /parent only/);
});

test('compaction and branch selection are inherited, abandoned branch is excluded', t => {
  const { cwd, parent } = setup(t);
  const first = parent.appendMessage(user('old'));
  parent.appendMessage(user('abandoned'));
  parent.branch(first);
  const kept = parent.appendMessage(user('kept'));
  parent.appendCompaction('summary', kept, 1000);
  parent.appendMessage(user('recent'));
  const fork = forkSnapshot(parent, cwd);
  assert.deepEqual(fork.manager.buildSessionContext().messages, parent.buildSessionContext().messages);
  assert.doesNotMatch(JSON.stringify(fork.manager.getEntries()), /abandoned/);
});

test('unfinished calls get explicit snapshot errors only in child, partial stream is observational', t => {
  const { cwd, parent } = setup(t);
  parent.appendMessage(user('run tools'));
  parent.appendMessage(assistant([{type:'toolCall',id:'a',name:'bash',arguments:{command:'side effect'}},{type:'toolCall',id:'b',name:'read',arguments:{path:'x'}}]));
  parent.appendMessage({role:'toolResult',toolCallId:'b',toolName:'read',content:[{type:'text',text:'done'}],isError:false,timestamp:1});
  const before = readFileSync(parent.getSessionFile(), 'utf8');
  const fork = forkSnapshot(parent, cwd, {role:'assistant',content:[{type:'text',text:'partial'}],stopReason:'pending'});
  assert.equal(fork.pendingCount, 1);
  const error = fork.manager.buildSessionContext().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'a');
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /NOT executed or cancelled/);
  assert.equal(readFileSync(parent.getSessionFile(), 'utf8'), before);
  assert.match(JSON.stringify(fork.manager.getEntries()), /partial/);
});

test('empty streaming envelopes are not injected, but meaningful partial content is retained', t => {
  const {cwd,parent}=setup(t);
  parent.appendMessage(user('parent task'));
  const before=readFileSync(parent.getSessionFile(),'utf8');
  for(const content of [[],[{type:'thinking',thinking:''}],[{type:'text',text:'  '}],[{type:'thinking',thinking:'\n  '}]] ) {
    const fork=forkSnapshot(parent,cwd,{role:'assistant',content,stopReason:'pending',responseId:'empty-response'});
    assert.ok(!fork.manager.getEntries().some(e=>e.customType==='pi-btw-inflight'));
  }
  const meaningful=forkSnapshot(parent,cwd,{role:'assistant',content:[{type:'thinking',thinking:'work already in progress'}],stopReason:'pending'});
  assert.ok(meaningful.manager.getEntries().some(e=>e.customType==='pi-btw-inflight'));
  assert.equal(readFileSync(parent.getSessionFile(),'utf8'),before);
});

test('empty and unflushed in-memory sessions fork into durable independent files', t => {
  const { cwd } = setup(t);
  const parent = SessionManager.inMemory(cwd);
  const fork = forkSnapshot(parent, cwd, undefined, join(cwd, 'sessions'));
  assert.notEqual(parent.getSessionId(), fork.manager.getSessionId());
  assert.equal(SessionManager.open(fork.manager.getSessionFile()).getSessionId(), fork.manager.getSessionId());
  assert.equal(rawConversation(fork.manager, fork.boundary), '');
});

test('full merge keeps exact new messages, images and tool results despite context edits', t => {
  const { cwd, parent } = setup(t);
  parent.appendMessage(user('inherited'));
  const fork = forkSnapshot(parent, cwd);
  const content = [{type:'text',text:'exact\ntext'}, {type:'image',mimeType:'image/png',data:'AAAA'}];
  const id = fork.manager.appendMessage(user(content));
  fork.manager.appendContextEdit(id, null);
  const raw = rawConversation(fork.manager, fork.boundary);
  assert.deepEqual(JSON.parse(raw).message.content, content);
  assert.doesNotMatch(raw, /inherited/);
  assert.throws(() => rawConversation(fork.manager, 'missing'), /boundary/);
});

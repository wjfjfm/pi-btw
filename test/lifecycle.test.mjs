import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { ChildSession } from '../dist/child.js';
import btw from '../dist/index.js';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'btw-lifecycle-'));
  t.after(() => rmSync(cwd, {recursive:true,force:true}));
  initTheme('dark');
  // Exercise command orchestration without starting workers or making model calls.
  t.mock.method(ChildSession.prototype, 'ensureStarted', async () => {});
  t.mock.method(ChildSession.prototype, 'prompt', async function(text) {
    SessionManager.open(this.resumeConfig.file).appendMessage({role:'user',content:text,timestamp:Date.now()});
  });
  const handlers = new Map(), commands = new Map(), notices = [], sent = [], summaries = [];
  let options = {destination:0,close:false,summary:true,conversation:'None'};
  const shown = [];
  let listChoice, viewAction;
  const pi = {
    on:(name,handler) => handlers.set(name,handler),
    registerCommand:(name,command) => commands.set(name,command.handler),
    getSettings:() => ({}), getThinkingLevel:() => 'off', getActiveTools:() => [],
    getAllTools:() => [], getCommands:() => [],
    sendMessage(message) {
      sent.push(message);
      ctx.sessionManager.appendCustomMessageEntry(message.customType,message.content,true,message.details);
    },
  };
  const ctx = {
    mode:'tui',cwd,model:{contextWindow:100000,maxTokens:1000},scopedModels:[],
    getSystemPrompt:() => '',isProjectTrusted:() => true,
    modelRegistry:{streamSimple() {
      const stream = createAssistantMessageEventStream();
      summaries.push(() => {
        stream.push({type:'done',reason:'stop',message:{content:[{type:'text',text:'summary'}],stopReason:'stop'}});
        stream.end();
      });
      return stream;
    }},
    ui:{notify:message => notices.push(message),custom:async (factory,config) => {
      if (config?.overlayOptions?.width === 76) return options;
      if (!config) return listChoice;
      const panel = factory({terminal:{rows:24},requestRender(){}},{fg:(_name,text)=>text},undefined,()=>{});
      shown.push(panel.tab);
      panel.dispose();
      const action = viewAction; viewAction = undefined;
      return action;
    }},
  };
  btw(pi);
  const switchMain = () => {
    ctx.sessionManager = SessionManager.create(cwd,join(cwd,'sessions'));
    ctx.sessionManager.appendMessage({role:'user',content:'parent',timestamp:1});
    handlers.get('session_start')({},ctx);
  };
  switchMain();
  t.after(() => handlers.get('session_shutdown')());
  return {ctx,notices,sent,summaries,switchMain,shown,
    list:value => {listChoice=value;},
    viewAction:value => {viewAction=value;},
    command:args => commands.get('btw')(args,ctx),
    options:value => {options=value;}};
}

test('main merge leaves the source view before summary starts and retains source until receipt', async t => {
  const f = fixture(t);
  await f.command('source');
  const source = f.shown.at(-1), count = f.shown.length;
  f.options({destination:0,close:true,summary:true,conversation:'None'});
  await f.command('merge');
  assert.equal(f.shown.length,count,'source view must not reopen');
  assert.equal(f.summaries.length,0,'navigation precedes expensive merge work');
  assert.equal(source.child.session.closed,false);
  await nextTick();
  assert.equal(f.summaries.length,1);
  assert.equal(source.child.session.closed,false,'pending summary is not a receipt');
  f.summaries[0]();
  await nextTick();
  assert.equal(source.child.session.closed,true);
  assert.equal(f.shown.length,count,'receipt must not reopen any view');
  await f.command('merge');
  assert.match(f.notices.at(-1),/Select a BTW/,'focus is main');
});

test('child merge focuses target before summary and late completion respects Esc to main', async t => {
  const f = fixture(t);
  await f.command('target');
  const target = f.shown.at(-1);
  f.list({kind:'switch',id:0});
  await f.command('list');
  await f.command('source');
  const source = f.shown.at(-1);
  let message;
  t.mock.method(ChildSession.prototype,'merge',async function(value) {
    assert.equal(this,target.child.session);
    message=value;
    SessionManager.open(this.resumeConfig.file).appendCustomMessageEntry(value.customType,value.content,true,value.details);
  });
  f.options({destination:target.id,close:true,summary:true,conversation:'None'});
  f.viewAction({kind:'main'}); // Escape from the newly opened target while summary is pending.
  await f.command('merge');
  assert.equal(f.shown.at(-1),target);
  assert.equal(f.summaries.length,0);
  assert.equal(source.child.session.closed,false);
  const count=f.shown.length;
  await nextTick();
  f.summaries[0]();
  await nextTick();
  assert.ok(message);
  assert.equal(source.child.session.closed,true);
  assert.equal(f.shown.length,count,'late receipt cannot steal focus');
  await f.command('merge');
  assert.match(f.notices.at(-1),/Select a BTW/,'Escape remains effective after receipt');
});

test('old summary completion cannot unlock or notify a new main session', async t => {
  const f = fixture(t);
  await f.command('old branch');
  await f.command('merge');
  await nextTick();
  assert.equal(f.summaries.length,1);
  f.switchMain();
  await f.command('new branch');
  await f.command('merge');
  await nextTick();
  assert.equal(f.summaries.length,2,'reset releases the old operation lock immediately');
  const noticeCount = f.notices.length;
  f.summaries[0]();
  await nextTick();
  assert.equal(f.sent.length,0,'cancelled summary must not inject into new main');
  assert.equal(f.notices.length,noticeCount,'old failures must not notify new main');
  await f.command('close');
  assert.match(f.notices.at(-1),/operation in progress/,'old finally must not clear the new merge lock');
  f.summaries[1]();
  await nextTick();
  assert.equal(f.sent.length,1);
  await f.command('close');
  await f.command('merge');
  assert.match(f.notices.at(-1),/Select a BTW/);
});

test('startup failure from a disposed workspace does not notify the new main', async t => {
  const f = fixture(t);
  let reject;
  const startup = new Promise((_resolve,fail) => {reject=fail;});
  t.mock.method(ChildSession.prototype,'ensureStarted',() => startup);
  await f.command('new');
  f.switchMain();
  const noticeCount = f.notices.length;
  reject(new Error('old worker stopped'));
  await nextTick();
  assert.equal(f.notices.length,noticeCount);
});

test('merge dispatch returning after reset cannot register stale receipt monitoring', async t => {
  const f = fixture(t);
  let release;
  t.mock.method(ChildSession.prototype,'merge',() => new Promise(resolve => {release=resolve;}));
  t.mock.method(ChildSession.prototype,'snapshot',async function() {
    const {forkSnapshot} = await import('../dist/snapshot.js');
    return {...this.resumeConfig,...forkSnapshot(SessionManager.open(this.resumeConfig.file),f.ctx.cwd)};
  });
  await f.command('target');
  await f.command('source');
  f.options({destination:1,close:false,summary:false,conversation:'Strip'});
  await f.command('merge');
  await nextTick();
  assert.ok(release);
  f.switchMain();
  const noticeCount = f.notices.length;
  release();
  await nextTick();
  assert.equal(f.notices.length,noticeCount,'old dispatch must not report a queued merge in the new workspace');
  assert.equal(f.sent.length,0);
  await f.command('new branch');
  assert.match(f.notices.at(-1),/forked from main/);
});

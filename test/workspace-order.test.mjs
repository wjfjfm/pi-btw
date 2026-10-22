import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Workspace} from '../dist/workspace.js';
const child=time=>({origin:{createdAt:time},session:{lastActivity:0,preview:['preview'],dispose(){},closed:false}});
const ids=w=>w.listRows().map(row=>row.id);

test('new siblings first; activity lifts the whole ancestor chain and sorts each level',()=>{
  const w=new Workspace();
  const a=w.add(child(100),0),b=w.add(child(200),0),c=w.add(child(300),0);
  assert.deepEqual(ids(w),[0,c.id,b.id,a.id]);
  const a1=w.add(child(400),a.id),a2=w.add(child(500),a.id),b1=w.add(child(600),b.id);
  assert.deepEqual(ids(w),[0,b.id,b1.id,a.id,a2.id,a1.id,c.id]);
  const deep=w.add(child(700),a1.id);
  assert.deepEqual(ids(w),[0,a.id,a1.id,deep.id,a2.id,b.id,b1.id,c.id]);
  b1.child.session.lastActivity=800;
  assert.deepEqual(ids(w),[0,b.id,b1.id,a.id,a1.id,deep.id,a2.id,c.id]);
  a2.child.session.lastActivity=900;
  assert.deepEqual(ids(w),[0,a.id,a2.id,a1.id,deep.id,b.id,b1.id,c.id]);
  assert.equal(w.current,deep.id,'sorting does not change the selection');
});

test('equal timestamps use newest descendant ID and closed parents do not hide their trees',()=>{
  const w=new Workspace();
  const a=w.add(child(100),0),b=w.add(child(100),0),c=w.add(child(100),a.id),d=w.add(child(100),c.id);
  assert.deepEqual(ids(w),[0,a.id,c.id,d.id,b.id]);
  w.close(a.id);
  assert.deepEqual(ids(w),[0,c.id,d.id,b.id]);
  assert.match(w.listRows()[1].label,/source 1 \(closed\)/);
  w.tabs.get(c.id).source=d.id;
  assert.deepEqual(new Set(ids(w)),new Set([0,b.id,c.id,d.id]),'legacy cycles remain visible without infinite recursion');
});

test('restored/dormant workers use persisted file updates, without starting workers',t=>{
  const dir=mkdtempSync(join(tmpdir(),'btw-order-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const w=new Workspace();
  const add=(name,seconds)=>{
    const file=join(dir,name);writeFileSync(file,'');utimesSync(file,seconds,seconds);
    const value=child(1);value.session.dormant=true;value.manager={getSessionFile:()=>file};
    return {tab:w.add(value,0),file};
  };
  const a=add('a',40),b=add('b',20);
  assert.deepEqual(ids(w),[0,a.tab.id,b.tab.id]);
  utimesSync(b.file,50,50);
  assert.deepEqual(ids(w),[0,b.tab.id,a.tab.id]);
  a.tab.child.session.lastActivity=60000;
  assert.deepEqual(ids(w),[0,a.tab.id,b.tab.id]);
  assert.equal(a.tab.child.session.dormant,true);
});

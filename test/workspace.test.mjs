import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Workspace} from '../dist/workspace.js';

test('creation-order cycling includes main; closing source preserves descendants',()=>{
  const w=new Workspace();let disposed=0;
  const child=()=>({session:{dispose:()=>{disposed++;},closed:false}});
  const a=w.add(child());const b=w.add(child());w.current=0;const c=w.add(child());
  assert.equal(a.source,0);assert.equal(b.source,a.id);assert.equal(c.source,0);
  assert.equal(w.move(1),0);assert.equal(w.move(1),a.id);assert.equal(w.move(1),b.id);
  assert.equal(w.move(-1),a.id);assert.equal(w.move(-1),0);assert.equal(w.move(-1),c.id);
  assert.equal(w.destination(b,'source'),a.id);assert.equal(w.destination(b,'main'),0);
  w.current=a.id;w.close(a.id);assert.equal(w.current,0);assert.ok(w.tabs.has(b.id));assert.equal(disposed,1);
  assert.throws(()=>w.destination(b,'source'),/Source BTW is closed/);
  assert.equal(w.destination(b,'main'),0);
  assert.match(w.listRows().find(row=>row.id===b.id).label,/source 1 \(closed\)/);
  const d=w.add(child());assert.ok(d.id>c.id);
  w.dispose();assert.equal(disposed,4);assert.equal(w.current,0);
});

test('closing the current nested or later BTW returns to main, not the previous BTW',()=>{
  const w=new Workspace();
  const disposed=[];
  const child=id=>({session:{dispose(){disposed.push(id);},closed:false}});
  const a=w.add(child(1)),b=w.add(child(2)),c=w.add(child(3));
  w.close(c.id);
  assert.equal(w.current,0);assert.ok(w.tabs.has(a.id));assert.ok(w.tabs.has(b.id));
  w.current=b.id;
  w.close(a.id);assert.equal(w.current,b.id,'closing a background branch must not steal focus');
  w.close(b.id);assert.equal(w.current,0);
  assert.deepEqual(disposed,[3,1,2]);
});
test('list is a source tree rather than creation order and preserves ID selection',()=>{
  const w=new Workspace();
  const child=()=>({session:{dispose(){},closed:false,dormant:false,isStreaming:false}});
  const a=w.add(child(),0),b=w.add(child(),0),c=w.add(child(),a.id),d=w.add(child(),c.id);
  assert.deepEqual(w.listRows().map(row=>row.id),[0,a.id,c.id,d.id,b.id]);
  assert.match(w.listRows()[1].label,/^├─ BTW 1/);
  assert.match(w.listRows()[2].label,/^│  └─ BTW 3/);
  assert.match(w.listRows()[3].label,/^│     └─ BTW 4/);
  assert.match(w.listRows()[4].label,/^└─ BTW 2/);
});

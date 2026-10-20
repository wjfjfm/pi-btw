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
  const d=w.add(child());assert.ok(d.id>c.id);
  w.dispose();assert.equal(disposed,4);assert.equal(w.current,0);
});

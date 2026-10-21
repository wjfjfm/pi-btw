import assert from 'node:assert/strict';
import {test} from 'node:test';
import {visibleWidth} from '@earendil-works/pi-tui';
import {ListDialog} from '../dist/list-dialog.js';
const rows=[{id:0,label:'main',mergeable:false},{id:1,label:'BTW 1 中文 preview',mergeable:true},{id:2,label:'BTW 2 closed',mergeable:false}];
function fixture(current=1){
  const results=[];
  const dialog=new ListDialog({requestRender(){}},{fg:(_color,text)=>text},rows,current,x=>results.push(x));
  return {dialog,results};
}
test('list m merges highlighted BTW directly, Enter switches, Esc cancels',()=>{
  const {dialog,results}=fixture();
  assert.doesNotMatch(dialog.render(80).join('\n'),/Merge…/);
  assert.match(dialog.render(80).join('\n'),/m merge/);
  dialog.handleInput('m');assert.deepEqual(results,[{kind:'merge',id:1}]);
  const switched=fixture();switched.dialog.handleInput('\r');assert.deepEqual(switched.results,[{kind:'switch',id:1}]);
  const cancelled=fixture();cancelled.dialog.handleInput('\x1b');assert.deepEqual(cancelled.results,[undefined]);
});
test('c closes highlighted BTW directly, including closed workers, but never main',()=>{
  for(const id of [1,2]){
    const {dialog,results}=fixture(id);
    assert.match(dialog.render(100).join('\n'),/c close/);
    dialog.handleInput('c');
    assert.deepEqual(results,[{kind:'close',id}]);
  }
  const {dialog,results}=fixture(0);dialog.handleInput('c');
  assert.equal(results.length,0);assert.match(dialog.render(100).join('\n'),/Cannot close main/);
});
test('main and closed BTW cannot merge; arrow navigation changes source',()=>{
  const {dialog,results}=fixture(0);
  dialog.handleInput('m');assert.equal(results.length,0);
  assert.match(dialog.render(80).join('\n'),/Select an available BTW/);
  dialog.handleInput('\x1b[B');dialog.handleInput('m');assert.deepEqual(results,[{kind:'merge',id:1}]);
  const closed=fixture(2);closed.dialog.handleInput('m');assert.equal(closed.results.length,0);
  for(const width of [10,32,80])for(const line of dialog.render(width))assert.ok(visibleWidth(line)<=width);
});

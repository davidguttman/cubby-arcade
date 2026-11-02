const test=require('node:test'),assert=require('node:assert/strict');
const Hub=require('../runtime/core/hub.js');
test('grid is default and details are explicit hover/focus/tap selections',()=>{
 const store=new Map(),s=Hub.createState({getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)});
 assert.equal(s.view,'library');assert.equal(s.detail,null);
 s.show('store');s.select({id:'demo'});assert.equal(s.detail.id,'demo');
 s.favorite('demo');assert.equal(s.isFavorite('demo'),true);
 assert.equal(Hub.createState({getItem:k=>store.get(k)||null}).isFavorite('demo'),true);
 s.show('options');assert.equal(s.detail,null);assert.throws(()=>s.show('unknown'));
});

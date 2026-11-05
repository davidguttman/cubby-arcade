const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPlatform}=require('../runtime/core/platform.js');
const {SaveStore}=require('../desktop/host.cjs');
function storage(entries){const values=new Map(entries);return {values,get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,removeItem:k=>values.delete(k)};}
test('adult save management finds uninstalled namespaces and resets only the selected game',async()=>{
 const s=storage([['handheld:one:run','1'],['handheld:one:other','2'],['handheld:one-more:run','3'],['handheld:favorites:v1','[]'],['handheld:preferences:v1','{}'],['handheld:account:v1','{}'],['linecutter_run','{}']]);
 const p=createPlatform({storage:s,document:{}});
 assert.deepEqual(await p.savedGames(),['line-cutter','one','one-more']);
 await p.resetGameSaves('one');assert.equal(s.getItem('handheld:one:run'),null);assert.equal(s.getItem('handheld:one:other'),null);
 assert.equal(s.getItem('handheld:one-more:run'),'3');assert.equal(s.getItem('handheld:favorites:v1'),'[]');assert.equal(s.getItem('handheld:preferences:v1'),'{}');assert.equal(s.getItem('handheld:account:v1'),'{}');
 await p.resetGameSaves('line-cutter');assert.equal(s.getItem('linecutter_run'),null);
 for(const id of ['../one','preferences','favorites','account'])await assert.rejects(p.resetGameSaves(id));
});
test('native management combines browser legacy and disk saves without resurrection',async()=>{
 const s=storage([['linecutter_run','{"level":2}']]),disk=new Set(['line-cutter','uninstalled']);
 const p=createPlatform({storage:s,document:{},bridge:{savedGames:async()=>[...disk],resetGameSaves:async id=>disk.delete(id)}});
 assert.deepEqual(await p.savedGames(),['line-cutter','uninstalled']);await p.resetGameSaves('line-cutter');
 assert.equal(disk.has('line-cutter'),false);assert.equal(s.getItem('linecutter_run'),null);assert.equal(disk.has('uninstalled'),true);
});
test('reset errors are surfaced rather than claiming successful deletion',async()=>{
 const s=storage([['handheld:one:run','1']]);s.removeItem=()=>{throw Error('denied');};
 const p=createPlatform({storage:s,document:{}});await assert.rejects(p.resetGameSaves('one'),/denied/);
});
test('disk management enumerates saved games, preserves other games and rejects unsafe paths',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cubby-reset-'));
 try{const store=new SaveStore(root);store.set('one','run',1);store.set('two','run',2);
  assert.deepEqual(store.savedGames(),['one','two']);store.resetGameSaves('one');assert.equal(store.get('one','run'),null);assert.equal(store.get('two','run'),2);assert.deepEqual(store.savedGames(),['two']);
  assert.throws(()=>store.resetGameSaves('../two'));assert.throws(()=>store.resetGameSaves('CON'));
  fs.symlinkSync(path.join(root,'two'),path.join(root,'alias'));assert.throws(()=>store.resetGameSaves('alias'));assert.equal(store.get('two','run'),2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

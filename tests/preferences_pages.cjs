/* Execute real packaged pages, preserving one profile's remaps across navigation. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {DEFAULT_KEYBOARD,STORAGE_KEY}=require('../runtime/core/preferences.js');
function load(file){
 const keyboard={...DEFAULT_KEYBOARD,a:['KeyV'],exit:['KeyQ']},handlers={},presses=[];
 const noop=()=>{},context=new Proxy({}, {get:()=>noop});
 const canvas={getContext:()=>context,addEventListener:noop,removeEventListener:noop};
 const video={addEventListener:noop};
 const storage=new Map([[STORAGE_KEY,JSON.stringify({touchOverlay:'off',keyboard})],['linecutter_run','{"round":3}']]);
 const sandbox={document:{querySelector:s=>s==='video'?video:canvas,getElementById:()=>canvas,
   createElement:()=>({style:{},setAttribute:noop,appendChild:noop,addEventListener:noop,removeEventListener:noop}),
   body:{appendChild:noop},hasFocus:()=>true,hidden:false,visibilityState:'visible',addEventListener:noop,removeEventListener:noop},
  navigator:{},location:{href:''},innerWidth:640,innerHeight:480,performance:{now:()=>0},Image:class{},
  addEventListener:(n,f)=>(handlers[n]??=[]).push(f),removeEventListener:noop,requestAnimationFrame:noop,cancelAnimationFrame:noop,setInterval:noop,
  localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:()=>Promise.resolve({}),
  LineCutter:{create:()=>({wake:noop,stop:noop,press:k=>presses.push(k),_debug:()=>false,width:240,height:160,state:'title'})}};
 sandbox.window=sandbox;vm.createContext(sandbox);
 for(const script of ['preferences','input','platform','sdk','controls'])vm.runInContext(fs.readFileSync('runtime/core/'+script+'.js','utf8'),sandbox);
 for(const match of fs.readFileSync(file,'utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))vm.runInContext(match[1],sandbox);
 return {sandbox,presses,storage,press:code=>{for(const name of ['keydown','keyup'])(handlers[name]||[]).forEach(f=>f({code,preventDefault(){}}));}};
}
test('packaged title and gameplay read persisted mappings, reject old keys and preserve saves',()=>{
 const title=load('examples/line-cutter/index.html');title.press('KeyZ');assert.equal(title.sandbox.location.href,'');title.press('KeyV');assert.equal(title.sandbox.location.href,'play.html');
 const back=load('examples/line-cutter/index.html');back.press('Escape');assert.equal(back.sandbox.location.href,'');back.press('KeyQ');assert.equal(back.sandbox.location.href,'/');
 const game=load('examples/line-cutter/play.html');game.press('KeyZ');assert.deepEqual(game.presses,[]);game.press('KeyV');assert.deepEqual(game.presses,['a']);game.press('KeyQ');assert.equal(game.sandbox.location.href,'/');
 assert.equal(game.storage.get('linecutter_run'),'{"round":3}');
});

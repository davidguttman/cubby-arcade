const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createInput}=require('../runtime/core/input.js');
const {createPlatform}=require('../runtime/core/platform.js');
const {createGameHost}=require('../runtime/core/sdk.js');
function fixture(options={}){
  const listeners={},docListeners={},events=[];let pad=null,frame;
  const document={hidden:false,hasFocus:()=>true,addEventListener:(name,fn)=>(docListeners[name]??=[]).push(fn),removeEventListener:(name,fn)=>docListeners[name]=docListeners[name].filter(f=>f!==fn)};
  const target={addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn),removeEventListener:(name,fn)=>listeners[name]=listeners[name].filter(f=>f!==fn)};
  const input=createInput({...options,target,document,navigator:{getGamepads:()=>pad?[pad]:[]},requestFrame:fn=>(frame=fn,1),cancelFrame:()=>{},onAction:e=>events.push(e)});
  return {input,events,visibility:hidden=>{document.hidden=hidden;(docListeners.visibilitychange||[]).forEach(fn=>fn());},fire:(name,event={})=>(listeners[name]||[]).forEach(fn=>fn({preventDefault(){},...event})),
    frame:(buttons=[],axis=0,time=100)=>{pad=buttons===null?null:{index:0,id:'pad',buttons:Array.from({length:16},(_,i)=>({pressed:buttons.includes(i)})),axes:[axis,0]};frame(time)}};
}
test('navigation requires release; axes repeat; reconnect requires neutral; chord consumes shoulders',()=>{
  const f=fixture();f.frame([0]);f.frame([0]);assert.equal(f.events.length,0);
  f.frame([]);f.frame([0]);assert.equal(f.events[0].action,'confirm');f.frame([0]);assert.equal(f.events.length,1);
  f.frame([],0);f.frame([],0.7,200);assert.equal(f.events.at(-1).action,'right');
  f.frame([],0.7,250);assert.equal(f.events.length,2);f.frame([],0.7,400);assert.equal(f.events.length,3);
  f.frame(null);f.frame([0]);assert.equal(f.events.length,3);f.frame([]);f.frame([4,5]);assert.equal(f.events.at(-1).action,'exit');
  f.frame([4,5]);assert.equal(f.events.length,4);f.input.dispose();
});
test('keyboard repeat cannot activate next screen; blur resets; touch and teardown work',()=>{
  const f=fixture();f.fire('keydown',{code:'Enter',repeat:true});assert.equal(f.events.length,0);
  f.fire('keydown',{code:'KeyZ'});f.fire('keydown',{code:'KeyZ'});assert.equal(f.events.length,1);
  f.fire('blur');f.fire('keydown',{code:'KeyZ'});assert.equal(f.events.length,1);
  f.fire('focus');f.fire('keydown',{code:'KeyZ'});assert.equal(f.events.length,2);
  f.input.attachPointer({addEventListener:(_,fn)=>fn({preventDefault(){}}),removeEventListener(){}});
  assert.equal(f.events.at(-1).action,'confirm');f.input.dispose();f.fire('keydown',{code:'KeyX'});assert.equal(f.events.length,3);
});
test('controller stays inactive while blurred or hidden and requires release on return',()=>{
  const f=fixture();f.frame([]);f.fire('blur');f.frame([]);f.frame([0]);assert.equal(f.events.length,0);
  f.fire('focus');f.frame([0]);assert.equal(f.events.length,0);f.frame([]);f.frame([0]);assert.equal(f.events.length,1);
  f.visibility(true);f.frame([]);f.frame([0]);assert.equal(f.events.length,1);
  f.visibility(false);f.frame([0]);assert.equal(f.events.length,1);f.frame([]);f.frame([0]);assert.equal(f.events.length,2);
  f.input.dispose();
});
test('platform namespaces saves, isolates capabilities and loads one library contract',async()=>{
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  let url;const platform=createPlatform({storage,fetch:async u=>(url=u,{ok:true,json:async()=>[{id:'demo'}]}),document:{},kind:'web'});
  platform.saves('one').set('run',{score:3});assert.deepEqual(platform.saves('one').get('run'),{score:3});assert.equal(platform.saves('two').get('run'),null);
  values.set('linecutter_run','{"level":4}');assert.deepEqual(platform.saves('line-cutter',{run:'linecutter_run'}).get('run'),{level:4});
  assert.deepEqual(await platform.library(),[{id:'demo'}]);assert.equal(url,'/library');assert.equal(platform.capabilities.sleep,false);
  assert.throws(()=>platform.saves('../bad'));assert.throws(()=>platform.saves('one').set('a',undefined));
  await assert.rejects(()=>createPlatform({fetch:async()=>({ok:false}),document:{}}).library());
});
test('game host maps shared actions to legacy game buttons and disposes lifecycle',()=>{
  let callback,disposed=false,stopped=false;const presses=[];
  const host=createGameHost({platform:createPlatform({document:{}}),gameId:'demo',inputFactory:opts=>(callback=opts.onAction,{dispose(){disposed=true}}),onExit:()=>presses.push('exit')});
  host.start({press:b=>presses.push(b),wake(){},stop(){stopped=true}});
  callback({action:'confirm',button:'a'});callback({action:'pause',button:'start'});callback({action:'exit',button:'exit'});
  assert.deepEqual(presses,['a','start','exit']);host.dispose();assert.ok(disposed&&stopped);
});
test('native saves use game scope and explicitly migrate legacy aliases without deletion resurrection',()=>{
  const values=new Map([['linecutter_run','{"round":2}']]),disk=new Map();
  const platform=createPlatform({document:{},kind:'desktop',storage:{getItem:k=>values.get(k)??null,removeItem:k=>values.delete(k)},bridge:{saves:game=>({get:key=>disk.get(game+':'+key)??null,set:(key,value)=>disk.set(game+':'+key,value),remove:key=>disk.delete(game+':'+key)})}});
  const saves=platform.saves('line-cutter',{run:'linecutter_run'});
  assert.equal(platform.kind,'desktop');assert.equal(platform.capabilities.saves,true);
  assert.deepEqual(saves.get('run'),{round:2});assert.deepEqual(disk.get('line-cutter:run'),{round:2});
  saves.set('run',{round:3});assert.deepEqual(saves.get('run'),{round:3});
  assert.equal(platform.saves('other').get('run'),null);assert.throws(()=>saves.set('../bad',1));
  saves.remove('run');assert.equal(saves.get('run'),null);
});
test('game host suspends and resumes execution on host focus transitions and removes listeners',()=>{
  const handlers={},calls=[];
  const target={addEventListener:(n,f)=>handlers[n]=f,removeEventListener:n=>delete handlers[n]};
  const host=createGameHost({target,platform:createPlatform({document:{}}),gameId:'demo',inputFactory:()=>({dispose(){}})});
  host.start({stop:()=>calls.push('stop'),start:()=>calls.push('start'),wake:()=>calls.push('wake')});
  handlers.blur();handlers.blur();handlers.focus();assert.deepEqual(calls,['wake','stop','start','wake']);
  host.dispose();assert.deepEqual(Object.keys(handlers),[]);
});

test('system menu pauses SDK game and focus cannot resume underneath it',()=>{
 const handlers={},calls=[];const target={addEventListener:(n,f)=>handlers[n]=f,removeEventListener:n=>delete handlers[n]};
 const host=createGameHost({target,platform:createPlatform({document:{}}),gameId:'demo',inputFactory:()=>({dispose(){}})});
 host.start({stop:()=>calls.push('stop'),start:()=>calls.push('start'),wake:()=>calls.push('wake')});
 handlers['handheld:system-menu']({detail:{open:true}});handlers.focus();assert.deepEqual(calls,['wake','stop']);
 handlers['handheld:system-menu']({detail:{open:false}});assert.deepEqual(calls,['wake','stop','start','wake']);host.dispose();
});

test('hub shoulders wrap views through discrete edges and latch after menu chord',()=>{
 const f=fixture({navigationShoulders:true});f.frame([]);f.frame([5]);assert.equal(f.events.at(-1).action,'nextView');
 f.frame([5]);assert.equal(f.events.length,1);f.frame([]);f.frame([4]);assert.equal(f.events.at(-1).action,'previousView');
 f.frame([4,5]);assert.equal(f.events.at(-1).action,'exit');const count=f.events.length;
 f.frame([5]);f.frame([4]);assert.equal(f.events.length,count);f.frame([]);f.frame([5]);assert.equal(f.events.at(-1).action,'nextView');
 f.frame(null);f.frame([4]);assert.equal(f.events.at(-1).action,'nextView');f.frame([]);f.frame([4]);assert.equal(f.events.at(-1).action,'previousView');
 const cancel=f.input.captureKeyboard(()=>{});const captured=f.events.length;f.frame([]);f.frame([5]);assert.equal(f.events.length,captured);cancel();
 f.input.dispose();
 const game=fixture();game.frame([]);game.frame([5]);assert.equal(game.events.length,0);game.input.dispose();
});
test('quit is only advertised by platforms with native support',async()=>{
 const web=createPlatform({document:{}});assert.equal(web.capabilities.quit,false);assert.equal(web.quit,undefined);
 let count=0;const desktop=createPlatform({document:{},bridge:{quit:async()=>++count}});assert.equal(desktop.capabilities.quit,true);await desktop.quit();assert.equal(count,1);
});

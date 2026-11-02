const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPreferences,DEFAULT_KEYBOARD}=require('../runtime/core/preferences.js');
const {createInput}=require('../runtime/core/input.js');
function memory(){const entries=new Map();return {getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v)};}
function fixture(preferences){
 const listeners={},events=[];let frame;
 const target={addEventListener:(n,f)=>(listeners[n]??=[]).push(f),removeEventListener:(n,f)=>listeners[n]=listeners[n].filter(x=>x!==f)};
 const input=createInput({preferences,target,document:{hasFocus:()=>true,addEventListener(){},removeEventListener(){}},navigator:{},requestFrame:f=>(frame=f,1),cancelFrame(){},onAction:e=>events.push(e.button)});
 return {input,events,fire:(n,e={})=>(listeners[n]||[]).forEach(f=>f({preventDefault(){},...e}))};
}
test('preferences persist/reload, validate all mappings atomically and do not touch saves',()=>{
 const storage=memory();storage.setItem('linecutter_run','{"round":3}');
 const p=createPreferences({storage}),keyboard=p.get().keyboard;keyboard.exit=['KeyQ'];
 p.set({touchOverlay:'off',keyboard});
 const loaded=createPreferences({storage});assert.equal(loaded.get().touchOverlay,'off');assert.deepEqual(loaded.get().keyboard.exit,['KeyQ']);
 const external=loaded.get();external.keyboard.a.push('KeyQ');assert.deepEqual(loaded.get().keyboard.a,DEFAULT_KEYBOARD.a);
 for(const bad of [{touchOverlay:'maybe'},{keyboard:{a:['KeyQ']}},{keyboard:{...keyboard,exit:['KeyZ']}},{keyboard:{...keyboard,exit:['not a code']}}])assert.throws(()=>loaded.set(bad));
 assert.deepEqual(loaded.get().keyboard.exit,['KeyQ']);loaded.reset();assert.deepEqual(loaded.get().keyboard,DEFAULT_KEYBOARD);assert.equal(loaded.get().touchOverlay,'auto');
 assert.equal(storage.getItem('linecutter_run'),'{"round":3}');
});
test('invalid persisted data falls back, unavailable storage remains usable',()=>{
 assert.equal(createPreferences({storage:{getItem:()=>'{broken'}}).get().touchOverlay,'auto');
 const p=createPreferences({storage:{getItem(){throw Error()},setItem(){throw Error()}}});p.set({touchOverlay:'on'});assert.equal(p.get().touchOverlay,'on');
});
test('draft remapping supports cancel/apply/reset without mutating preferences early',()=>{
 const p=createPreferences({storage:memory()}),edit=p.editKeyboard();edit.setBinding('exit',['KeyQ']);assert.deepEqual(p.get().keyboard.exit,['Escape']);edit.cancel();assert.throws(()=>edit.apply());
 const next=p.editKeyboard();next.setBinding('exit',['KeyQ']);next.apply();assert.deepEqual(p.get().keyboard.exit,['KeyQ']);
 const reset=p.editKeyboard();reset.reset();reset.apply();assert.deepEqual(p.get().keyboard,DEFAULT_KEYBOARD);
});
test('live remapping routes every button, latches held keys, preserves repeat/focus and capture safety',()=>{
 const p=createPreferences({storage:memory()}),f=fixture(p);
 f.fire('keydown',{code:'Enter',repeat:true});f.fire('keydown',{code:'ArrowRight',repeat:true});f.fire('keydown',{code:'ArrowRight',repeat:true});assert.deepEqual(f.events,[]);
 f.fire('keydown',{code:'KeyZ'});const keyboard=Object.fromEntries(Object.keys(DEFAULT_KEYBOARD).map((button,i)=>[button,['F'+(i+1)]]));
 p.set({keyboard});f.fire('keydown',{code:'KeyZ',repeat:true});assert.deepEqual(f.events,['a']);f.fire('keyup',{code:'KeyZ'});
 Object.entries(keyboard).forEach(([button,[code]])=>{f.fire('keydown',{code});f.fire('keyup',{code});});assert.deepEqual(f.events.slice(1),Object.keys(DEFAULT_KEYBOARD));
 let captured;const cancel=f.input.captureKeyboard(code=>captured=code);f.fire('keydown',{code:'F1'});assert.equal(captured,'F1');cancel();f.fire('keydown',{code:'F1',repeat:true});assert.equal(f.events.length,10);f.fire('keyup',{code:'F1'});f.fire('keydown',{code:'F1'});assert.equal(f.events.at(-1),'up');
 f.fire('blur');f.fire('keydown',{code:'F2'});assert.equal(f.events.at(-1),'up');f.fire('focus');f.fire('keydown',{code:'F2',repeat:true});assert.equal(f.events.at(-1),'up');f.fire('keyup',{code:'F2'});f.fire('keydown',{code:'F2'});assert.equal(f.events.at(-1),'down');f.input.dispose();
});
test('touch auto is off on desktop, on with touch or coarse pointer; overrides and subscriptions react',()=>{
 const p=createPreferences({storage:memory()}),values=[];const unsubscribe=p.subscribe(value=>values.push(value.touchOverlay));
 assert.equal(p.showTouchControls({navigator:{},matchMedia:()=>({matches:false})}),false);
 assert.equal(p.showTouchControls({navigator:{maxTouchPoints:1}}),true);assert.equal(p.showTouchControls({matchMedia:()=>({matches:true})}),true);
 p.set({touchOverlay:'on'});assert.equal(p.showTouchControls({navigator:{}}),true);p.set({touchOverlay:'off'});assert.equal(p.showTouchControls({navigator:{maxTouchPoints:1}}),false);
 unsubscribe();p.reset();assert.deepEqual(values,['on','off']);
});
test('fresh key presses recover stale remap and capture blocks after blur without accepting repeats',()=>{
 const p=createPreferences({storage:memory()}),f=fixture(p);
 f.fire('keydown',{code:'ArrowUp'});p.set({touchOverlay:'on'});
 f.fire('blur');f.fire('focus');
 f.fire('keydown',{code:'ArrowUp',repeat:true});assert.deepEqual(f.events,['up']);
 f.fire('keydown',{code:'ArrowUp',repeat:false});assert.deepEqual(f.events,['up','up']);
 f.fire('keyup',{code:'ArrowUp'});
 const cancel=f.input.captureKeyboard(()=>{});f.fire('keydown',{code:'KeyZ'});cancel();
 f.fire('blur');f.fire('focus');
 f.fire('keydown',{code:'KeyZ',repeat:true});assert.deepEqual(f.events,['up','up']);
 f.fire('keydown',{code:'KeyZ',repeat:false});assert.deepEqual(f.events,['up','up','a']);
 f.input.dispose();
});
test('same-origin storage updates notify live input and clear invalid/removed preferences',()=>{
 const storage=memory(),handlers={};const p=createPreferences({storage,target:{addEventListener:(n,f)=>handlers[n]=f,removeEventListener:n=>delete handlers[n]}}),f=fixture(p);
 const keyboard=p.get().keyboard;keyboard.exit=['KeyQ'];
 handlers.storage({key:require('../runtime/core/preferences.js').STORAGE_KEY,newValue:JSON.stringify({keyboard,touchOverlay:'off'}),storageArea:storage});
 f.fire('keydown',{code:'Escape'});assert.deepEqual(f.events,[]);f.fire('keydown',{code:'KeyQ'});assert.deepEqual(f.events,['exit']);f.fire('keyup',{code:'KeyQ'});
 handlers.storage({key:null,storageArea:storage});assert.equal(p.get().touchOverlay,'auto');f.fire('keydown',{code:'Escape'});assert.deepEqual(f.events,['exit','exit']);
 f.input.dispose();p.dispose();assert.deepEqual(handlers,{});
});
test('real overlay reacts to preferences/media changes and cleans subscriptions',()=>{
 const fs=require('node:fs'),vm=require('node:vm');let bar,mediaUpdate,removed=false,coarse=false;
 const p=createPreferences({storage:memory()});const media={get matches(){return coarse},addEventListener:(n,f)=>mediaUpdate=f,removeEventListener:()=>mediaUpdate=null};
 const sandbox={navigator:{maxTouchPoints:0},matchMedia:()=>media,document:{createElement:()=>({style:{},setAttribute(){},appendChild(){},remove(){removed=true}}),body:{appendChild:node=>bar=node}}};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync('runtime/core/controls.js','utf8'),sandbox);
 const remove=sandbox.HandheldControls.createControls({preferences:p,attachPointer(){}},'game');assert.equal(bar.hidden,true);assert.equal(bar.style.display,'none');
 p.set({touchOverlay:'on'});assert.equal(bar.hidden,false);p.set({touchOverlay:'auto'});coarse=true;mediaUpdate();assert.equal(bar.hidden,false);
 remove();assert.equal(removed,true);assert.equal(mediaUpdate,null);p.set({touchOverlay:'off'});assert.equal(bar.hidden,false);
});

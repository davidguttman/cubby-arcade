const test=require('node:test'),assert=require('node:assert/strict');
const {createDevice,install,completeTouches}=require('../runtime/core/host-osd.js');
test('virtual controller is neutral immediately; multiple pointers hold and release independent buttons',()=>{
 const device=createDevice(()=>[]);assert.equal(device.getGamepads()[0].buttons.some(b=>b.pressed),false);
 device.press(1,'up');device.press(2,'a');device.press(3,'a');
 assert.equal(device.getGamepads()[0].buttons[12].pressed,true);assert.equal(device.getGamepads()[0].buttons[0].pressed,true);
 device.release(2);assert.equal(device.getGamepads()[0].buttons[0].pressed,true);
 device.release(3);assert.equal(device.getGamepads()[0].buttons[0].pressed,false);
 device.reset();assert.equal(device.getGamepads()[0].buttons.some(b=>b.pressed),false);
});
test('physical controller and virtual input share one stable standard pad without hiding other hardware',()=>{
 const physical={id:'USB',index:0,mapping:'standard',connected:true,buttons:Array.from({length:17},(_,i)=>({pressed:i===1,touched:false,value:i===1?1:0})),axes:[.7,0,0,0]};
 const second={id:'other',index:2};const device=createDevice(()=>[physical,null,second]);
 device.press(1,'x');const pads=device.getGamepads();assert.equal(pads[0].id,'USB');assert.equal(pads[0].index,0);assert.equal(pads[0].buttons[1].pressed,true);assert.equal(pads[0].buttons[2].pressed,true);assert.equal(pads[0].axes[0],.7);assert.equal(pads[2],second);
 device.reset();assert.equal(device.getGamepads()[0],physical);assert.equal(physical.buttons[2].pressed,false);
});
function environment(){
 const listeners={};const docListeners={};const attrs=new Map();
 const body={appendChild(){}};const doc={readyState:'loading',hidden:false,hasFocus:()=>true,body,documentElement:{setAttribute:(n,v)=>attrs.set(n,v),removeAttribute:n=>attrs.delete(n)},addEventListener:(n,f)=>(docListeners[n]??=[]).push(f),removeEventListener(){}};
 const original=()=>[];const win={document:doc,navigator:{getGamepads:original},location:{pathname:'/games/test/play.html'},addEventListener:(n,f)=>(listeners[n]??=[]).push(f),removeEventListener(){},HandheldPreferences:{preferences:{showTouchControls:()=>true,subscribe:()=>()=>{}}}};
 return {win,original,fire:(n,e={})=>{const event={type:n,preventDefault(){},stopImmediatePropagation(){this.stopped=true;},...e};for(const f of listeners[n]||[]){f(event);if(event.stopped)break;}},hidden:()=>{doc.hidden=true;(docListeners.visibilitychange||[]).forEach(f=>f());}};
}
test('host gate suppresses unchanged bundled controls; virtual buttons do not depend on keyboard remaps',()=>{
 const f=environment(),osd=install(f.win);f.win.HandheldControls={createControls(){throw Error('game overlay mounted');}};
 assert.doesNotThrow(()=>f.win.HandheldControls.createControls({},'game')());
 osd.device.press(1,'a');assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,true);
 f.fire('handheld:system-menu',{detail:{open:true}});assert.equal(f.win.navigator.getGamepads()[0].buttons.some(b=>b.pressed),false);
 f.fire('handheld:system-menu',{detail:{open:false}});osd.device.press(2,'l');f.fire('blur');assert.equal(f.win.navigator.getGamepads()[0].buttons[4].pressed,false);
 osd.device.press(3,'r');f.hidden();assert.equal(f.win.navigator.getGamepads()[0].buttons[5].pressed,false);
 osd.dispose();assert.equal(f.win.navigator.getGamepads,f.original);
});

function mountedEnvironment(embedded=false){
 const f=environment(),frames=new Map();let next=0;if(embedded)f.win.CubbyHandheldEmbed={};
 f.win.requestAnimationFrame=callback=>{frames.set(++next,callback);return next;};f.win.cancelAnimationFrame=id=>frames.delete(id);
 const element=tag=>({tag,dataset:{},attributes:{},children:[],style:{},hidden:false,setAttribute(n,v){this.attributes[n]=v;},appendChild(node){this.children.push(node);},remove(){},setPointerCapture(){},attachShadow(){this.shadowRoot=element('shadow');return this.shadowRoot;},querySelectorAll(){const all=[];function walk(n){if(n.tag==='button')all.push(n);n.children.forEach(walk);}walk(this);return all;}});
 f.win.document.createElement=element;f.win.document.body.appendChild=node=>{if(node.id==='cubby-host-osd')f.host=node;};f.win.document.readyState='complete';
 f.frame=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback());};
 f.osd=install(f.win);f.buttons=f.osd.root.querySelectorAll('button');f.pointer=(type,name,id=1)=>{const button=f.buttons.find(b=>b.dataset.button===name);f.fire(type,{pointerId:id,composedPath:()=>[button,...f.win.document.body.children||[],f.host]});};
 return f;
}

test('short OSD taps survive gamepad polling, while cancellation and menu/focus boundaries release immediately',()=>{
 const f=mountedEnvironment();let gamePointerA=false;f.win.addEventListener('pointerdown',()=>gamePointerA=true);
 f.pointer('pointerdown','a');f.pointer('pointerup','a');f.pointer('lostpointercapture','a');
 assert.equal(gamePointerA,false,'host events must not leak into global game pointer handlers');
 assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,true);
 f.frame();assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,true);
 f.frame();assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,false);
 f.pointer('pointerdown','up',2);f.pointer('pointerdown','b',3);
 f.pointer('pointercancel','up',2);assert.equal(f.win.navigator.getGamepads()[0].buttons[12].pressed,false);assert.equal(f.win.navigator.getGamepads()[0].buttons[1].pressed,true);
 f.fire('handheld:system-menu',{detail:{open:true}});assert.equal(f.win.navigator.getGamepads()[0].buttons.some(b=>b.pressed),false);
 f.pointer('pointerdown','a');assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,false);
 f.fire('handheld:system-menu',{detail:{open:false}});f.pointer('pointerdown','r');f.fire('blur');assert.equal(f.win.navigator.getGamepads()[0].buttons[5].pressed,false);
 f.osd.dispose();
});
test('nonstandard hardware is preserved as a separate device, never mislabeled as standard buttons',()=>{
 const raw={id:'custom',index:0,mapping:'',connected:true,timestamp:7,buttons:[{pressed:true,value:1,touched:true}],axes:[.8]};
 const d=createDevice(()=>[raw]);d.press(1,'r');const pads=d.getGamepads();
 assert.equal(pads[0].mapping,'standard');assert.equal(pads[0].buttons[5].pressed,true);assert.equal(pads[0].buttons[0].pressed,false);
 assert.equal(pads[1].id,'custom');assert.equal(pads[1].buttons,raw.buttons);assert.equal(pads[1].axes,raw.axes);assert.equal(raw.index,0);
});
test('BFCache pagehide releases input but preserves the controller for pageshow; normal pagehide disposes it',()=>{
 const f=mountedEnvironment();f.win.HandheldOSD=f.osd;
 const host=f.host,provider=f.win.navigator.getGamepads;
 f.pointer('pointerdown','a');assert.equal(provider()[0].buttons[0].pressed,true);
 f.fire('pagehide',{persisted:true});
 assert.equal(f.win.HandheldOSD,f.osd);assert.equal(f.win.navigator.getGamepads,provider);
 assert.equal(provider()[0].buttons.some(b=>b.pressed),false);
 f.fire('pageshow',{persisted:true});
 assert.equal(f.osd.root,host.shadowRoot);
 f.pointer('pointerdown','b',2);assert.equal(provider()[0].buttons[1].pressed,true);
 f.fire('pagehide',{persisted:false});
 assert.equal(f.win.HandheldOSD,undefined);assert.equal(f.win.navigator.getGamepads,f.original);
});

test('an embedded physical handheld keeps the host gate but does not mount a visible second deck',()=>{
 const f=mountedEnvironment(true);assert.equal(f.host.hidden,true);
 f.win.HandheldControls={createControls(){throw Error('legacy game deck mounted');}};
 assert.doesNotThrow(()=>f.win.HandheldControls.createControls({},'game')());
 f.pointer('pointerdown','a');assert.equal(f.win.navigator.getGamepads()[0].buttons.some(b=>b.pressed),false);f.osd.dispose();
});

// A fake window that dispatches to capture listeners, as the browser would.
function touchWindow(){
 const ls={};let clock=0;
 const win={performance:{now:()=>clock},addEventListener:(t,f)=>(ls[t]??=[]).push(f),removeEventListener(){},
  Event:class{constructor(type){this.type=type;}},PointerEvent:class{constructor(type,init){Object.assign(this,{type},init);}},
  dispatchEvent(e){for(const f of ls[e.type]||[])f(e);}};
 const target={isConnected:true,dispatchEvent:e=>win.dispatchEvent(e)};
 const seen=[];for(const t of ['pointerdown','pointerup'])win.addEventListener(t,e=>seen.push(t+(e.cubbyCompleted?'*':'')));
 const send=(type,extra={})=>win.dispatchEvent({type,isTrusted:true,target,button:0,detail:type==='click'?1:0,clientX:10,clientY:20,pointerId:1,...extra});
 return {win,seen,send,tick:ms=>{clock+=ms;}};
}
test('a tap on the handheld browser (pointerdown once, then only mouse events) becomes a press and a release every time',()=>{
 const f=touchWindow(),listen=(t,type,fn,c)=>t.addEventListener(type,fn,c);completeTouches(f.win,listen);
 // First tap: the browser's own pointerdown, then mouse events, never a pointerup.
 f.send('pointerdown');f.tick(5);f.send('mousedown');f.tick(80);f.send('mouseup');f.send('click');
 assert.deepEqual(f.seen,['pointerdown','pointerup*']);
 // Later taps: no pointer events at all.
 f.seen.length=0;f.tick(2000);f.send('mousedown');f.tick(80);f.send('mouseup');f.send('click');
 f.tick(700);f.send('mousedown');f.send('mouseup');
 assert.deepEqual(f.seen,['pointerdown*','pointerup*','pointerdown*','pointerup*']);
});
test('browsers that send their own pointer events get nothing extra, including a phone\'s late mouse events after a touch',()=>{
 const f=touchWindow(),listen=(t,type,fn,c)=>t.addEventListener(type,fn,c);completeTouches(f.win,listen);
 f.send('pointerdown');f.send('mousedown');f.tick(60);f.send('pointerup');f.send('mouseup');f.send('click');   // desktop mouse
 f.tick(2000);f.send('pointerdown',{pointerType:'touch'});f.tick(400);f.send('pointerup');f.tick(300);f.send('mousedown');f.send('mouseup');   // phone: late compatibility events
 f.tick(2000);f.send('mousedown',{button:2});f.send('mouseup',{button:2});   // a right click is not a tap
 assert.deepEqual(f.seen,['pointerdown','pointerup','pointerdown','pointerup']);
});

test('a tap that brings only a click is a whole tap; keyboard clicks are not',()=>{
 const f=touchWindow(),listen=(t,type,fn,c)=>t.addEventListener(type,fn,c);completeTouches(f.win,listen);
 f.send('pointerdown');f.tick(600);f.send('click');   // the first tap: the browser's own pointerdown, then a click
 f.tick(2000);f.send('click');f.tick(2000);f.send('click');
 f.tick(2000);f.send('click',{detail:0});   // Enter on a focused button
 assert.deepEqual(f.seen,['pointerdown','pointerup*','pointerdown*','pointerup*','pointerdown*','pointerup*']);
});

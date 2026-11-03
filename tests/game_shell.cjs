const test=require('node:test'),assert=require('node:assert/strict');
const {install}=require('../runtime/core/game-shell.js');
function harness(){
 const events={},nodes={};let frame;
 const doc={readyState:'complete',hidden:false,hasFocus:()=>true,createElement(tag){return {tag,style:{},hidden:false,setAttribute(){},appendChild(n){},addEventListener(){},focus(){},remove(){}};},body:{appendChild(n){nodes.menu=n;}}};
 const pads=[{buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]}];
 const env={document:doc,navigator:{getGamepads:()=>pads},location:{pathname:'/games/demo/main.html',href:''},addEventListener(n,f){(events[n]??=[]).push(f);},removeEventListener(){},requestAnimationFrame(f){frame=f;return 1;},cancelAnimationFrame(){},dispatchEvent(e){(events[e.type]||[]).forEach(f=>f(e));},CustomEvent:class{constructor(type,o){this.type=type;this.detail=o?.detail;}},setTimeout:f=>f()};
 function key(code){let stopped=false;const e={code,repeat:false,preventDefault(){},stopImmediatePropagation(){stopped=true;}};(events.keydown||[]).forEach(f=>f(e));return stopped;}
 const shell=install(env);return {shell,env,pads,key,poll:()=>frame(0)};
}
test('a non-SDK game has Escape menu, resume and library exit',()=>{const h=harness();assert.equal(h.key('Escape'),true);assert.equal(h.shell.isOpen(),true);h.key('Enter');assert.equal(h.shell.isOpen(),false);h.key('Escape');h.key('ArrowRight');h.key('Enter');assert.equal(h.env.location.href,'/');});
test('controller shortcut masks game input until neutral; menu confirm cannot leak',()=>{const h=harness();h.poll();h.pads[0].buttons[8].pressed=h.pads[0].buttons[9].pressed=true;h.poll();assert.equal(h.shell.isOpen(),true);assert.equal(h.env.navigator.getGamepads()[0].buttons.some(b=>b.pressed),false);h.pads[0].buttons[8].pressed=h.pads[0].buttons[9].pressed=false;h.poll();h.pads[0].buttons[0].pressed=true;h.poll();assert.equal(h.shell.isOpen(),false);assert.equal(h.env.navigator.getGamepads()[0].buttons.some(b=>b.pressed),false);h.pads[0].buttons[0].pressed=false;h.poll();h.pads[0].buttons[0].pressed=true;assert.equal(h.env.navigator.getGamepads()[0].buttons[0].pressed,true);});
test('touch opening and cancellation use the same system menu',()=>{const h=harness();h.shell.open();assert.equal(h.shell.isOpen(),true);h.shell.resume();assert.equal(h.shell.isOpen(),false);});

test('configured exit key works for a game without an input adapter',()=>{const h=harness();h.env.HandheldPreferences={preferences:{get:()=>({keyboard:{exit:['F10']}})}};assert.equal(h.key('F10'),true);assert.equal(h.shell.isOpen(),true);h.key('F10');assert.equal(h.shell.isOpen(),false);});

test('browser system-menu return stays in arcade demo while native return stays at hub root',()=>{
 for(const protocol of ['https:', 'http:', 'hub:']){
  const h=harness();h.env.location.protocol=protocol;h.key('Escape');h.key('ArrowRight');h.key('Enter');
  assert.equal(h.env.location.href,protocol==='hub:'?'/':'/play');
 }
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {install,configuration}=require('../runtime/core/handheld-embed.js');
const {install:installOSD}=require('../runtime/core/host-osd.js');
const {createGameHost}=require('../runtime/core/sdk.js');
function installHost(win){const embed=install(win);win.CubbyHandheldEmbed=embed;win.HandheldOSD=installOSD(win);return embed;}
function fixture(search='?embed=handheld&parentOrigin=https%3A%2F%2Fdavid.app',saved){
 const messages=[],storage=saved||new Map(),frames=new Map();let sequence=0,time=0,nativeHidden=false;
 class Document extends EventTarget {get hidden(){return nativeHidden;}}
 const doc=new Document();doc.readyState='loading';doc.hasFocus=()=>false;doc.documentElement={setAttribute(){},removeAttribute(){}};doc.querySelectorAll=()=>[];
 const win=new EventTarget();const parent={postMessage:(data,origin)=>messages.push({data,origin})};
 Object.assign(win,{document:doc,parent,navigator:{getGamepads:()=>[]},location:{search},sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},performance:{now:()=>time},requestAnimationFrame:fn=>{frames.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>frames.delete(id),Event,CustomEvent:class extends Event{constructor(type,options){super(type);this.detail=options?.detail;}},setTimeout,clearTimeout});
 const send=(data,origin='https://david.app',source=parent)=>{const e=new Event('message');Object.assign(e,{data:{type:'cubby:embed:v1',...data},origin,source});win.dispatchEvent(e);};
 return {win,doc,send,messages,storage,setNativeHidden(value){nativeHidden=value;doc.dispatchEvent(new Event('visibilitychange'));},frame(t){time=t;const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn(t));}};
}
test('embed is opt-in, validates parent origin and survives package navigation',()=>{
 const f=fixture();assert.deepEqual(configuration(f.win),{parentOrigin:'https://david.app'});
 const next=fixture('',f.storage);assert.deepEqual(configuration(next.win),{parentOrigin:'https://david.app'});
 for(const origin of ['https://evil.test','https://david.app.evil.test','http://david.app','https://foo.davidguttman.jump.sh.evil.test'])assert.equal(configuration(fixture('?embed=handheld&parentOrigin='+encodeURIComponent(origin)).win),null);
 assert.equal(configuration(fixture('').win),null);
 for(const origin of ['https://cubbyarcade.com','https://www.cubbyarcade.com','https://cubby.david.app'])assert.deepEqual(configuration(fixture('?embed=handheld&parentOrigin='+encodeURIComponent(origin)).win),{parentOrigin:origin});
 for(const origin of ['http://cubbyarcade.com','https://cubbyarcade.com.evil.test','https://evil.cubbyarcade.com'])assert.equal(configuration(fixture('?embed=handheld&parentOrigin='+encodeURIComponent(origin)).win),null);
 const top=fixture();top.win.parent=top.win;assert.equal(configuration(top.win),null);
});
test('only bound parent can activate or drive the standard virtual controller',()=>{
 const f=fixture();installHost(f.win);assert.equal(f.messages[0].data.event,'ready');assert.equal(f.messages[0].origin,'https://david.app');
 f.send({event:'active',active:true},'https://evil.test');assert.equal(f.doc.hidden,true);
 f.send({event:'active',active:true},'https://david.app',{});assert.equal(f.doc.hidden,true);
 f.send({event:'active',active:true});assert.equal(f.doc.hidden,false);assert.equal(f.doc.hasFocus(),true);
 f.send({event:'button',button:'a',down:true});assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,true);
 f.send({event:'button',button:'a',down:false});f.frame(16);f.frame(32);assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,false);
 f.send({event:'button',button:'toString',down:true});f.send({event:'button',button:'a',down:'true'});assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,false);
 f.send({event:'button',button:'right',down:true});f.send({event:'active',active:false});assert.equal(f.win.navigator.getGamepads()[0].buttons[15].pressed,false);
 f.send({event:'button',button:'a',down:true});assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,false);
});
test('embedded controller composes physical buttons and axes with virtual input and neutralizes every device while inactive',()=>{
 const f=fixture();
 const physical={id:'USB pad',index:0,mapping:'standard',connected:true,timestamp:9,buttons:Array.from({length:17},(_,i)=>({pressed:i===0,touched:i===0,value:i===0?1:0})),axes:[.75,-.5,0,0]};
 const other={id:'Other pad',index:1,mapping:'',connected:true,timestamp:7,buttons:[{pressed:true,touched:true,value:1}],axes:[-.8]};
 f.win.navigator.getGamepads=()=>[physical,other];installHost(f.win);
 const neutral=()=>{for(const pad of f.win.navigator.getGamepads().filter(Boolean)){assert.ok(pad.buttons.every(b=>!b.pressed&&!b.touched&&b.value===0));assert.ok(pad.axes.every(axis=>axis===0));}};
 neutral();f.send({event:'active',active:true});
 let pads=f.win.navigator.getGamepads();assert.equal(pads[0].id,'USB pad');assert.equal(pads[0].buttons[0].pressed,true);assert.deepEqual(pads[0].axes,[.75,-.5,0,0]);assert.equal(pads[1].id,'Other pad');
 f.send({event:'button',button:'b',down:true});pads=f.win.navigator.getGamepads();assert.equal(pads[0].buttons[0].pressed,true);assert.equal(pads[0].buttons[1].pressed,true);assert.deepEqual(pads[0].axes,[.75,-.5,0,0]);assert.equal(physical.buttons[1].pressed,false);
 f.send({event:'active',active:false});neutral();assert.equal(physical.buttons[0].pressed,true);assert.equal(other.axes[0],-.8);
 f.send({event:'active',active:true});pads=f.win.navigator.getGamepads();assert.equal(pads[0].buttons[0].pressed,true);assert.equal(pads[0].buttons[1].pressed,false);
});
test('inactive embed freezes animation and resumes without a catch-up timestamp',()=>{
 const f=fixture();installHost(f.win);const seen=[];f.win.requestAnimationFrame(t=>seen.push(t));f.frame(100);assert.deepEqual(seen,[]);
 f.send({event:'active',active:true});f.frame(120);assert.deepEqual(seen,[20]);
 f.win.requestAnimationFrame(t=>seen.push(t));f.frame(140);f.send({event:'active',active:false});f.win.requestAnimationFrame(t=>seen.push(t));f.frame(1000);assert.deepEqual(seen,[20,40]);
 f.send({event:'active',active:true});f.frame(1020);assert.deepEqual(seen,[20,40,60]);
});
test('moving focus from the iframe to the physical handheld does not freeze an active SDK game',()=>{
 const f=fixture();installHost(f.win);f.send({event:'active',active:true});
 let running=true,stops=0;
 const host=createGameHost({target:f.win,document:f.doc,platform:{saves:()=>({})},gameId:'focus-regression',inputFactory:()=>({dispose(){}})});
 host.start({press(){},release(){},stop(){running=false;stops++;},start(){running=true;},wake(){}});
 f.win.dispatchEvent(new Event('blur'));
 assert.equal(running,true,'clicking the parent handheld controls must not stop the game');
 assert.equal(stops,0);
 f.send({event:'active',active:false});assert.equal(running,false,'leaving the handheld still suspends the game');
 f.send({event:'active',active:true});assert.equal(running,true,'re-entering resumes the game');
 f.setNativeHidden(true);assert.equal(running,false,'a hidden browser tab still suspends the game');
 let hiddenBlur=false;f.win.addEventListener('blur',()=>{hiddenBlur=true;});f.win.dispatchEvent(new Event('blur'));assert.equal(hiddenBlur,true,'native hidden-tab blur is not suppressed');
 f.setNativeHidden(false);assert.equal(running,true,'returning to the visible tab resumes the game');
 host.dispose();
});
test('embedded focus policy preserves descendant element blur handlers',()=>{
 const f=fixture(),listen=f.win.addEventListener.bind(f.win);let capture;
 f.win.addEventListener=(type,callback,options)=>{if(type==='blur'&&options===true)capture=callback;listen(type,callback,options);};
 installHost(f.win);f.send({event:'active',active:true});
 // EventTarget has no DOM ancestry: exercise the window capture phase with a
 // descendant target, as a browser does when focus moves between form controls.
 let stopped=false;capture({target:{},stopImmediatePropagation(){stopped=true;}});
 assert.equal(stopped,false,'descendant blur must reach its own listeners');
 capture({target:f.win,stopImmediatePropagation(){stopped=true;}});
 assert.equal(stopped,true,'only iframe window blur is reserved by the embed');
});
test('audio contexts and playing media are suspended and inactive play cannot leak',async()=>{
 const f=fixture();let suspended=0,resumed=0,plays=0,pauses=0;
 f.win.AudioContext=class {constructor(){this.state='running';}suspend(){suspended++;this.state='suspended';return Promise.resolve();}resume(){resumed++;this.state='running';return Promise.resolve();}};
 f.win.HTMLMediaElement=class {constructor(){this.paused=true;this.ended=false;}play(){plays++;this.paused=false;return Promise.resolve();}pause(){pauses++;this.paused=true;}};
 const media=new f.win.HTMLMediaElement();f.doc.querySelectorAll=()=>[media];installHost(f.win);const context=new f.win.AudioContext();await context.resume();await media.play();assert.equal(plays,0);assert.ok(suspended);assert.equal(resumed,0);
 f.send({event:'active',active:true});await Promise.resolve();assert.equal(resumed,1);assert.equal(plays,1);
 f.send({event:'active',active:false});assert.equal(media.paused,true);assert.ok(pauses);await context.resume();assert.equal(resumed,1);
});

test('active audio resume and media play report autoplay rejection without swallowing it',async()=>{
 const f=fixture(),error=new DOMException('A direct gesture is required','NotAllowedError');
 f.win.AudioContext=class {constructor(){this.state='suspended';}suspend(){return Promise.resolve();}resume(){return Promise.reject(error);}};
 f.win.HTMLMediaElement=class {play(){return Promise.reject(error);}pause(){}};
 installHost(f.win);f.send({event:'active',active:true});
 await assert.rejects(new f.win.AudioContext().resume(),failure=>failure===error);
 assert.deepEqual(f.messages.map(message=>message.data.event),['ready','audio-blocked']);
 await assert.rejects(new f.win.HTMLMediaElement().play(),failure=>failure===error);
 assert.deepEqual(f.messages.map(message=>message.data.event),['ready','audio-blocked','audio-blocked']);
 assert.ok(f.messages.every(message=>message.origin==='https://david.app'));
});

test('a quick semantic tap survives a poll, and an old release cannot lift a fresh hold',()=>{
 const f=fixture();installHost(f.win);f.send({event:'active',active:true});
 f.send({event:'button',button:'a',down:true});f.send({event:'button',button:'a',down:false});
 assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,true);f.frame(16);assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,true);f.frame(32);assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,false);
 f.send({event:'button',button:'a',down:true});f.send({event:'button',button:'a',down:false});f.send({event:'button',button:'a',down:true});f.frame(48);f.frame(64);assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,true);
 f.send({event:'active',active:false});assert.equal(f.win.navigator.getGamepads()[0].buttons[0].pressed,false);
});

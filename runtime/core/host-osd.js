/* Cubby-owned virtual USB-style controller. Never included in game packages. */
(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
 else {root.HandheldHostOSD=api;root.HandheldOSD=api.install(root);}
})(globalThis,function(){
 'use strict';
 const indices={a:0,b:1,x:2,y:3,l:4,r:5,select:8,start:9,up:12,down:13,left:14,right:15};
 const calibrationKey='cubby:controller-labels:v1',labels=['A','B','X','Y'],idleMs=10000;
 const controllerKey=pad=>JSON.stringify([pad.id,pad.mapping,pad.buttons.length,pad.axes.length]);
 // Gamepad attributes are native prototype getters: copy explicitly, not with spread.
 function copyPad(pad,buttons=pad.buttons,axes=pad.axes){return {id:pad.id,index:pad.index,mapping:pad.mapping,connected:pad.connected,timestamp:pad.timestamp,buttons,axes,vibrationActuator:pad.vibrationActuator,hapticActuators:pad.hapticActuators,pose:pad.pose};}
 const held=pad=>Array.from(pad.buttons).flatMap((b,i)=>b.pressed||b.value>.5?[i]:[]);
 // Only the left stick steers. Other axes may rest at -1 or +1 (triggers, hats).
 const still=pad=>!held(pad).length&&[0,1].every(i=>Math.abs(pad.axes[i]||0)<.5);
 // Only the left stick steers. Other axes may rest at -1 or +1 (triggers, hats).
 const released=()=>({pressed:false,touched:false,value:0}),pressed=()=>({pressed:true,touched:true,value:1});
 // A pad the browser could not map ('' mapping) reports raw indices. Turn it into a
 // standard pad so the hub, the game shell and every game's own input read it as one:
 // faces 0-3 (or the calibrated ones), Select, Start, the d-pad and the left stick.
 // Defaults follow what Chromium does for the same layouts:
 //  - 11 buttons: Linux xpad/joydev order, Select 6, Start 7, d-pad hat on axes 6/7.
 //  - 15 buttons: macOS 360Controller order, Start 8, Back 9, d-pad buttons 11-14.
 //  - otherwise: Select 8, Start 9, d-pad buttons 12-15 if there are that many.
 // A d-pad reported as one HID hat axis (8 directions in -1..1, at rest above 1) is
 // found by its out-of-range rest and decoded with Chromium's and Firefox's thresholds.
 // Shoulders, triggers and the right stick are left out.
 function createStandardizer(){
  const hats=new Map();
  return function standardize(pad,faces){
   const raw=Array.from(pad.buttons),axes=Array.from(pad.axes||[]),n=raw.length,face=faces||[0,1,2,3];
   const key=pad.index+':'+controllerKey(pad);let hat=hats.get(key);if(!hat)hats.set(key,hat=new Set());
   axes.forEach((a,i)=>{if(Math.abs(a)>1.05)hat.add(i);});
   const layout=n===11?{select:6,start:7,dpad:[]}:n===15?{select:9,start:8,dpad:[11,12,13,14]}:{select:8,start:9,dpad:n>=16?[12,13,14,15]:[]};
   const buttons=Array.from({length:17},released);
   face.forEach((source,i)=>{if(raw[source])buttons[i]=raw[source];});
   const take=(target,source)=>{if(raw[source]&&!face.includes(source))buttons[target]=raw[source];};
   take(8,layout.select);take(9,layout.start);layout.dpad.forEach((source,i)=>take(12+i,source));
   const dir=new Set();
   for(const i of hat){
    const d=axes[i];if(!(d!==0&&Math.abs(d)<=1))continue;
    if(d<-.7||d>=.95)dir.add('up');if(d>=-.75&&d<-.1)dir.add('right');if(d>=-.2&&d<.45)dir.add('down');if(d>=.4)dir.add('left');
   }
   if(axes.length>=8&&!hat.has(6)&&!hat.has(7)){
    if(axes[6]<-.5)dir.add('left');if(axes[6]>.5)dir.add('right');if(axes[7]<-.5)dir.add('up');if(axes[7]>.5)dir.add('down');
   }
   ['up','down','left','right'].forEach((name,i)=>{if(dir.has(name)&&!buttons[12+i].pressed)buttons[12+i]=pressed();});
   const stick=i=>hat.has(i)?0:(axes[i]||0);
   const mapped=copyPad(pad,buttons,[stick(0),stick(1),0,0]);mapped.mapping='standard';return mapped;
  };
 }
 // Driven entirely by the controller being calibrated: the first pad to press a
 // button after everything is released is locked in, then A, B, X, Y are taken
 // one press at a time and saved after Y. A standard pad's face buttons are
 // indices 0-3, so any other button on it (Start, Select, D-pad, shoulders) exits
 // unchanged. A nonstandard pad may report a face button at any index, so it
 // exits only by idling; the dialog's own close/Escape works for every pad.
 function createCalibration(read,storage,now=()=>Date.now()){
  let profiles={};try{const saved=JSON.parse(storage?.getItem(calibrationKey)||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))profiles=saved;}catch{}
  let session=null,draining=false,drainKeys=null,drainLocked=null;const standardize=createStandardizer();
  function raw(){try{return Array.from(read()||[]);}catch{return [];}}
  function valid(map,pad){return Array.isArray(map)&&map.length===4&&new Set(map).size===4&&map.every(i=>Number.isInteger(i)&&i>=0&&i<pad.buttons.length);}
  function state(){return session?{phase:session.phase,ready:session.ready,next:session.phase==='capture'?labels[session.map.length]:null,captured:labels.slice(0,session.map.length),rejected:session.rejected,persisted:session.persisted}:null;}
  function notify(){session?.change?.(state());}
  function end(phase){session.phase=phase;notify();}
  // Pressing A, B, X, Y onto indices 0-3 is the default, so it removes the profile.
  function store(){
   if(session.map.every((source,i)=>source===i))delete profiles[session.key];else profiles[session.key]=session.map.slice();
   try{storage.setItem(calibrationKey,JSON.stringify(profiles));session.persisted=true;}catch{session.persisted=false;}
  }
  // A computer can have more than one controller-like device (a second pad, a virtual
  // pad from Steam or another program, a wheel), and some never sit still. Setup takes
  // a fresh press from any of them, then follows only the pad being set up: it must let
  // go before its next press. Other devices never hold setup up.
  const padKey=pad=>pad.index+':'+controllerKey(pad);
  // Released, judged on what the pad will be read as: a hat or a trigger at rest is not held.
  const settled=pad=>pad.mapping==='standard'?still(pad):!held(pad).length&&still(standardize(pad));
  function capture(pads){
   const t=now(),usable=pads.filter(p=>p&&p.connected!==false&&p.buttons.length>=4),presses=[];
   for(const p of usable){const k=padKey(p),down=held(p),before=session.prev.get(k);session.prev.set(k,down);if(before&&down.some(i=>!before.includes(i)))presses.push(p);}
   if(usable.some(p=>held(p).length))session.active=t;
   // A press counts once the pads were ready on the previous frame.
   const pad=session.ready&&(session.key?presses.find(p=>controllerKey(p)===session.key):presses[0]);
   if(pad){
    const down=held(pad);
    session.ready=false;session.last=padKey(pad);
    if(pad.mapping==='standard'&&down.some(i=>i>=4))return end('cancelled');
    if(down.length>1||session.map.includes(down[0]))session.rejected++;
    else{session.key=controllerKey(pad);session.map.push(down[0]);if(session.map.length===4){store();return end('saved');}}
    notify();
   }else{
    // Before the first capture, every pad's buttons must be up (the press that opened setup
    // is not a capture); after it, only the pad being set up, stick included.
    const last=session.last&&usable.find(p=>padKey(p)===session.last);
    const ready=session.last?!last||settled(last):usable.every(p=>!held(p).length);
    if(ready!==session.ready){session.ready=ready;notify();}
   }
   if(t-session.active>=idleMs)end('timeout');
  }
  const api={
   state,isBlocking:()=>!!session||draining,
   // change(state) runs on every visible step; phase becomes saved, cancelled or timeout.
   begin(change){session={key:null,map:[],ready:false,phase:'capture',rejected:0,persisted:null,active:now(),prev:new Map(),last:null,change};notify();},
   // Ends the session; captures not yet saved are discarded. Input stays swallowed
   // until the buttons held at that moment are released, so the last press can't navigate.
   cancel(){if(session){drainLocked=session.last;drainKeys=null;session=null;draining=true;}},
   getGamepads(){
    const pads=raw();
    if(session?.phase==='capture')capture(pads);
    const blocked=!!session||draining;
    if(draining){
     // The pad being set up must settle, stick included; any other pad only has to let go
     // of the buttons it held when setup closed. A device that never sits still can't hold it up.
     if(drainKeys===null)drainKeys=pads.filter(p=>p&&held(p).length).map(padKey);
     const find=k=>pads.find(p=>p&&padKey(p)===k),locked=drainLocked&&find(drainLocked);
     draining=!!(locked&&!settled(locked))||drainKeys.some(k=>{const p=find(k);return p&&held(p).length>0;});
    }
    return pads.map(pad=>{
     if(!pad)return pad;
     const map=profiles[controllerKey(pad)],faces=valid(map,pad)?map:null;
     let view=pad;
     if(pad.mapping!=='standard')view=standardize(pad,faces);
     else if(faces){
      const buttons=Array.from(pad.buttons);for(const source of faces)if(source>=4)buttons[source]=released();
      for(let i=0;i<4;i++)buttons[i]=pad.buttons[faces[i]];
      view=copyPad(pad,buttons);view.mapping='standard';
     }
     if(blocked)return copyPad(view,Array.from(view.buttons,released),Array.from(view.axes,()=>0));
     return view;
    });
   }
  };return api;
 }
 function createDevice(readPhysical,now=()=>Date.now(),readVirtual=()=>[]){
  const pointers=new Map(),last=new Map();let stamp=now(),active=null;
  function reset(){pointers.clear();stamp=now();}
  const keyOf=p=>p.index+':'+p.id;
  return {press(pointer,button){if(Object.hasOwn(indices,button)){pointers.set(pointer,button);stamp=now();}},release(pointer){pointers.delete(pointer);stamp=now();},reset,
   getGamepads(){
    let pads;try{pads=Array.from(readPhysical()||[]);}catch{pads=[];}
    const held=new Set([...pointers.values(),...readVirtual()]),standards=pads.filter(p=>p?.mapping==='standard');
    // A computer can have several controllers at once: a second pad, a virtual pad from
    // Steam or another program, a wheel. Games and the hub read the first pad, so the
    // first pad speaks for all of them: every pad's buttons count, and the stick comes
    // from the pad that last pressed a new button (before that, the first pad).
    const seen=new Set(),pressers=[];
    for(const p of standards){
     const k=keyOf(p),down=Array.from(p.buttons,b=>!!b.pressed),before=last.get(k);seen.add(k);
     if(before&&down.some((d,i)=>d&&!before[i]))pressers.push(k);
     last.set(k,down);
    }
    if(pressers.length&&!pressers.includes(active))active=pressers[0];
    for(const k of [...last.keys()])if(!seen.has(k))last.delete(k);
    const physical=standards.find(p=>keyOf(p)===active)||standards[0]||null;
    const standard=standards.length?pads.indexOf(standards[0]):-1;
    const mergedIndex=standard<0?0:standard;
    if(physical&&standards.length===1&&!held.size&&standard===pads.findIndex(Boolean))return pads;
    const buttons=Array.from({length:Math.max(17,...standards.map(p=>p.buttons.length))},(_,i)=>{
     const originals=standards.map(p=>p.buttons[i]).filter(Boolean),virtual=[...held].some(name=>indices[name]===i);
     const pressed=originals.some(b=>b.pressed)||virtual;
     return {pressed,touched:virtual||originals.some(b=>b.touched),value:virtual?1:Math.max(0,...originals.map(b=>b.value||0))};
    });
    const named=standards[0]||physical;
    const merged={id:named?.id||'Cubby virtual controller',index:mergedIndex,mapping:'standard',connected:true,timestamp:Math.max(stamp,...standards.map(p=>p.timestamp||0)),buttons,axes:Array.from(physical?.axes||[0,0,0,0]),vibrationActuator:physical?.vibrationActuator,hapticActuators:physical?.hapticActuators};
    // Installed, calibration has already presented every pad as standard; this is
    // for a nonstandard pad read directly. It cannot accept standard indices. Keep it as
    // its own device, with the standard virtual/aggregated pad first for old
    // games which select only the first connected controller.
    const first=pads.findIndex(Boolean);
    if(first>=0&&first<mergedIndex||standard<0&&first===0){
     const slot=standard>=0?standard:(pads.findIndex((p,i)=>i>0&&!p)>=0?pads.findIndex((p,i)=>i>0&&!p):pads.length);
     const other=pads[first];pads[slot]={id:other.id,index:slot,mapping:other.mapping,connected:other.connected,timestamp:other.timestamp,buttons:other.buttons,axes:other.axes,vibrationActuator:other.vibrationActuator,hapticActuators:other.hapticActuators};
     if(first!==0)pads[first]=null;
     merged.index=0;pads[0]=merged;
    }else pads[mergedIndex]=merged;
    return pads;
   }};
 }
 // The handheld's browser turns a finger into one pointerdown and never its pointerup; after that a tap
 // brings only a click (sometimes mousedown/mouseup too). So the first tap is held forever and no later
 // tap presses at all, in games and the game menu alike. From what it does send, complete each tap into a
 // pointerdown and a pointerup. Browsers that send their own pointer events (desktop, phones) get nothing
 // extra: their mouse events and click come just after their own pointerup.
 function completeTouches(win,listen,now=()=>win.performance?.now?.()??Date.now()){
  const open=new Map();let lastDown=-1e9,lastUp=-1e9,tapPressed=false;
  function fire(type,target,from,id){
   const init={bubbles:true,cancelable:true,composed:true,pointerId:id,pointerType:'touch',isPrimary:true,button:0,buttons:type==='pointerdown'?1:0,clientX:from.clientX,clientY:from.clientY,screenX:from.screenX,screenY:from.screenY};
   let event;try{event=new win.PointerEvent(type,init);}catch{event=new win.Event(type,{bubbles:true,cancelable:true,composed:true});for(const k of Object.keys(init))if(!(k in event))event[k]=init[k];}
   event.cubbyCompleted=true;(target?.isConnected===false?win:target||win).dispatchEvent(event);
  }
  const own=e=>e.isTrusted&&!e.cubbyCompleted;
  const theirs=()=>now()-lastDown<150||now()-lastUp<800;   // this browser is sending its own pointer events
  const release=from=>{for(const [id,target] of [...open]){open.delete(id);fire('pointerup',target,from,id);}};
  listen(win,'pointerdown',e=>{if(own(e)){lastDown=now();tapPressed=true;open.set(e.pointerId,e.target);}},true);
  for(const type of ['pointerup','pointercancel'])listen(win,type,e=>{if(own(e)){lastUp=now();open.delete(e.pointerId);}},true);
  listen(win,'mousedown',e=>{if(!own(e)||e.button!==0||theirs())return;tapPressed=true;open.set(1,e.target);fire('pointerdown',e.target,e,1);},true);
  listen(win,'mouseup',e=>{if(own(e))release(e);},true);
  // A click ends the tap: release what is still held, or, when nothing pressed, it is the whole tap.
  // Keyboard clicks (detail 0) are not taps.
  listen(win,'click',e=>{
   if(!own(e)||e.button!==0||!e.detail)return;
   if(open.size)release(e);
   else if(!tapPressed&&!theirs()){fire('pointerdown',e.target,e,1);fire('pointerup',e.target,e,1);}
   tapPressed=false;
  },true);
 }
 function install(win){
  if(win.HandheldOSD)return win.HandheldOSD;
  const doc=win.document,nav=win.navigator,prefs=win.HandheldPreferences?.preferences;
  const descriptor=Object.getOwnPropertyDescriptor(nav,'getGamepads'),read=nav.getGamepads?.bind(nav);
  let storage;try{storage=win.localStorage;}catch{}
  const calibration=createCalibration(()=>read?.()||[],storage);
  const device=createDevice(()=>calibration.getGamepads(),()=>win.performance?.now?.()??Date.now(),()=>win.CubbyHandheldEmbed?.buttons||[]);
  const listeners=[],pendingRelease=new Map();let host,shadow,style,disposed=false,menuOpen=false,visible=false;
  const legacyDescriptor=Object.getOwnPropertyDescriptor(win,'HandheldControls');
  const legacyGate={createControls:()=>()=>{}};
  // Legacy packages may assign their vendored module later. Accept the assignment
  // without letting it mount another controller; publisher bytes stay untouched.
  Object.defineProperty(win,'HandheldControls',{configurable:true,get:()=>legacyGate,set(){}});
  Object.defineProperty(nav,'getGamepads',{configurable:true,value:()=>device.getGamepads()});
  function listen(target,type,callback,capture=false){target.addEventListener(type,callback,capture);listeners.push(()=>target.removeEventListener(type,callback,capture));}
  completeTouches(win,listen);
  function cancelRelease(pointer){const id=pendingRelease.get(pointer);if(id!==undefined)win.cancelAnimationFrame?.(id);pendingRelease.delete(pointer);}
  function sync(){const pad=device.getGamepads().find(p=>p?.mapping==='standard');shadow?.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(!!pad?.buttons[indices[b.dataset.button]]?.pressed)));}
  function release(pointer){cancelRelease(pointer);if(!win.requestAnimationFrame){device.release(pointer);sync();return;}pendingRelease.set(pointer,win.requestAnimationFrame(()=>pendingRelease.set(pointer,win.requestAnimationFrame(()=>{pendingRelease.delete(pointer);device.release(pointer);sync();}))));}
  function reset(){pendingRelease.forEach((_,pointer)=>cancelRelease(pointer));device.reset();shadow?.querySelectorAll('button[aria-pressed]').forEach(b=>b.setAttribute('aria-pressed','false'));}
  function update(){visible=!win.CubbyHandheldEmbed&&(prefs?prefs.showTouchControls(win):!!win.matchMedia?.('(any-pointer: coarse)').matches);if(host)host.hidden=!visible;if(visible)doc.documentElement.setAttribute('data-cubby-osd','');else{doc.documentElement.removeAttribute('data-cubby-osd');reset();}}
  function pointer(event){
   if(!host||!(event.composedPath?.()||[]).includes(host))return;
   // Stop at the window capture boundary, before a game's global pointer-A handler.
   event.preventDefault();event.stopImmediatePropagation();
   const button=event.composedPath().find(n=>n?.dataset?.button);
   if(event.type==='pointerdown'&&button&&visible&&!menuOpen&&!calibration.isBlocking()&&!doc.hidden){
    if(button.dataset.button==='exit'){reset();win.HandheldGameShell?.open();return;}
    try{button.setPointerCapture(event.pointerId);}catch{}
    cancelRelease(event.pointerId);device.press(event.pointerId,button.dataset.button);sync();
   }else if(['pointerup','pointercancel','lostpointercapture'].includes(event.type)){
    if(event.type==='pointerup')release(event.pointerId);else if(event.type!=='lostpointercapture'||!pendingRelease.has(event.pointerId)){cancelRelease(event.pointerId);device.release(event.pointerId);sync();}
   }
  }
  for(const type of ['pointerdown','pointerup','pointermove','pointercancel','lostpointercapture','click','contextmenu'])listen(win,type,pointer,true);
  // A release outside the host must also clear its pointer if capture was lost.
  listen(win,'pointerup',event=>release(event.pointerId));listen(win,'pointercancel',event=>{cancelRelease(event.pointerId);device.release(event.pointerId);sync();});
  listen(win,'blur',reset);listen(doc,'visibilitychange',reset);
  listen(win,'handheld:system-menu',event=>{menuOpen=!!event.detail?.open;reset();});
  const media=win.matchMedia?.('(any-pointer: coarse)');if(media?.addEventListener)listen(media,'change',update);
  if(prefs)listeners.push(prefs.subscribe(update));
  function mount(){
   if(disposed)return;
   host=doc.createElement('div');host.id='cubby-host-osd';host.setAttribute('data-cubby-owned','controller');
   shadow=host.attachShadow({mode:'open'});
   const link=doc.createElement('link');link.rel='stylesheet';link.href='/runtime/core/host-osd.css';shadow.appendChild(link);
   const deck=doc.createElement('nav');deck.className='deck';deck.setAttribute('aria-label','Cubby controller');
   const arrows={up:'\u25b2',down:'\u25bc',left:'\u25c0',right:'\u25b6',exit:'\u2190'},glyphs={a:'A',b:'B',x:'X',y:'Y',l:'L',r:'R',select:'\u2212',start:'+'};
   for(const name of ['exit','left','up','down','right','a','b','x','y','l','r','select','start']){
    const button=doc.createElement('button');button.type='button';button.className='control-'+name;button.dataset.button=name;button.setAttribute('aria-label',name);button.setAttribute('aria-pressed','false');button.textContent=glyphs[name]||arrows[name];deck.appendChild(button);
   }
   shadow.appendChild(deck);doc.body.appendChild(host);
   // Only the host owns this reservation. Known canvas conventions cooperate;
   // arbitrary games using viewport dimensions still need a responsive layout.
   style=doc.createElement('style');style.setAttribute('data-cubby-owned','viewport');
   style.textContent=`html[data-cubby-osd]{--cubby-size:clamp(44px,min(7vh,calc((100vw - 56px)/6)),52px);--cubby-deck:calc(5 * var(--cubby-size) + 16px);--cubby-bottom:max(8px,env(safe-area-inset-bottom))}html[data-cubby-osd] body{box-sizing:border-box!important;padding-bottom:calc(var(--cubby-deck) + var(--cubby-bottom) + 16px)!important}html[data-cubby-osd] :is(.screen,canvas#screen,canvas.library){width:min(94vw,calc((100dvh - var(--cubby-deck) - var(--cubby-bottom) - 32px)*1.5))!important;height:auto!important}.hub-controls{display:none!important}#cubby-host-osd{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483645!important;pointer-events:none!important}#cubby-host-osd[hidden]{display:none!important}`;
   doc.body.appendChild(style);update();
  }
  // The hub needs the same physical provider, not a second touch deck.
  if(/^\/(?:games|__cubby_games__)\//.test(win.location.pathname)){
   if(doc.readyState==='loading')listen(doc,'DOMContentLoaded',mount);else mount();
  }
  // BFCache restores this document without rerunning host scripts. Keep its
  // provider/UI installed, but never carry held input into the restored page.
  listen(win,'pagehide',event=>{if(event.persisted)reset();else api.dispose();});
  const api={device,calibration,reset,get root(){return shadow;},dispose(){if(disposed)return;disposed=true;reset();listeners.forEach(f=>f());host?.remove();style?.remove();doc.documentElement.removeAttribute('data-cubby-osd');if(descriptor)Object.defineProperty(nav,'getGamepads',descriptor);else delete nav.getGamepads;if(legacyDescriptor)Object.defineProperty(win,'HandheldControls',legacyDescriptor);else delete win.HandheldControls;if(win.HandheldOSD===api)delete win.HandheldOSD;}};
  return api;
 }
 return {createDevice,createCalibration,createStandardizer,controllerKey,install,completeTouches};
});

/* Cubby-owned virtual USB-style controller. Never included in game packages. */
(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
 else {root.HandheldHostOSD=api;root.HandheldOSD=api.install(root);}
})(globalThis,function(){
 'use strict';
 const indices={a:0,b:1,x:2,y:3,l:4,r:5,select:8,start:9,up:12,down:13,left:14,right:15};
 const calibrationKey='cubby:controller-labels:v1',labels=['A','B','X','Y'];
 const controllerKey=pad=>JSON.stringify([pad.id,pad.mapping,pad.buttons.length,pad.axes.length]);
 // Gamepad attributes are native prototype getters: copy explicitly, not with spread.
 function copyPad(pad,buttons=pad.buttons,axes=pad.axes){return {id:pad.id,index:pad.index,mapping:pad.mapping,connected:pad.connected,timestamp:pad.timestamp,buttons,axes,vibrationActuator:pad.vibrationActuator,hapticActuators:pad.hapticActuators,pose:pad.pose};}
 function createCalibration(read,storage){
  let profiles={};try{const saved=JSON.parse(storage?.getItem(calibrationKey)||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))profiles=saved;}catch{}
  let session=null,draining=false;
  function raw(){try{return Array.from(read()||[]);}catch{return [];}}
  function valid(map,pad){return Array.isArray(map)&&map.length===4&&new Set(map).size===4&&map.every(i=>Number.isInteger(i)&&i>=0&&i<pad.buttons.length);}
  function state(){return session?{next:labels[session.map.length]||null,complete:session.defaults||session.map.length===4,message:session.message}:null;}
  function notify(){session?.change?.(state());}
  function finish(){session=null;draining=true;}
  const api={
   controllers:()=>raw().filter(p=>p&&p.connected!==false&&p.buttons.length>=4).map(p=>({key:controllerKey(p),id:p.id,index:p.index})),
   state,isBlocking:()=>!!session||draining,
   begin(key,change){if(!api.controllers().some(p=>p.key===key))throw Error('Connect the controller first.');session={key,map:[],ready:false,message:'Release all buttons, then press the button labelled A.',change,defaults:false};notify();},
   reset(){if(!session)return;session.map=[];session.defaults=true;session.message='Default mapping will be restored when saved.';notify();},
   cancel:finish,
   save(){if(!session||!state().complete)throw Error('Capture all four buttons first.');if(session.defaults)delete profiles[session.key];else profiles[session.key]=session.map.slice();let persisted=true;try{storage?.setItem(calibrationKey,JSON.stringify(profiles));if(!storage)persisted=false;}catch{persisted=false;}finish();return persisted;},
   getGamepads(){
    const pads=raw(),neutral=pads.every(p=>!p||!Array.from(p.buttons).some(b=>b.pressed||b.value>.5)&&Array.from(p.axes).every(a=>Math.abs(a)<.5));
    if(session){
     const pad=pads.find(p=>p&&controllerKey(p)===session.key);
     if(!pad){session.ready=false;session.message='Controller disconnected. Reconnect it or cancel.';notify();}
     else if(!session.defaults&&session.map.length<4){
      const down=Array.from(pad.buttons).flatMap((b,i)=>b.pressed||b.value>.5?[i]:[]);
      if(neutral){if(!session.ready){session.ready=true;session.message='Press the button labelled '+labels[session.map.length]+'.';notify();}}
      else if(down.length&&session.ready){
       session.ready=false;
       if(down.length!==1)session.message='Press only one button. Release all buttons and try again.';
       else if(session.map.includes(down[0]))session.message='That button is already assigned. Release it and try again.';
       else{session.map.push(down[0]);session.message=session.map.length===4?'Captured A, B, X and Y. Release all buttons, then Save.':'Release all buttons, then press the button labelled '+labels[session.map.length]+'.';}
       notify();
      }
     }
    }
    // Also swallow the final Save/Cancel press until every physical control is
    // neutral. Otherwise a held capture button becomes a fresh navigation edge.
    const blocked=!!session||draining;if(draining&&neutral)draining=false;
    return pads.map(pad=>{
     if(!pad)return pad;
     if(blocked)return copyPad(pad,Array.from(pad.buttons,()=>({pressed:false,touched:false,value:0})),Array.from(pad.axes,()=>0));
     const map=profiles[controllerKey(pad)];if(!valid(map,pad))return pad;
     const buttons=Array.from(pad.buttons);for(const source of map)if(source>=4)buttons[source]={pressed:false,touched:false,value:0};
     for(let i=0;i<4;i++)buttons[i]=pad.buttons[map[i]];
     // A calibrated nonstandard pad now supplies our standard face-button slots.
     // Other buttons and axes remain browser-reported.
     const mapped=copyPad(pad,buttons);mapped.mapping='standard';return mapped;
    });
   }
  };return api;
 }
 function createDevice(readPhysical,now=()=>Date.now(),readVirtual=()=>[]){
  const pointers=new Map();let stamp=now();
  function reset(){pointers.clear();stamp=now();}
  return {press(pointer,button){if(Object.hasOwn(indices,button)){pointers.set(pointer,button);stamp=now();}},release(pointer){pointers.delete(pointer);stamp=now();},reset,
   getGamepads(){
    let pads;try{pads=Array.from(readPhysical()||[]);}catch{pads=[];}
    const held=new Set([...pointers.values(),...readVirtual()]),standard=pads.findIndex(p=>p?.mapping==='standard'),physical=standard<0?null:pads[standard];
    const mergedIndex=standard<0?0:standard;
    if(physical&&!held.size&&standard===pads.findIndex(Boolean))return pads;
    const buttons=Array.from({length:Math.max(17,physical?.buttons?.length||0)},(_,i)=>{
     const original=physical?.buttons?.[i],virtual=[...held].some(name=>indices[name]===i),pressed=!!original?.pressed||virtual;
     return {pressed,touched:virtual||!!original?.touched,value:virtual?1:(original?.value||0)};
    });
    const merged={id:physical?.id||'Cubby virtual controller',index:mergedIndex,mapping:'standard',connected:true,timestamp:Math.max(physical?.timestamp||0,stamp),buttons,axes:Array.from(physical?.axes||[0,0,0,0]),vibrationActuator:physical?.vibrationActuator,hapticActuators:physical?.hapticActuators};
    // A nonstandard controller cannot accept standard button indices. Keep it as
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
 return {createDevice,createCalibration,install};
});

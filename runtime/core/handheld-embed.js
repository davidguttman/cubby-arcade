/* Opt-in physical-controller host for an embedded Cubby. Shared hub/game bytes stay unchanged. */
(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
 else {root.CubbyHandheldEmbedAPI=api;root.CubbyHandheldEmbed=api.install(root);}
})(globalThis,function(){
 'use strict';
 const TYPE='cubby:embed:v1',KEY='cubby:handheld-embed:v1';
 const indices={a:0,b:1,x:2,y:3,l:4,r:5,select:8,start:9,up:12,down:13,left:14,right:15};
 function allowed(origin){return origin==='https://david.app'||origin==='https://www.david.app'||/^https:\/\/[a-z0-9-]+\.davidguttman\.jump\.sh$/.test(origin);}
 function configuration(win){
  if(win.parent===win)return null;
  try{
   const params=new URLSearchParams(win.location.search);let origin;
   if(params.has('embed')){
    if(params.get('embed')!=='handheld')return null;
    origin=params.get('parentOrigin');if(!allowed(origin))return null;
    win.sessionStorage.setItem(KEY,origin);
   }else origin=win.sessionStorage.getItem(KEY);
   return allowed(origin)?{parentOrigin:origin}:null;
  }catch{return null;}
 }
 function install(win){
  const config=configuration(win);if(!config)return null;
  const doc=win.document,nav=win.navigator,parent=win.parent,held=new Set(),releases=new Map(),contexts=new Set(),media=new Set();
  let active=false,sequence=0,scheduled=null,offset=0,asleepAt=win.performance.now();
  const callbacks=new Map(),request=win.requestAnimationFrame.bind(win),cancel=win.cancelAnimationFrame.bind(win);
  const hiddenDescriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(doc),'hidden');
  const nativeHidden=()=>hiddenDescriptor?.get?hiddenDescriptor.get.call(doc):false;
  const post=event=>parent.postMessage({type:TYPE,...event},config.parentOrigin);
  // The parent owns focus while physical controls are being used. Do not ask the
  // browser's iframe-focus heuristic to decide whether this controller works.
  Object.defineProperty(doc,'hasFocus',{configurable:true,value:()=>active&&!nativeHidden()});
  Object.defineProperty(doc,'hidden',{configurable:true,get:()=>!active||nativeHidden()});
  Object.defineProperty(doc,'visibilityState',{configurable:true,get:()=>doc.hidden?'hidden':'visible'});
  // Freeze requestAnimationFrame work, including raw game loops, while the room
  // is away. Removing elapsed sleep from timestamps prevents a catch-up jump.
  function schedule(){if(active&&scheduled===null&&callbacks.size)scheduled=request(t=>{scheduled=null;const pending=[...callbacks];callbacks.clear();for(const [id,fn] of pending){if(!active){callbacks.set(id,fn);continue;}try{fn(t-offset);}catch(error){win.setTimeout(()=>{throw error;},0);}}schedule();});}
  win.requestAnimationFrame=fn=>{const id=++sequence;callbacks.set(id,fn);schedule();return id;};
  win.cancelAnimationFrame=id=>callbacks.delete(id);
  // Preserve the hardware provider for the normal OSD calibration/composition
  // layer loaded next. Gate every device while inactive, not just virtual input.
  const readPhysical=nav.getGamepads?.bind(nav);
  Object.defineProperty(nav,'getGamepads',{configurable:true,value(){
   let pads;try{pads=Array.from(readPhysical?.()||[]);}catch{pads=[];}
   return active?pads:pads.map(pad=>pad?{id:pad.id,index:pad.index,mapping:pad.mapping,connected:pad.connected,timestamp:pad.timestamp,buttons:Array.from(pad.buttons,()=>({pressed:false,touched:false,value:0})),axes:Array.from(pad.axes,()=>0),vibrationActuator:pad.vibrationActuator,hapticActuators:pad.hapticActuators}:pad);
  }});
  function audioFailure(){post({event:'audio-blocked'});}
  function reportAudioFailure(error){audioFailure();throw error;}
  for(const name of ['AudioContext','webkitAudioContext']){
   const Native=win[name];if(!Native)continue;
   win[name]=new Proxy(Native,{construct(Target,args){
    const context=Reflect.construct(Target,args),resume=context.resume.bind(context),suspend=context.suspend.bind(context);
    const record={context,wanted:context.state==='running',resume,suspend};contexts.add(record);
    context.resume=()=>{record.wanted=true;return active?resume().catch(reportAudioFailure):Promise.resolve();};
    context.suspend=()=>{record.wanted=false;return suspend();};
    if(!active)suspend().catch(()=>{});
    return context;
   }});
  }
  const mediaPrototype=win.HTMLMediaElement?.prototype,play=mediaPrototype?.play,pause=mediaPrototype?.pause;
  if(play)mediaPrototype.play=function(){if(!active){media.add(this);return Promise.resolve();}return play.call(this).catch(reportAudioFailure);};
  if(pause)mediaPrototype.pause=function(){media.delete(this);return pause.call(this);};
  // Declarative autoplay can start without calling the patched play method.
  doc.addEventListener('play',event=>{if(!active&&pause&&event.target instanceof win.HTMLMediaElement){media.add(event.target);pause.call(event.target);}},true);
  function setActive(value){
   if(value===active)return;
   active=value;held.clear();releases.clear();
   if(active){offset+=win.performance.now()-asleepAt;schedule();}
   else {asleepAt=win.performance.now();if(scheduled!==null){cancel(scheduled);scheduled=null;}}
   // Game SDKs receive their real visibility/focus lifecycle before audio work.
   doc.dispatchEvent(new win.Event('visibilitychange'));win.dispatchEvent(new win.Event(active?'focus':'blur'));
   if(active){
    for(const r of contexts)if(r.wanted&&r.context.state!=='closed')r.resume().catch(audioFailure);
    for(const element of media)play.call(element).catch(audioFailure);media.clear();
   }else {
    for(const r of contexts)if(r.context.state!=='closed'){r.wanted=r.wanted||r.context.state==='running';r.suspend().catch(()=>{});}
    for(const element of doc.querySelectorAll('audio,video'))if(!element.paused&&!element.ended){media.add(element);pause.call(element);}
   }
  }
  win.addEventListener('message',event=>{
   if(event.source!==parent||event.origin!==config.parentOrigin)return;
   const data=event.data;if(!data||data.type!==TYPE)return;
   if(data.event==='active'&&typeof data.active==='boolean')setActive(data.active);
   else if(data.event==='button'&&active&&Object.hasOwn(indices,data.button)&&typeof data.down==='boolean'){
    if(data.down){releases.delete(data.button);held.add(data.button);}
    else {
     // A semantic click can post down/up before a game polls its pad. Preserve
     // that short tap for two frames, like the ordinary host-owned touch deck.
     const token={};releases.set(data.button,token);
     win.requestAnimationFrame(()=>win.requestAnimationFrame(()=>{if(releases.get(data.button)===token){held.delete(data.button);releases.delete(data.button);}}));
    }
   }
  });
  win.addEventListener('keydown',event=>{if(event.code==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)post({event:'exit'});}},true);
  win.addEventListener('pagehide',()=>setActive(false));
  win.addEventListener('pageshow',()=>post({event:'ready'}));
  // OSD remains installed as the controller owner/legacy-overlay gate, but a
  // physical embedding supplies the buttons and reserves no touch-deck space.
  doc.documentElement?.setAttribute('data-cubby-embed','handheld');
  post({event:'ready'});
  return {setActive,get active(){return active;},get buttons(){return active?[...held]:[];}};
 }
 return {configuration,install};
});

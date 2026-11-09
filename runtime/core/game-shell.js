/* Host-owned escape hatch, injected before game scripts. Trusted games need no SDK. */
(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
 else {root.HandheldGameShellAPI=api;if(/^\/(?:games|__cubby_games__)\//.test(root.location.pathname))root.HandheldGameShell=api.install(root);}
})(globalThis,function(){
'use strict';
const SYSTEM_EVENT_WINDOW=1500;
function install(win){
 const doc=win.document,nav=win.navigator,originalPads=nav.getGamepads?.bind(nav);
 let opened=false,selection=0,ready=false,last=new Set(),blocked=false,padId,padSince,unmask=false,menu,resumeButton,homeButton,touch,disposed=false,frame;
 const listeners=[],actions=new WeakMap();
 function listen(target,type,fn,capture=false){target.addEventListener(type,fn,capture);listeners.push(()=>target.removeEventListener(type,fn,capture));}
 function signal(){win.dispatchEvent(new win.CustomEvent('handheld:system-menu',{detail:{open:opened}}));}
 function focus(){(selection?homeButton:resumeButton)?.focus();}
 function open(){if(opened||disposed)return;opened=true;selection=0;blocked=true;ready=false;if(menu)menu.hidden=false;signal();focus();}
 function resume(){if(!opened)return;opened=false;blocked=true;ready=false;if(menu)menu.hidden=true;signal();}
 function home(){win.location.href=/^https?:$/.test(win.location.protocol)?'/play':'/';}
 // Games return to their title first; only Cubby turns this request into navigation.
 listen(win,'handheld:quit',home);
 function neutral(pad){return !pad.buttons.some(b=>b.pressed)&&pad.axes.every(a=>Math.abs(a)<0.5);}
 function chord(pad){return (pad.buttons[8]?.pressed&&(win.CubbyHandheldEmbed||pad.buttons[9]?.pressed))||(pad.buttons[4]?.pressed&&pad.buttons[5]?.pressed);}
 function pads(){try{return Array.from(originalPads?.()||[]);}catch{return [];}}
 // Reserve the system chord and all controller input while the menu is open.
 // The first neutral frame after dismissal re-arms gameplay, never its held A.
 if(originalPads)Object.defineProperty(nav,'getGamepads',{configurable:true,value(){const values=pads();return values.map(p=>p&&(opened||blocked||chord(p))?{id:p.id,index:p.index,mapping:p.mapping,connected:p.connected,timestamp:p.timestamp,buttons:p.buttons.map(()=>({pressed:false,touched:false,value:0})),axes:p.axes.map(()=>0),vibrationActuator:p.vibrationActuator}:p);}});
 function poll(time){
  if(disposed)return;
  const active=!doc.hidden&&(!doc.hasFocus||doc.hasFocus());
  const pad=pads().find(Boolean);
  // Browsers hide the real pad from a new page until it sees input, so the pad a
  // page reads (none, or the on-screen one) changes on that first press. Games
  // carry their own frozen input.js, which ignores a new pad first seen with a
  // button down: report one neutral frame to arm it, then the press. Soon after
  // load it may be a button still held from the previous page, so leave it masked.
  const id=pad?pad.index+':'+pad.id:null,revealed=active&&pad&&id!==padId&&time-padSince>=250;
  if(id!==padId||!active){padId=id;padSince=time;}
  if(!active||!pad){ready=false;last.clear();blocked=true;unmask=false;}
  else if(neutral(pad)){ready=true;blocked=false;unmask=false;last.clear();}
  else if(revealed){unmask=true;blocked=true;}
  else if(unmask){unmask=false;ready=true;blocked=false;}
  else if(ready){
   const current=new Set();if(chord(pad))current.add('menu');
   else {if(pad.buttons[0]?.pressed)current.add('confirm');if(pad.buttons[1]?.pressed)current.add('back');if(pad.buttons[14]?.pressed||pad.axes[0]<-0.5)current.add('left');if(pad.buttons[15]?.pressed||pad.axes[0]>0.5)current.add('right');}
   for(const action of current)if(!last.has(action)){
    if(action==='menu'){if(opened)resume();else open();}
    else if(opened){if(action==='back')resume();else if(action==='left'||action==='right'){selection=1-selection;focus();}else if(action==='confirm'){if(selection)home();else resume();}}
   }
   last=current;
  }
  frame=win.requestAnimationFrame(poll);
 }
 listen(win,'keydown',e=>{
  const exitKeys=win.HandheldPreferences?.preferences.get().keyboard.exit||[];
  if(e.code==='Escape'||exitKeys.includes(e.code)){
   e.preventDefault();e.stopImmediatePropagation();if(!e.repeat){if(opened)resume();else open();}return;
  }
  if(!opened)return;
  e.preventDefault();e.stopImmediatePropagation();if(e.repeat)return;
  const mapping=win.HandheldPreferences?.preferences.get().keyboard;
  const button=mapping&&Object.keys(mapping).find(b=>mapping[b].includes(e.code));
  if(e.code==='ArrowLeft'||e.code==='ArrowRight'||button==='left'||button==='right'){selection=1-selection;focus();}
  else if(e.code==='Tab'){selection=1-selection;focus();}
  else if(e.code==='Enter'||e.code==='Space'||button==='a'||button==='start'){if(selection)home();else resume();}
  else if(button==='b'||button==='exit')resume();
 },true);
 // Hide Escape releases from games too; other releases remain available so their
 // existing input controllers cannot retain a stuck key across a menu opening.
 listen(win,'keyup',e=>{if(e.code==='Escape'||(win.HandheldPreferences?.preferences.get().keyboard.exit||[]).includes(e.code)){e.preventDefault();e.stopImmediatePropagation();}},true);
 // Intercept host controls before game-level pointer handlers, including games
 // with global listeners. Opening/confirming the menu cannot also press game A.
 listen(win,'pointerdown',e=>{const button=e.target?.closest?.('button');const action=button&&actions.get(button);if(opened||action){e.preventDefault();e.stopImmediatePropagation();if(action)action();}},true);
 for(const type of ['pointerup','pointermove'])listen(win,type,e=>{const button=e.target?.closest?.('button');if(opened||(button&&actions.has(button))){e.preventDefault();e.stopImmediatePropagation();}},true);
 listen(win,'click',e=>{const button=e.target?.closest?.('button');if(opened||(button&&actions.has(button))){e.preventDefault();e.stopImmediatePropagation();}},true);
 listen(win,'keypress',e=>{if(opened||e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();}},true);
 function mount(){
  const style=doc.createElement('style');style.textContent='.system-menu[hidden],.system-menu-button[hidden]{display:none!important}.system-menu{position:fixed;inset:0;z-index:2147483647;background:#101614f2;display:flex;align-items:center;justify-content:center;gap:24px}.system-menu button,.system-menu-button{appearance:none;min-width:64px;min-height:64px;background:#243e32;color:#f5f5df;border:3px solid #a6c5aa;border-radius:18px;padding:12px;touch-action:manipulation}.system-menu button:focus{outline:6px solid #ffe578;outline-offset:5px}.system-menu svg,.system-menu-button svg{width:36px;height:36px;fill:currentColor}.system-menu-button{position:fixed;z-index:2147483646;top:8px;right:8px;min-width:48px;min-height:48px;padding:6px}';doc.body.appendChild(style);
  function button(parent,label,path,click){const b=doc.createElement('button');b.type='button';b.setAttribute('aria-label',label);b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+path+'"/></svg>';actions.set(b,click);parent.appendChild(b);return b;}
  menu=doc.createElement('div');menu.className='system-menu';menu.hidden=!opened;menu.setAttribute('role','dialog');menu.setAttribute('aria-modal','true');menu.setAttribute('aria-label','Game menu');doc.body.appendChild(menu);
  resumeButton=button(menu,'Resume game','m8 3 14 9-14 9Z',resume);
  homeButton=button(menu,'Return to library','M2 2h8v8H2zM14 2h8v8h-8zM2 14h8v8H2zM14 14h8v8h-8z',home);
  touch=button(doc.body,'Game menu','M3 4h18v3H3zM3 11h18v3H3zM3 18h18v3H3z',open);touch.className='system-menu-button';
  function update(){const prefs=win.HandheldPreferences?.preferences;touch.hidden=!!win.CubbyHandheldEmbed||(prefs?!prefs.showTouchControls(win):!win.matchMedia?.('(any-pointer: coarse)').matches);}
  update();const prefs=win.HandheldPreferences?.preferences;if(prefs)listeners.push(prefs.subscribe(update));
  const media=win.matchMedia?.('(any-pointer: coarse)');if(media?.addEventListener)listen(media,'change',update);
  if(opened)focus();
 }
 // System events reach games as window events: handheld:sleep, handheld:wake. A game
 // decides what to do, if anything; event.waitUntil(promise) asks for a moment first.
 function systemEvent(type,detail={}){
  const waits=[],event=new win.CustomEvent('handheld:'+type,{detail});
  event.waitUntil=promise=>{waits.push(promise);};
  try{win.dispatchEvent(event);}catch{}
  if(!waits.length)return Promise.resolve();
  return Promise.race([Promise.allSettled(waits),new Promise(done=>win.setTimeout(done,SYSTEM_EVENT_WINDOW))]);
 }
 const hostEvents=win.AbortController?new win.AbortController():null;
 async function watchHostEvents(){
  if(typeof win.fetch!=='function'||!/^https?:$/.test(win.location.protocol))return;
  let after=-1,failures=0;
  while(!disposed&&failures<5){
   try{
    const reply=await win.fetch('/api/system-events?after='+after,{cache:'no-store',signal:hostEvents?.signal});
    if(!reply.ok)return;
    const body=await reply.json();
    after=body.seq;failures=0;
    for(const item of body.events)systemEvent(item.type,item.detail).then(()=>win.fetch('/api/system-events/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seq:item.seq})})).catch(()=>{});
   }catch{failures+=1;if(!disposed)await new Promise(done=>win.setTimeout(done,2000));}
  }
 }
 if(doc.readyState==='loading')listen(doc,'DOMContentLoaded',mount);else mount();
 frame=win.requestAnimationFrame(poll);
 watchHostEvents();
 return {open,resume,home,systemEvent,isOpen:()=>opened,dispose(){disposed=true;hostEvents?.abort();win.cancelAnimationFrame(frame);listeners.forEach(f=>f());if(originalPads)Object.defineProperty(nav,'getGamepads',{configurable:true,value:originalPads});menu?.remove();touch?.remove();win.HandheldOSD?.dispose();}};
}
return {install};
});

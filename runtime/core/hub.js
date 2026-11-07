/* Shared, wordless discovery UI. Adult keyboard setup is deliberately separate. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HandheldHub=api;})(globalThis,function(){
'use strict';
const favoriteKey='handheld:favorites:v1';
function createState(storage){
 let favorites=[];try{const value=JSON.parse(storage?.getItem(favoriteKey)||'[]');if(Array.isArray(value))favorites=value.filter(x=>typeof x==='string');}catch{}
 return {view:'library',detail:null,show(view){if(!['library','store','options'].includes(view))throw Error('Unknown view');this.view=view;this.detail=null;},select(game){this.detail=game;},isFavorite:id=>favorites.includes(id),favorite(id){favorites=favorites.includes(id)?favorites.filter(x=>x!==id):[...favorites,id];try{storage?.setItem(favoriteKey,JSON.stringify(favorites));}catch{}return favorites.includes(id);}};
}
const paths={controller:'M7 7h10q4 0 5 11l-2 2-5-4H9l-5 4-2-2Q3 7 7 7ZM6 10v5M3.5 12.5h5M16 11h.01M19 14h.01',trash:'M3 6h18M9 6V3h6v3M6 6l1 16h10l1-16M10 10v7M14 10v7',token:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 6.6l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5Z',library:'M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v7H3zM14 15h7v7h-7z',store:'M4 8h16l1 14H3ZM8 8V6a4 4 0 0 1 8 0v2',options:'M10.2 4.51 10.07 1.58h3.86L13.8 4.51l2.22.92 1.98-2.17L20.74 6l-2.17 1.98.92 2.22 2.93-.13v3.86l-2.93-.13-.92 2.22L20.74 18 18 20.74l-1.98-2.17-2.22.92.13 2.93h-3.86l.13-2.93-2.22-.92L6 20.74 3.26 18l2.17-1.98-.92-2.22-2.93.13v-3.86l2.93.13.92-2.22L3.26 6 6 3.26l1.98 2.17ZM12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z',wifi:'M2 9.5a15 15 0 0 1 20 0M5.5 13a10 10 0 0 1 13 0M9 16.5a5 5 0 0 1 6 0M12 20h.01',update:'M3 11 12 3l9 8v10H3ZM12 18v-7M8.5 14.5 12 11l3.5 3.5',retry:'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',play:'m8 4 13 8-13 8Z',back:'m14 4-8 8 8 8M6 12h16',star:'m12 2 3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1Z',check:'m4 12 5 5L21 5',keyboard:'M2 5h20v14H2ZM5 9h2m2 0h2m2 0h2m2 0h2M5 13h2m2 0h2m2 0h2m2 0h2M7 16h10',adult:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM5 23v-5a7 7 0 0 1 14 0v5',empty:'M3 9h18v12H3ZM3 9l3-5h12l3 5M9 13h6',error:'M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9ZM9.5 12.5h.01M14.5 12.5h.01M9.5 16.2q2.5-2 5 0',quit:'M12 2v10M6 5a9 9 0 1 0 12 0',cancel:'m5 5 14 14M19 5 5 19',loading:'M12 3a9 9 0 1 1-9 9',down:'M12 2v13m-5-5 5 5 5-5M3 18v4h18v-4',pick:'m6 9 6 6 6-6',alert:'m12 2 11 20H1ZM12 8v6m0 3v1',backspace:'M9 5h12v14H9l-6-7ZM12 9.5l5 5M17 9.5l-5 5'};
function icon(name){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
// Picture-only brand mark: a smiling cubby house.
const brand='<svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true"><path class="brand-roof" d="M24 3.5 44 18.5V39a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V18.5Z"/><rect class="brand-door" x="11" y="20" width="26" height="18" rx="6"/><g class="brand-face"><circle cx="19" cy="27.5" r="2.4"/><circle cx="29" cy="27.5" r="2.4"/><path d="M19.5 32.5q4.5 3.4 9 0"/></g></svg>';
// Game updates live here, in the one hub every host mounts: a host that can install
// a game gets updates with nothing to wire up, so no host can be left without them.
// Hosts own only the mechanics: downloading, verifying, and when a version may
// switch (never under a running game). Failed or offline checks leave the current
// release playable and retry on the next check.
async function sweepGameUpdates(platform,{signal}={}){
 const [games,offers]=await Promise.all([platform.library(),platform.catalog()]);
 const offered=new Set(offers.filter(offer=>offer.manifest_url).map(offer=>offer.id));
 for(const {id} of games){
  signal?.throwIfAborted();
  if(offered.has(id))try{await platform.update(id,{signal});}catch{/* Current release stays playable. */}
 }
}
// Hub entry, every five minutes in the hub, and on coming back or back online. These
// deliberately don't consult document.hidden or navigator.onLine: a wrong answer from
// a kiosk browser would silently stop updates, and a needless check costs one manifest.
function startGameUpdates(win,platform){
 if(!platform.update)return {stop(){},idle:()=>Promise.resolve()};
 const controller=new win.AbortController();let running=null,stopped=false;
 function check(){if(!stopped&&!running)running=sweepGameUpdates(platform,{signal:controller.signal}).catch(()=>{}).finally(()=>{running=null;});}
 function visible(){if(!win.document.hidden)check();}
 const timer=win.setInterval(check,5*60*1000);
 win.addEventListener('online',check);win.document.addEventListener('visibilitychange',visible);
 check();
 return {
  // Installing or removing a game waits for its turn; hosts run one package job at a time.
  idle:()=>running||Promise.resolve(),
  stop(){if(stopped)return;stopped=true;controller.abort();win.clearInterval(timer);win.removeEventListener('online',check);win.document.removeEventListener('visibilitychange',visible);}
 };
}
// This sensor belongs to the device host, not browser games or their packages.
function startBattery(indicator,win){
 indicator.hidden=true;
 if(win.CubbyDeviceProfile!=='rg353v')return ()=>{};
 let stopped=false,timer=null,controller=null,deadline=null;
 async function refresh(){
  controller=new win.AbortController();
  deadline=win.setTimeout(()=>controller?.abort(),5000);
  try{
   const response=await win.fetch('/api/battery',{cache:'no-store',signal:controller.signal});
   if(!response.ok)throw Error('Battery unavailable');
   const value=await response.json();
   if(stopped)return;
   if(value?.available!==true||!Number.isInteger(value.level)||value.level<0||value.level>100||typeof value.charging!=='boolean')throw Error('Battery unavailable');
   indicator.dataset.low=String(value.level<=20);
   indicator.setAttribute('role','img');
   indicator.setAttribute('aria-label',(value.charging?'Charging, ':'Battery, ')+value.level+'%');
   indicator.innerHTML='<svg viewBox="0 0 32 24" aria-hidden="true"><rect class="battery-case" x="2" y="5" width="25" height="14" rx="3"/><path class="battery-tip" d="M29 10v4"/><rect class="battery-fill" x="5" y="8" width="'+(18*value.level/100)+'" height="8" rx="1"/>'+(value.charging?'<path class="battery-bolt" d="m17 2-7 11h5l-1 9 8-12h-6Z"/>':'')+'</svg>';
   indicator.hidden=false;
  }catch{if(!stopped)indicator.hidden=true;}
  finally{
   win.clearTimeout(deadline);controller=null;
   if(!stopped)timer=win.setTimeout(refresh,30000);
  }
 }
 refresh();
 return ()=>{stopped=true;win.clearTimeout(timer);win.clearTimeout(deadline);controller?.abort();};
}
// Keeps pre-readers out of adult settings: instant for an adult, out of reach of
// a small child. Sums always carry and times stay within the five times table.
function challenge(random=Math.random){
 const int=(lo,hi)=>lo+Math.floor(random()*(hi-lo+1)),op=['+','×'][int(0,1)];
 const n1=op==='+'?int(6,9):int(3,5),n2=op==='+'?int(6,9):int(3,5);
 return {text:"What's "+n1+' '+op+' '+n2+'?',answer:String(op==='+'?n1+n2:n1*n2)};
}
// Catalog data can change while the launcher code and installed games stay put.
function startCatalogChecks(win,refresh){
 if(!win.setInterval)return ()=>{};
 const controller=new AbortController();let stopped=false,running=false;
 async function check(){
  if(stopped||running||win.document?.hidden||win.navigator?.onLine===false)return;
  running=true;try{await refresh({signal:controller.signal});}catch{}finally{running=false;}
 }
 const timer=win.setInterval(check,5*60*1000);
 function stop(){if(stopped)return;stopped=true;controller.abort();win.clearInterval(timer);win.document?.removeEventListener?.('visibilitychange',check);win.removeEventListener('online',check);win.removeEventListener('pagehide',stop);}
 win.document?.addEventListener?.('visibilitychange',check);win.addEventListener('online',check);win.addEventListener('pagehide',stop);
 return stop;
}
function mount(host){
 const doc=host.ownerDocument,win=doc.defaultView;let storage;try{storage=win.localStorage;}catch{}
 const state=createState(storage),prefs=win.HandheldPreferences.preferences,platform=win.HandheldPlatform.createPlatform(win.HandheldPlatformOptions);
 let account=null,launchBusy=false,featured=null,initialViewPending=true,requested=null;
 const gameReturn='cubby:game-return';let returningGame=null;try{returningGame=win.sessionStorage.getItem(gameReturn);win.sessionStorage.removeItem(gameReturn);}catch{}
 let installStates={},library=[],catalog=[],loading={library:true,store:true},failed={library:false,store:false},adult=false,draft=null,cancelCapture=null,disposed=false;
 host.innerHTML='<header class="topbar"><div class="brand">'+brand+'</div><nav class="view-nav" aria-label="Views"><span class="nav-pill" aria-hidden="true"></span></nav><div class="hud"></div></header>'+
  '<section class="view-body"><div class="hero"><div class="hero-backdrop" aria-hidden="true"></div><aside class="detail" hidden></aside><div class="hero-rest" aria-hidden="true"><div class="stage"><img class="rest-media" alt=""></div><div class="rest-hint">'+icon('pick')+'</div><div class="rest-done">'+icon('check')+icon('library')+'</div></div></div><div class="shelf-rail"><div class="shelf"></div></div></section>'+
  '<section class="options-panel" hidden></section><dialog class="adult-setup" aria-label="Adult keyboard setup"></dialog>';
 const nav=host.querySelector('.view-nav'),body=host.querySelector('.view-body'),backdrop=host.querySelector('.hero-backdrop'),restArt=host.querySelector('.hero-rest img'),shelf=host.querySelector('.shelf'),detail=host.querySelector('.detail'),options=host.querySelector('.options-panel'),dialog=host.querySelector('dialog.adult-setup');
 function button(parent,name,label,fn,cls){const b=doc.createElement('button');b.type='button';b.className=cls||'';b.setAttribute('aria-label',label);b.innerHTML=icon(name);b.addEventListener('click',fn);parent.appendChild(b);return b;}
 function element(parent,tag,cls){const e=doc.createElement(tag);if(cls)e.className=cls;parent.appendChild(e);return e;}
 const battery=element(host.querySelector('.hud'),'div','battery-indicator');
 const stopBattery=startBattery(battery,win);
 const budget=element(host.querySelector('.hud'),'div','token-budget');budget.hidden=!platform.capabilities?.tokens;budget.setAttribute('role','status');
 function renderAccount(){if(!platform.capabilities?.tokens)return;budget.replaceChildren();budget.classList.toggle('empty-budget',account?.balance===0);budget.classList.toggle('no-budget',!account?.available);budget.setAttribute('aria-label',account?.available?account.balance+' tokens':'Tokens unavailable');
  if(account?.available&&account.balance>0){budget.style.setProperty('--coins',account.balance);for(let i=0;i<account.balance;i++){const coin=element(budget,'span','coin');coin.innerHTML=icon('token');}}else{budget.style.removeProperty('--coins');budget.innerHTML=icon(account?.available?'token':'alert');}refreshOwnership();}
 async function readAccount(){try{account=await platform.account();}catch{account={available:false};}if(!disposed)renderAccount();}
 async function launch(id){if(launchBusy)return;const latest=library.find(game=>game.id===id);if(!latest)return;try{win.sessionStorage.setItem(gameReturn,id);}catch{}if(!platform.capabilities?.tokens){win.location.href=latest.entrypoint;return;}const opener=doc.activeElement;let launched=false;launchBusy=true;refreshOwnership();try{await platform.launch(id);launched=true;}catch{await readAccount();}finally{launchBusy=false;if(!disposed){refreshOwnership();if(launched&&doc.activeElement===opener&&state.view==='library'&&state.detail?.id===id)focusView();}}}
 const unsubscribeAccount=platform.onAccountState?.(value=>{account=value;if(!disposed)renderAccount();});
 if(platform.capabilities?.tokens)readAccount();
 const controllerDialog=element(host,'dialog','controller-setup');controllerDialog.setAttribute('aria-label','Adult controller setup');
 const calibration=win.HandheldOSD?.calibration;
 function closeController(){calibration?.cancel();controllerDialog.close();options.querySelector('.controller-settings')?.focus();}
 function openController(){
  if(!settingsUnlocked||!calibration)return;
  controllerDialog.replaceChildren();element(controllerDialog,'h1').textContent='Controller button labels';
  element(controllerDialog,'p').textContent='Use the printed A, B, X and Y labels, not their positions. Use a mouse, touch, or keyboard for these setup controls.';
  const label=element(controllerDialog,'label');label.textContent='Controller ';const select=element(label,'select','controller-choice');
  // Let the native selector keep its keyboard behavior instead of turning its
  // arrow/Enter keys into hub navigation actions.
  select.addEventListener('keydown',event=>event.stopPropagation());
  const feedback=element(controllerDialog,'p','controller-feedback save-feedback');feedback.setAttribute('role','status');
  const actions=element(controllerDialog,'div','save-actions');let start,save;
  function refresh(){select.replaceChildren();for(const pad of calibration.controllers()){const option=element(select,'option');option.value=pad.key;option.textContent=pad.id;}feedback.textContent=select.children.length?'Choose a controller, then start. If Steam changes the reported identity, calibrate again.':'Press a button to connect your controller, then Refresh controllers.';}
  function control(text,fn,cls){const b=element(actions,'button',cls);b.type='button';b.textContent=text;b.addEventListener('click',fn);return b;}
  control('Refresh controllers',()=>{calibration.cancel();select.disabled=false;start.disabled=false;save.disabled=true;refresh();},'refresh-controllers');
  start=control('Start calibration',()=>{
   try{win.HandheldOSD.reset();calibration.begin(select.value,state=>{feedback.textContent=state.message;save.disabled=!state.complete;});select.disabled=true;}
   catch(error){feedback.textContent=error.message;}
  },'start-calibration');
  control('Reset to default',()=>{try{calibration.begin(select.value);calibration.reset();select.disabled=true;save.disabled=false;feedback.textContent=calibration.state().message;}catch(error){feedback.textContent=error.message;}},'reset-controller');
  control('Cancel',closeController,'cancel-controller');
  save=control('Save',()=>{try{const persisted=calibration.save();if(persisted)closeController();else{feedback.textContent='Applied for this page only. Browser storage is unavailable; settings will not survive navigation.';save.disabled=true;}}catch(error){feedback.textContent=error.message;}},'save-controller');save.disabled=true;
  refresh();controllerDialog.showModal();actions.querySelector('button').focus();
 }
 controllerDialog.addEventListener('cancel',e=>{e.preventDefault();closeController();});
 const quitDialog=element(host,'dialog','quit-confirm');quitDialog.setAttribute('aria-label','Quit application?');
 let quitting=false,quitOpener=null,powerTimer=null;
 function closeQuit(){if(quitting)return;quitDialog.close();quitOpener?.focus();quitOpener=null;}
 function openQuit(){if(!platform.capabilities.quit||quitting)return;quitOpener=options.querySelector('.quit-app');quitDialog.setAttribute('aria-label','Quit application?');quitDialog.replaceChildren();const picture=element(quitDialog,'div','quit-picture');picture.innerHTML=icon('quit');const actions=element(quitDialog,'div','quit-actions');const cancel=button(actions,'back','Cancel quit',closeQuit,'cancel-quit');button(actions,'quit','Confirm quit',async()=>{if(quitting)return;quitting=true;try{await platform.quit();}catch{quitting=false;closeQuit();}},'confirm-quit');quitDialog.showModal();cancel.focus();}
 // The device goes dark once the host accepts, so a screen still lit well after
 // that means the request did not take.
 function openPower(mode,glyph,label,busyText,opener){
  if(!platform.capabilities.power||quitting)return;
  quitOpener=opener;quitDialog.setAttribute('aria-label',label+'?');quitDialog.replaceChildren();
  const picture=element(quitDialog,'div','quit-picture');picture.innerHTML=icon(glyph);
  const note=element(quitDialog,'p','power-note');note.setAttribute('role','status');note.textContent=label+'?';
  const actions=element(quitDialog,'div','quit-actions');
  const cancel=button(actions,'back','Cancel',closeQuit,'cancel-quit');
  const failed=()=>{win.clearTimeout(powerTimer);quitting=false;note.textContent='Could not '+label.toLowerCase()+'. Try again.';for(const b of actions.querySelectorAll('button'))b.disabled=false;cancel.focus();};
  button(actions,glyph,label,async()=>{
   if(quitting)return;quitting=true;note.textContent=busyText;for(const b of actions.querySelectorAll('button'))b.disabled=true;
   try{await platform.power(mode);if(!disposed)powerTimer=win.setTimeout(failed,30000);}catch{if(!disposed)failed();}
  },'confirm-quit');
  quitDialog.showModal();cancel.focus();
 }
 quitDialog.addEventListener('cancel',e=>{e.preventDefault();closeQuit();});
 const uninstallDialog=element(host,'dialog','uninstall-confirm');uninstallDialog.setAttribute('aria-label','Uninstall game? Saves are kept');
 let uninstallTarget=null,uninstallBusy=false,uninstallPreview=null;
 function closeUninstall(){if(uninstallBusy)return;uninstallDialog.close();uninstallTarget=null;refreshOwnership();detail.querySelector('.uninstall-game')?.focus();if(uninstallPreview?.isConnected&&!detail.hidden)uninstallPreview.play().catch(()=>{});uninstallPreview=null;}
 function openUninstall(game){
  if(!platform.capabilities?.uninstall||uninstallBusy||launchBusy||!library.some(x=>x.id===game.id))return;
  uninstallTarget={...game};const video=detail.querySelector('video');uninstallPreview=video&&!video.paused?video:null;pausePreview();uninstallDialog.replaceChildren();
  const picture=element(uninstallDialog,'div','uninstall-picture');const image=element(picture,'img');image.src=game.artwork;image.alt='';
  const symbol=element(picture,'span','uninstall-symbol');symbol.innerHTML=icon('trash');
  const actions=element(uninstallDialog,'div','uninstall-actions');const cancel=button(actions,'back','Cancel uninstall',closeUninstall,'cancel-uninstall');
  button(actions,'trash','Confirm uninstall; keep saves',confirmUninstall,'confirm-uninstall');
  uninstallDialog.showModal();cancel.focus();
 }
 async function confirmUninstall(){
  if(uninstallBusy||!uninstallTarget)return;
  const id=uninstallTarget.id;uninstallBusy=true;uninstallDialog.classList.add('busy');uninstallDialog.querySelector('.uninstall-error')?.remove();
  for(const b of uninstallDialog.querySelectorAll('button'))b.disabled=true;
  try{
   await gameUpdates.idle();await platform.uninstall(id);hideDetail();library=library.filter(game=>game.id!==id);if(state.view==='library')renderGrid();await refreshLibrary();
   try{catalog=await platform.catalog();failed.store=false;}catch{catalog=[];failed.store=true;}
   if(disposed)return;if(state.view==='store')renderGrid();uninstallBusy=false;closeUninstall();
   (shelf.querySelector('.game-card')||tabs[state.view]).focus();
  }catch{
   if(disposed)return;const failure=element(uninstallDialog,'span','uninstall-error');failure.setAttribute('role','status');failure.setAttribute('aria-label','Unable to uninstall; try again');failure.innerHTML=icon('alert');
   uninstallBusy=false;for(const b of uninstallDialog.querySelectorAll('button'))b.disabled=false;uninstallDialog.querySelector('.cancel-uninstall').focus();
  }finally{uninstallBusy=false;uninstallDialog.classList.remove('busy');for(const b of uninstallDialog.querySelectorAll('button'))b.disabled=false;if(!disposed)refreshOwnership();}
 }
 uninstallDialog.addEventListener('cancel',e=>{e.preventDefault();closeUninstall();});
 const saveDialog=element(host,'dialog','save-management');saveDialog.setAttribute('aria-label','Game saves');
 let saveBusy=false,saveIds=[];
 function closeSaveManagement(){if(saveBusy)return;saveDialog.close();adult=false;tabs.options.focus();}
 function saveText(parent,tag,text,cls){const node=element(parent,tag,cls);node.textContent=text;return node;}
 function saveButton(parent,label,fn,cls){const b=saveText(parent,'button',label,cls);b.type='button';b.addEventListener('click',fn);return b;}
 function saveTitle(id){return [...library,...catalog].find(game=>game.id===id)?.title||id;}
 function saveHeading(){saveDialog.replaceChildren();saveText(saveDialog,'h1','Game saves');}
 function renderSaveList(message=''){
  saveHeading();saveText(saveDialog,'p','Delete a game’s saved progress to start it fresh. The game stays installed.');
  const feedback=saveText(saveDialog,'p',message,'save-feedback');feedback.setAttribute('role','status');
  if(!saveIds.length)saveText(saveDialog,'p','No saved games.');
  const rows=element(saveDialog,'div','save-rows');
  for(const id of saveIds)saveButton(rows,saveTitle(id),()=>confirmSaveReset(id),'choose-save');
  saveButton(saveDialog,'Back',closeSaveManagement,'close-saves').focus();
 }
 function confirmSaveReset(id){
  if(saveBusy)return;saveHeading();saveText(saveDialog,'h2',saveTitle(id));
  saveText(saveDialog,'p','Delete all saved progress for this game? This cannot be undone. Other games and Cubby settings will not change.');
  const feedback=saveText(saveDialog,'p','','save-feedback');feedback.setAttribute('role','status');
  const actions=element(saveDialog,'div','save-actions');
  const cancel=saveButton(actions,'Cancel',()=>renderSaveList(),'cancel-reset');
  saveButton(actions,'Delete saves',async()=>{
   if(saveBusy)return;saveBusy=true;feedback.textContent='Deleting…';for(const b of saveDialog.querySelectorAll('button'))b.disabled=true;
   try{await platform.resetGameSaves(id);if(disposed)return;saveIds=saveIds.filter(saved=>saved!==id);saveBusy=false;renderSaveList('Saves deleted. This game will start fresh.');}
   catch{if(disposed)return;feedback.textContent='Saves could not be fully deleted. Try again.';for(const b of saveDialog.querySelectorAll('button'))b.disabled=false;cancel.focus();}
   finally{saveBusy=false;}
  },'confirm-reset');cancel.focus();
 }
 async function openSaveManagement(){
  if(adult)return;adult=true;saveHeading();saveText(saveDialog,'p','Loading saved games…');saveButton(saveDialog,'Back',closeSaveManagement,'close-saves');saveDialog.showModal();saveDialog.querySelector('button').focus();
  try{const ids=await platform.savedGames();if(disposed||!saveDialog.open)return;saveIds=ids;renderSaveList();}
  catch{if(disposed||!saveDialog.open)return;saveHeading();saveText(saveDialog,'p','Saved games could not be loaded. Close this page and try again.','save-feedback').setAttribute('role','status');saveButton(saveDialog,'Back',closeSaveManagement,'close-saves').focus();}
 }
 saveDialog.addEventListener('cancel',e=>{e.preventDefault();if(saveBusy)return;if(saveDialog.querySelector('.cancel-reset'))renderSaveList();else closeSaveManagement();});
 // The gear tab shows this keypad instead of settings until it is answered, and
 // locks again on leaving the tab. It is the tab's content, not a modal, so the
 // shoulder buttons and Back still move a wandering child straight on.
 let settingsUnlocked=false,gateSubmit=null;
 function renderGate(){
  const gate=element(options,'div','settings-gate');gate.setAttribute('role','group');gate.setAttribute('aria-label','Adult check');
  const question=element(gate,'h1','gate-question'),entry=element(gate,'output','gate-entry'),note=element(gate,'p','gate-feedback'),pad=element(gate,'div','gate-pad');note.setAttribute('role','status');
  let current,typed='';
  function ask(){current=challenge();question.textContent=current.text;typed='';entry.textContent='';}
  gateSubmit=()=>{if(!typed)return;if(typed===current.answer){settingsUnlocked=true;gateSubmit=null;renderOptions();focusView();return;}note.textContent='Try again.';ask();};
  for(const key of ['1','2','3','4','5','6','7','8','9','back','0','ok']){
   if(key==='back')button(pad,'backspace','Backspace',()=>{typed=typed.slice(0,-1);entry.textContent=typed;},'gate-erase');
   else if(key==='ok')button(pad,'check','Submit answer',()=>gateSubmit(),'gate-submit');
   else{const digit=element(pad,'button');digit.type='button';digit.textContent=key;digit.addEventListener('click',()=>{if(typed.length<2){typed+=key;entry.textContent=typed;note.textContent='';}});}
  }
  ask();
 }
 // A worded page is a separate document, so one marker carries the answered gate
 // back to it. It is spent on the next load whatever that load turns out to be.
 const settingsReturn='cubby:settings-return';
 function openSetting(href){if(href==='#adult-saves'){openSaveManagement();return;}try{win.sessionStorage.setItem(settingsReturn,'1');}catch{}win.location.href=href;}
 function returningToSettings(){try{const marked=win.sessionStorage.getItem(settingsReturn)==='1';win.sessionStorage.removeItem(settingsReturn);return marked&&win.location?.hash==='#options';}catch{return false;}}

 const views=['library','store','options'],tabs={};let pendingTabFocus=null;for(const name of views)tabs[name]=button(nav,name,name,()=>activateView(name),'view-tab');
 function show(view,initial=false){if(adult)return;if(view!=='options')settingsUnlocked=false;pendingTabFocus=null;if(!initial)initialViewPending=false;pausePreview();state.show(view);tabs[view].setAttribute('aria-current','page');nav.style.setProperty('--active',views.indexOf(view));Object.keys(tabs).filter(x=>x!==view).forEach(x=>tabs[x].removeAttribute('aria-current'));body.hidden=view==='options';options.hidden=view!=='options';detail.hidden=true;body.classList.remove('has-detail');if(view==='options')renderOptions();else renderGrid();}
 // Activating a tab enters its content; merely navigating across tabs does not.
 function selectedCard(){const cards=Array.from(shelf.querySelectorAll('.game-card')).filter(card=>!card.disabled);return cards.find(card=>card.dataset.gameId===state.detail?.id)||cards[0];}
 function focusView(){(state.view==='options'?options.querySelector('button:not(:disabled)'):selectedCard())?.focus();}
 function activateView(view,initial=false){if(adult)return;show(view,initial);tabs[view].focus();focusView();if(loading[view])pendingTabFocus=view;}
 function finishTabFocus(view){if(pendingTabFocus!==view)return;pendingTabFocus=null;if(state.view===view&&doc.activeElement===tabs[view])focusView();}
 function primaryAction(){return detail.querySelector('.play-game:not(:disabled),.download-game:not(:disabled)')||detail.querySelector('.favorite');}
 function pausePreview(){detail.querySelector('video')?.pause();}
 function entries(){return state.view==='store'?catalog:library;}
 function ownedInStore(id){return state.view==='store'&&library.some(x=>x.id===id);}
 function badgeFor(id){return ownedInStore(id)?icon('check'):state.isFavorite(id)?icon('star'):'';}
 function setBadge(badge,id){badge.innerHTML=badgeFor(id);badge.dataset.kind=ownedInStore(id)?'installed':state.isFavorite(id)?'favorite':'';}
 // A Store game already in the Library is only a picture: checked, dimmed, and skipped by every control.
 function setOwned(card){const id=card.dataset.gameId,owned=ownedInStore(id);card.disabled=owned;card.classList.toggle('is-owned',owned);card.setAttribute('aria-label',owned?'In library':'Preview game');const badge=card.querySelector('.card-badge');if(badge)setBadge(badge,id);}
 // The hero always shows a game: the open preview, or a resting cover that invites a pick below.
 function feature(game){featured=game||null;const art=game?.artwork||'';if(restArt.getAttribute('src')!==art){if(art)restArt.src=art;else restArt.removeAttribute('src');}backdrop.style.backgroundImage=art?'url("'+art.replace(/["\\]/g,'\\$&')+'")':'';markSelection();}
 function markSelection(){const id=detail.hidden?(state.view==='library'?featured?.id:null):state.detail?.id;shelf.classList.toggle('has-selection',!!id);for(const card of shelf.querySelectorAll('.game-card'))card.classList.toggle('is-selected',card.dataset.gameId===id);}
 function renderGrid(){shelf.replaceChildren();const status=loading[state.view]?'loading':failed[state.view]?'error':!entries().length?'empty':'';body.classList.toggle('is-status',!!status);
 const store=state.view==='store',offer=store?catalog.find(g=>!ownedInStore(g.id)):null;body.classList.toggle('all-owned',store&&!status&&!offer);
 if(status){hideDetail();const box=element(shelf,'div','shelf-status '+status);box.setAttribute('role','status');box.setAttribute('aria-label',status==='loading'?'Loading':status==='error'?'Unable to load games':'No games');box.innerHTML='<span class="status-art">'+icon(status)+'</span>'+(status==='loading'?'<span class="status-dots"><i></i><i></i><i></i></span>':'');feature(null);return;}
 for(const game of store?[...catalog].sort((a,b)=>ownedInStore(a.id)-ownedInStore(b.id)):entries()){
 const card=button(shelf,'play','Preview game',()=>preview(game),'game-card');card.dataset.gameId=game.id;card.replaceChildren();const image=element(card,'img');image.src=game.artwork;image.alt='';
 element(card,'span','card-badge');setOwned(card);
 card.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')preview(game);});card.addEventListener('focus',()=>preview(game));
 }
 // Library always starts with a selection and keeps it through refreshes.
 const keep=entries().find(g=>g.id===(state.detail?.id||(state.view==='library'?returningGame:null)||featured?.id));
 if(state.view==='library'){returningGame=null;preview(keep||entries()[0]);markSelection();return;}
 // Store keeps a valid offer or opens its first; with none left it rests on a covered check.
 if(store&&!state.detail){if(offer)preview(keep&&!ownedInStore(keep.id)?keep:offer);else{hideDetail();feature(entries()[0]);}return;}
 feature(keep||entries()[0]);}
 function preview(game){if(state.detail?.id===game.id&&!detail.hidden)return;pausePreview();state.select(game);detail.replaceChildren();detail.hidden=false;body.classList.add('has-detail');
 const stage=element(detail,'div','stage');
 button(stage,'back','Return to games',()=>returnToGames(),'detail-close');
 const media=doc.createElement(game.attract?'video':'img');media.className='preview-media';if(game.attract)media.poster=game.artwork;media.src=game.attract||game.artwork;if(game.attract){media.autoplay=true;media.muted=true;media.addEventListener('ended',()=>{media.load();media.play().catch(()=>{});});media.playsInline=true;media.setAttribute('playsinline','');media.addEventListener('error',()=>{const image=doc.createElement('img');image.className='preview-media';image.src=game.artwork;image.alt='';media.replaceWith(image);});}else media.alt='';stage.appendChild(media);if(game.attract)media.play().catch(()=>{});
 const actions=element(detail,'div','detail-actions');
 const star=button(actions,'star','Favorite',()=>{state.favorite(game.id);star.setAttribute('aria-pressed',String(state.isFavorite(game.id)));const badge=shelf.querySelector('[data-game-id="'+game.id+'"] .card-badge');if(badge)setBadge(badge,game.id);},'favorite');star.setAttribute('aria-pressed',String(state.isFavorite(game.id)));
 feature(game);
 refreshOwnership();
 }
 // Update ownership in place: asynchronous Library discovery must not restart the
 // Store trailer or steal focus from its favorite/back controls.
 function refreshOwnership(){
 for(const card of shelf.querySelectorAll('.game-card'))setOwned(card);
 if(detail.hidden||!state.detail)return;
 const actions=detail.querySelector('.detail-actions'),installed=library.find(x=>x.id===state.detail.id);if(!actions)return;
 if(installed){if(platform.capabilities?.uninstall&&!actions.querySelector('.uninstall-game'))button(actions,'trash','Uninstall game',()=>openUninstall(installed),'uninstall-game');const remove=actions.querySelector('.uninstall-game'),phase=installStates[installed.id]?.phase;if(remove)remove.disabled=launchBusy||uninstallBusy||['checking','downloading','verifying','pending','uninstalling'].includes(phase);const previous=actions.querySelector('.download-game'),focused=previous===doc.activeElement;actions.querySelector('.not-installed')?.remove();previous?.remove();actions.querySelector('.install-progress')?.remove();if(!actions.querySelector('.play-game'))button(actions,'play','Play game',()=>launch(installed.id),'play-game');if(focused)actions.querySelector('.play-game')?.focus();const play=actions.querySelector('.play-game');if(platform.capabilities?.tokens){play.disabled=launchBusy||!account?.available||account.balance<1;play.setAttribute('aria-label',account?.balance===0?'No tokens; adult refill needed':account?.launchFailed?'Retry game launch for one token':'Play game for one token');play.innerHTML=icon(account?.launchFailed?'retry':'play')+icon('token');let failure=actions.querySelector('.launch-error');if(account?.launchFailed&&!failure){failure=element(actions,'span','launch-error');failure.setAttribute('aria-label','Launch failed; no token spent');failure.innerHTML=icon('alert');}else if(!account?.launchFailed)failure?.remove();}}
 else if(platform.capabilities?.install&&state.detail.manifest_url){
  actions.querySelector('.play-game')?.remove();actions.querySelector('.uninstall-game')?.remove();actions.querySelector('.launch-error')?.remove();
  actions.querySelector('.not-installed')?.remove();
  let download=actions.querySelector('.download-game');
  if(!download)download=button(actions,'down','Download game',()=>installGame(state.detail.id),'download-game');
  const status=installStates[state.detail.id],busy=status&&['checking','downloading','verifying','pending'].includes(status.phase);
  const glyph=status?.phase==='error'?'retry':busy?'loading':'down';
  // Keep the same SVG through progress events so its rotation never restarts.
  if(download.dataset.glyph!==glyph){download.innerHTML=icon(glyph);download.dataset.glyph=glyph;}
  download.disabled=!!busy;download.classList.toggle('loading',!!busy);download.setAttribute('aria-label',status?.phase==='error'?'Retry download':busy?'Downloading game':'Download game');
  let progress=actions.querySelector('.install-progress');if(!progress){progress=element(actions,'progress','install-progress');progress.setAttribute('aria-label','Download progress');}
  progress.hidden=!busy;if(status?.total){progress.max=status.total;progress.value=status.received||0;}else progress.removeAttribute('value');
 }
 else if(!actions.querySelector('.not-installed')){actions.querySelector('.play-game')?.remove();actions.querySelector('.uninstall-game')?.remove();const status=element(actions,'span','not-installed');status.setAttribute('aria-label','Not installed; adult installation required');status.innerHTML=icon('down');}
 }
 // Owned games can't stay selected in the Store. A download the child just finished
 // hands off to its Library card; otherwise the selection moves to the next offer.
 function settleStore(){if(!state.detail||!ownedInStore(state.detail.id))return;if(requested===state.detail.id){requested=null;activateView('library');}else{const active=doc.activeElement,restore=active?.classList.contains('game-card')||!!active?.closest('.detail');hideDetail();renderGrid();if(restore)(selectedCard()||tabs.store).focus();}}
 async function refreshLibrary(){try{const entries=await platform.library();if(disposed)return;const changed=JSON.stringify(entries)!==JSON.stringify(library);library=entries;settleStore();if(changed&&state.view==='library'){const focusedId=doc.activeElement?.classList.contains('game-card')?doc.activeElement.dataset.gameId:null;renderGrid();if(focusedId)(selectedCard()||tabs.library).focus();}refreshOwnership();}catch{/* Keep the installed library usable on a failed refresh. */}}
 let catalogChecking=null;
 function refreshCatalog(options={}){
  if(disposed||loading.store)return Promise.resolve();
  if(catalogChecking)return catalogChecking;
  catalogChecking=(async()=>{
   try{
    const entries=await platform.catalog(options);if(disposed||options.signal?.aborted)return;
    const changed=failed.store||JSON.stringify(entries)!==JSON.stringify(catalog);catalog=entries;failed.store=false;
    if(!changed||state.view!=='store')return;
    const active=doc.activeElement,focusedId=active?.classList.contains('game-card')?active.dataset.gameId:null;
    const removed=state.detail&&!catalog.some(game=>game.id===state.detail.id);
    const detailFocused=!!active?.closest('.detail');
    if(removed)hideDetail();else if(state.detail)state.detail=catalog.find(game=>game.id===state.detail.id);
    renderGrid();refreshOwnership();
    if(focusedId)(selectedCard()||tabs.store).focus();
    else if(removed&&detailFocused)(selectedCard()||tabs.store).focus();
   }catch{/* Keep the existing shelf usable until the next poll succeeds. */}
  })().finally(()=>catalogChecking=null);return catalogChecking;
 }
 const stopCatalog=startCatalogChecks(win,refreshCatalog);
 async function installGame(id){if(disposed)return;requested=id;installStates[id]={phase:'checking'};refreshOwnership();try{await gameUpdates.idle();await platform.install(id);await refreshLibrary();}catch{installStates[id]={phase:'error'};refreshOwnership();}}
 const unsubscribeInstall=platform.onInstallState?.(states=>{if(disposed)return;const installedChanged=Object.entries(states).some(([id,s])=>s.phase==='installed'&&(installStates[id]?.phase!=='installed'||installStates[id]?.version!==s.version));installStates=states;refreshOwnership();if(installedChanged)refreshLibrary();});
 platform.installStatus?.().then(states=>{if(!disposed){installStates=states;refreshOwnership();}}).catch(()=>{});
 const gameUpdates=startGameUpdates(win,platform);
 function hideDetail(){pausePreview();detail.replaceChildren();state.detail=null;detail.hidden=true;body.classList.remove('has-detail');markSelection();}
 // Back changes focus, not selection: a populated shelf always has usable actions.
 function returnToGames(toTab=false){const card=shelf.querySelector('[data-game-id="'+state.detail?.id+'"]');(toTab?tabs[state.view]:card||tabs[state.view]).focus();}
 function renderOptions(){options.replaceChildren();gateSubmit=null;
 if(!settingsUnlocked){renderGate();return;}
 // Every tile shares one wrapping grid, so a handheld's short screen fits them in two rows.
 // Most used first: the host's pages in its order, then one-time controller setup, then power last.
 const tiles=element(options,'div','settings-tiles'),controller=()=>{if(calibration)button(tiles,'controller','Adult controller setup',openController,'controller-settings settings-tile');};
 // Device hosts have physical controls and their own adult pages, so they list
 // those here; key remapping only applies to hosts with a real keyboard.
 if(platform.settings?.length){for(const entry of platform.settings){const tile=button(tiles,entry.icon,entry.label,()=>openSetting(entry.href),'settings-tile');if(entry.notice)tile.dataset.notice='';}controller();if(platform.capabilities.quit)button(options,'quit','Quit application',openQuit,'quit-app');if(platform.capabilities.power){const restart=button(tiles,'retry','Restart',()=>openPower('reboot','retry','Restart','Restarting…',restart),'settings-tile restart-device'),off=button(tiles,'quit','Power off',()=>openPower('poweroff','quit','Power off','Powering off…',off),'settings-tile power-off');}showNotice();showVersion();return;}
 controller();if(platform.capabilities.quit)button(options,'quit','Quit application',openQuit,'quit-app');
 button(options,'trash','Manage game saves',()=>openSetting('#adult-saves'),'manage-saves settings-tile');
 const setup=element(options,'div','adult-entry');const b=button(setup,'keyboard','Adult keyboard setup',openAdult);b.insertAdjacentHTML('beforeend',icon('adult'));
 }
 // A quiet badge for adults: gear tab, then the tile that needs attention.
 let notice=false,noticeTimer=null;
 function showNotice(){for(const target of [tabs.options,options.querySelector('[data-notice]')]){target?.classList.toggle('has-notice',notice);if(notice)target?.setAttribute('aria-description','Update available');else target?.removeAttribute('aria-description');}}
 async function refreshNotice(){try{notice=!!(await platform.updateAttention()).attention;}catch{notice=false;}if(!disposed)showNotice();}
 if(platform.updateAttention){refreshNotice();noticeTimer=win.setInterval(refreshNotice,60000);}
 let appVersion='';
 function showVersion(){if(!settingsUnlocked||!appVersion||options.querySelector('.app-version'))return;element(options,'span','app-version').textContent=appVersion;}
 platform.version?.().then(value=>{appVersion=value?.version||'';if(!disposed)showVersion();}).catch(()=>{});
 function stopCapture(){if(cancelCapture){cancelCapture();cancelCapture=null;}}
 function closeAdult(apply){stopCapture();if(draft){if(apply)draft.apply();else draft.cancel();}draft=null;adult=false;dialog.close();tabs.options.focus();}
 function openAdult(){if(adult)return;adult=true;draft=prefs.editKeyboard();dialog.replaceChildren();const heading=element(dialog,'h1');heading.textContent='Adult setup';const instruction=element(dialog,'p','adult-lead');instruction.textContent='Choose a control, then press a key. Changes apply only when saved.';
 const rows=element(dialog,'div','key-rows');const feedback=element(dialog,'p','key-feedback');feedback.setAttribute('role','status');
 function renderRows(){rows.replaceChildren();for(const name of win.HandheldPreferences.BUTTONS){const b=doc.createElement('button');b.type='button';b.dataset.binding=name;const keys=draft.get()[name].join(' / ');element(b,'span','key-name').textContent=name;element(b,'span','key-codes').textContent=keys;b.setAttribute('aria-label',name+' · '+keys);b.addEventListener('click',()=>{stopCapture();feedback.textContent='Press a key for '+name+'. Use Cancel capture to stop.';b.classList.add('capturing');cancelCapture=input.captureKeyboard(code=>{try{draft.setBinding(name,[code]);stopCapture();feedback.textContent='';renderRows();rows.querySelector('[data-binding="'+name+'"]').focus();}catch{feedback.textContent='That key is already assigned. Choose another key or cancel capture.';}});});rows.appendChild(b);}}
 if(platform.capabilities?.tokens){const refill=element(dialog,'button','refill-tokens');refill.type='button';refill.textContent='Add 10 test tokens';refill.addEventListener('click',async()=>{refill.disabled=true;try{account=await platform.refillTokens();renderAccount();feedback.textContent='Test tokens added.';}catch{feedback.textContent='Token account unavailable.';}finally{refill.disabled=false;}});}
 renderRows();const actions=element(dialog,'div','adult-actions');
 for(const [label,fn,cls] of [['Cancel capture',()=>{stopCapture();feedback.textContent='';renderRows();}],['Reset keys',()=>{stopCapture();draft.reset();feedback.textContent='';renderRows();}],['Cancel',()=>closeAdult(false)],['Save',()=>closeAdult(true),'primary']]){const b=element(actions,'button',cls);b.type='button';b.textContent=label;b.addEventListener('click',fn);}
 dialog.showModal();dialog.querySelector('button').focus();}
 dialog.addEventListener('cancel',e=>{e.preventDefault();closeAdult(false);});
 const input=win.HandheldInput.createInput({repeat:true,navigationShoulders:true,onAction:event=>{const a=event.action;if(controllerDialog.open){if(event.source==='gamepad')return;if(a==='back'||a==='exit')closeController();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const nodes=Array.from(controllerDialog.querySelectorAll('button')).filter(b=>!b.disabled),index=nodes.indexOf(doc.activeElement);nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();}return;}if(uninstallDialog.open){if(uninstallBusy)return;const nodes=Array.from(uninstallDialog.querySelectorAll('button'));if(a==='back'||a==='exit')closeUninstall();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const index=nodes.indexOf(doc.activeElement);nodes[(index+1)%nodes.length]?.focus();}return;}if(quitDialog.open){if(quitting)return;const nodes=Array.from(quitDialog.querySelectorAll('button'));if(a==='back'||a==='exit')closeQuit();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const index=nodes.indexOf(doc.activeElement);nodes[(index+1)%nodes.length]?.focus();}return;}if(saveDialog.open){if(saveBusy)return;const nodes=Array.from(saveDialog.querySelectorAll('button')).filter(b=>!b.disabled),index=nodes.indexOf(doc.activeElement);if(a==='back'||a==='exit'){if(saveDialog.querySelector('.cancel-reset'))renderSaveList();else closeSaveManagement();}else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a))nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();return;}if(adult){const nodes=Array.from(dialog.querySelectorAll('button')),index=nodes.indexOf(doc.activeElement);if(a==='back'||a==='exit')closeAdult(false);else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a))nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();return;}
 if(a==='exit'||a==='back'){if(!detail.hidden)returnToGames(doc.activeElement?.classList.contains('game-card')||doc.activeElement===tabs[state.view]);else activateView('library');return;}
 if(a==='select'||a==='nextView'||a==='previousView'){activateView(views[(views.indexOf(state.view)+(a==='previousView'?2:1))%3]);return;}
 const padKeys=Array.from(doc.activeElement?.closest?.('.gate-pad')?.querySelectorAll('button')||[]);
 if(padKeys.length){if(a==='pause'){gateSubmit?.();return;}if(['left','right','up','down'].includes(a)){const i=padKeys.indexOf(doc.activeElement),row=i-i%3;if(a==='up'&&i<3)tabs.options.focus();else padKeys[a==='left'?row+(i+2)%3:a==='right'?row+(i+1)%3:a==='up'?i-3:(i+3)%12]?.focus();return;}}
 const nodes=Array.from(host.querySelectorAll('button')).filter(b=>!b.closest('[hidden]')&&!b.closest('dialog')&&!b.disabled);if(!nodes.length)return;
 const active=doc.activeElement,index=nodes.indexOf(active);
 if(a==='confirm'||a==='pause'){if(index<0){const first=shelf.querySelector('.game-card:not(:disabled)')||nodes[0];first.focus();}else if(active.classList.contains('game-card')){preview(entries().find(g=>g.id===active.dataset.gameId));detail.querySelector('.play-game:not(:disabled),.download-game:not(:disabled)')?.focus();}else active.click();return;}
 if(['left','right','up','down'].includes(a)){const origin=active?.getBoundingClientRect(),horizontal=a==='left'||a==='right',positive=a==='right'||a==='down';let next;if(origin&&index>=0){const x=origin.left+origin.width/2,y=origin.top+origin.height/2;const inShelf=active.classList.contains('game-card');const candidates=nodes.filter(n=>n!==active&&(!horizontal||!inShelf||n.classList.contains('game-card'))).map(n=>{const r=n.getBoundingClientRect(),dx=r.left+r.width/2-x,dy=r.top+r.height/2-y,primary=horizontal?dx:dy,secondary=horizontal?dy:dx;return {n,primary,score:Math.abs(primary)+Math.abs(secondary)*2};}).filter(c=>positive?c.primary>4:c.primary < -4).sort((a,b)=>a.score-b.score);next=candidates[0]?.n;}if(!detail.hidden){if(a==='up'&&active?.classList.contains('game-card')&&!next?.classList.contains('game-card'))next=primaryAction()||next;else if(a==='right'&&active?.classList.contains('detail-close'))next=primaryAction()||next;else if(active?.closest('.detail-actions')){if(a==='down'&&!next?.closest('.detail-actions'))next=shelf.querySelector('.game-card.is-selected')||next;else if(a==='left'&&!next?.closest('.detail-actions'))next=detail.querySelector('.detail-close')||next;}}if(!next&&(active?.classList.contains('game-card')||!horizontal&&active?.classList.contains('view-tab')))return;if(a==='up'&&next?.classList.contains('view-tab')&&!active?.classList.contains('view-tab'))next=tabs[state.view];if(!next){const delta=positive?1:-1;next=nodes[(index+delta+nodes.length)%nodes.length];}next.focus();}
 }});
 function dispose(){if(disposed)return;disposed=true;if(controllerDialog.open)calibration?.cancel();stopCatalog();gameUpdates.stop();stopBattery();win.clearInterval?.(noticeTimer);win.clearTimeout?.(powerTimer);pausePreview();stopCapture();unsubscribeInstall?.();unsubscribeAccount?.();input.dispose();win.removeEventListener('pagehide',dispose);win.removeEventListener('hashchange',openSettingsFromHash);win.removeEventListener('blur',pausePreview);win.removeEventListener('focus',resumePreview);}
 function resumePreview(){if(!detail.hidden&&!uninstallDialog.open)detail.querySelector('video')?.play().catch(()=>{});}
 win.addEventListener('pagehide',dispose);
 win.addEventListener('blur',pausePreview);win.addEventListener('focus',resumePreview);
 // Only initial discovery may choose Store; explicit navigation always wins.
 for(const [view,request] of [['library',platform.library()],['store',platform.catalog()]])request.then(entries=>{if(disposed)return;if(view==='library')library=entries;else catalog=entries;loading[view]=false;if(view==='library'&&initialViewPending&&!entries.length){const stayed=doc.activeElement===tabs.library;show('store');if(stayed){tabs.store.focus();focusView();if(loading.store)pendingTabFocus='store';}}else if(state.view===view)renderGrid();if(view==='library'){initialViewPending=false;settleStore();refreshOwnership();}finishTabFocus(view);}).catch(()=>{if(disposed)return;failed[view]=true;loading[view]=false;if(view==='library')initialViewPending=false;if(state.view===view)renderGrid();finishTabFocus(view);});
 // Adult pages return here so Back lands where the adult left, not on the library.
 function openSettingsFromHash(){if(win.location?.hash!=='#options'||quitDialog.open)return;initialViewPending=false;show('options');options.querySelector('button')?.focus();win.history.replaceState(null,'',win.location.pathname);}
 settingsUnlocked=returningToSettings();activateView(win.location?.hash==='#options'?'options':'library',true);openSettingsFromHash();win.addEventListener('hashchange',openSettingsFromHash);
 win.fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'picker',errors:[]})}).catch(()=>{});
 return {state,show,dispose,refreshCatalog};
}
return {createState,mount,challenge,startBattery,startCatalogChecks,startGameUpdates,sweepGameUpdates};
});

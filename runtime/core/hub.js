/* Shared, wordless discovery UI. Adult keyboard setup is deliberately separate. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HandheldHub=api;})(globalThis,function(){
'use strict';
const favoriteKey='handheld:favorites:v1';
function createState(storage){
 let favorites=[];
 function load(next){storage=next;favorites=[];try{const value=JSON.parse(storage?.getItem(favoriteKey)||'[]');if(Array.isArray(value))favorites=value.filter(x=>typeof x==='string');}catch{}}
 load(storage);
 // Favorites belong to a player: switching player loads theirs.
 return {view:'library',detail:null,load,show(view){if(!['library','store','options'].includes(view))throw Error('Unknown view');this.view=view;this.detail=null;},select(game){this.detail=game;},isFavorite:id=>favorites.includes(id),favorite(id){favorites=favorites.includes(id)?favorites.filter(x=>x!==id):[...favorites,id];try{storage?.setItem(favoriteKey,JSON.stringify(favorites));}catch{}return favorites.includes(id);}};
}
const paths={controller:'M7 7h10q4 0 5 11l-2 2-5-4H9l-5 4-2-2Q3 7 7 7ZM6 10v5M3.5 12.5h5M16 11h.01M19 14h.01',trash:'M3 6h18M9 6V3h6v3M6 6l1 16h10l1-16M10 10v7M14 10v7',token:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 6.6l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5Z',library:'M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v7H3zM14 15h7v7h-7z',store:'M4 8h16l1 14H3ZM8 8V6a4 4 0 0 1 8 0v2',options:'M10.2 4.51 10.07 1.58h3.86L13.8 4.51l2.22.92 1.98-2.17L20.74 6l-2.17 1.98.92 2.22 2.93-.13v3.86l-2.93-.13-.92 2.22L20.74 18 18 20.74l-1.98-2.17-2.22.92.13 2.93h-3.86l.13-2.93-2.22-.92L6 20.74 3.26 18l2.17-1.98-.92-2.22-2.93.13v-3.86l2.93.13.92-2.22L3.26 6 6 3.26l1.98 2.17ZM12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z',wifi:'M2 9.5a15 15 0 0 1 20 0M5.5 13a10 10 0 0 1 13 0M9 16.5a5 5 0 0 1 6 0M12 20h.01',update:'M3 11 12 3l9 8v10H3ZM12 18v-7M8.5 14.5 12 11l3.5 3.5',retry:'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',play:'m8 4 13 8-13 8Z',back:'m14 4-8 8 8 8M6 12h16',star:'m12 2 3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1Z',check:'m4 12 5 5L21 5',pencil:'M15.5 4.5l4 4L8 20H4v-4ZM13 7l4 4',swap:'M4 9a8 8 0 0 1 14-4l2 2M20 3v4h-4M20 15a8 8 0 0 1-14 4l-2-2M4 21v-4h4',plus:'M12 5v14M5 12h14',players:'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2 21v-1.5A5.5 5.5 0 0 1 7.5 14h3a5.5 5.5 0 0 1 5.5 5.5V21M16 4.3a3.5 3.5 0 0 1 0 6.4M19 14.4a5.5 5.5 0 0 1 3 4.9V21',keyboard:'M2 5h20v14H2ZM5 9h2m2 0h2m2 0h2m2 0h2M5 13h2m2 0h2m2 0h2m2 0h2M7 16h10',adult:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM5 23v-5a7 7 0 0 1 14 0v5',empty:'M3 9h18v12H3ZM3 9l3-5h12l3 5M9 13h6',error:'M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9ZM9.5 12.5h.01M14.5 12.5h.01M9.5 16.2q2.5-2 5 0',quit:'M12 2v10M6 5a9 9 0 1 0 12 0',cancel:'m5 5 14 14M19 5 5 19',loading:'M12 3a9 9 0 1 1-9 9',down:'M12 2v13m-5-5 5 5 5-5M3 18v4h18v-4',pick:'m6 9 6 6 6-6',alert:'m12 2 11 20H1ZM12 8v6m0 3v1',backspace:'M9 5h12v14H9l-6-7ZM12 9.5l5 5M17 9.5l-5 5',raise:'m6 15 6-6 6 6',lower:'m6 9 6 6 6-6',tag:'M3 3h8l10 10-8 8L3 11ZM7.5 7.5h.01',link:'M10 14a4.2 4.2 0 0 0 6 0l3.5-3.5a4.2 4.2 0 0 0-6-6L12 6M14 10a4.2 4.2 0 0 0-6 0l-3.5 3.5a4.2 4.2 0 0 0 6 6L12 18',unlink:'M13.5 6.5 15 5a4.2 4.2 0 0 1 6 6l-1.5 1.5M10.5 17.5 9 19a4.2 4.2 0 0 1-6-6l1.5-1.5M8 2v3M2 8h3M16 22v-3M22 16h-3',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2'};
function faceArt(avatar,Avatars){return avatar==='cubby'?cubbyFace:Avatars.svg(avatar);}
function icon(name){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
// Picture-only brand mark: a smiling cubby house.
const brandArt='<path class="brand-roof" d="M24 3.5 44 18.5V39a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V18.5Z"/><rect class="brand-door" x="11" y="20" width="26" height="18" rx="6"/><g class="brand-face"><circle cx="19" cy="27.5" r="2.4"/><circle cx="29" cy="27.5" r="2.4"/><path d="M19.5 32.5q4.5 3.4 9 0"/></g>';
const brand='<svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true">'+brandArt+'</svg>';
// A fresh Cubby's one player wears this same house, on a round token like the animals.
const cubbyFace='<svg class="avatar-art cubby-art" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="#4b3a73"/><svg x="17" y="13" width="66" height="66" viewBox="0 0 48 48">'+brandArt+'</svg><circle cx="50" cy="50" r="48.5" fill="none" stroke="#000" stroke-width="3" opacity=".12"/></svg>';
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
  if(platform.updateOffer ? await platform.updateOffer(id) : offered.has(id))try{await platform.update(id,{signal});}catch{/* Current release stays playable. */}
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
// Explicit starter policy is shared by every hub host. A successful seed is
// remembered independently of library emptiness, so uninstall stays intentional.
async function prepareStarter(platform,{id,storage}={}){
 if(!id||!platform.install)return 'disabled';
 if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id))throw Error('Invalid starter game');
 if(!storage)throw Error('Starter storage unavailable');
 const key='cubby:starter:v1:'+id;
 if(storage.getItem(key)==='1')return 'done';
 const present=(await platform.library()).some(game=>game.id===id);
 if(!present){
  await platform.install(id);
  if(!(await platform.library()).some(game=>game.id===id))throw Error('Starter not installed');
 }
 storage.setItem(key,'1');return present?'present':'installed';
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
 const doc=host.ownerDocument,win=doc.defaultView;let storage,session;try{storage=win.localStorage;}catch{}try{session=win.sessionStorage;}catch{}
 const prefs=win.HandheldPreferences.preferences,platform=win.HandheldPlatform.createPlatform(win.HandheldPlatformOptions);
 // Players: null on a host that can't keep them apart, where Cubby has one player.
 const Avatars=win.HandheldAvatars,profiles=platform.capabilities?.profiles&&win.HandheldProfiles&&Avatars?win.HandheldProfiles.createProfiles({storage,session,platform}):null;
 let profile=profiles?.current();
 const state=createState(profiles?profiles.storageFor(profile):storage);
 const starterGame=win.HandheldPlatformOptions?.starterGame;let starterPending=!!starterGame,starterFailed=false;
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
 // A game runs as the player chosen here: the host has to agree before it starts.
 async function launch(id){if(launchBusy)return;const latest=library.find(game=>game.id===id);if(!latest)return;try{win.sessionStorage.setItem(gameReturn,id);}catch{}if(!platform.capabilities?.tokens){if(profiles){launchBusy=true;try{await profiles.enter(profile);}catch{return;}finally{launchBusy=false;}}win.location.href=latest.entrypoint;return;}const opener=doc.activeElement;let launched=false;launchBusy=true;refreshOwnership();try{if(profiles)await profiles.enter(profile);await platform.launch(id);launched=true;}catch{await readAccount();}finally{launchBusy=false;if(!disposed){refreshOwnership();if(launched&&doc.activeElement===opener&&state.view==='library'&&state.detail?.id===id)focusView();}}}
 const unsubscribeAccount=platform.onAccountState?.(value=>{account=value;if(!disposed)renderAccount();});
 if(platform.capabilities?.tokens)readAccount();
 const controllerDialog=element(host,'dialog','controller-setup');controllerDialog.setAttribute('aria-label','Adult controller setup');controllerDialog.tabIndex=-1;
 const calibration=win.HandheldOSD?.calibration;let calibrationTimer=null,rejectTimer=null;
 function closeController(){win.clearTimeout(calibrationTimer);win.clearTimeout(rejectTimer);calibrationTimer=rejectTimer=null;calibration?.cancel();if(controllerDialog.open)controllerDialog.close();options.querySelector('.controller-settings')?.focus();}
 // The controller runs its own setup: press the printed A, B, X, Y and it saves
 // and closes. Start (on a standard pad) or ten idle seconds leave it unchanged;
 // the close button and Escape are extras for a mouse, touch or keyboard.
 function openController(){
  if(!settingsUnlocked||!calibration||controllerDialog.open)return;
  controllerDialog.replaceChildren();
  const close=element(controllerDialog,'button','cancel-controller');close.type='button';close.setAttribute('aria-label','Cancel');close.innerHTML=icon('cancel');close.addEventListener('click',closeController);
  // Wordless: the big glyph is the prompt, a check or alert is the result.
  const prompt=element(controllerDialog,'div','calibration-prompt'),row=element(controllerDialog,'div','calibration-row');
  prompt.setAttribute('role','status');
  const glyphs=['A','B','X','Y'].map(letter=>{const glyph=element(row,'span','calibration-glyph');glyph.textContent=letter;return glyph;});
  let rejected=0;
  function render(step){
   if(!controllerDialog.open)return;
   if(step.phase==='cancelled'||step.phase==='timeout'){closeController();return;}
   const done=step.phase==='saved';
   glyphs.forEach((glyph,i)=>{glyph.classList.toggle('is-set',done||i<step.captured.length);glyph.classList.toggle('is-next',glyph.textContent===step.next);});
   prompt.classList.toggle('waiting',!done&&!step.ready);prompt.classList.toggle('done',done);
   if(step.rejected!==rejected){rejected=step.rejected;prompt.classList.add('rejected');win.clearTimeout(rejectTimer);rejectTimer=win.setTimeout(()=>prompt.classList.remove('rejected'),400);}
   if(done){
    // Storage can be denied in a browser: the mapping still applies until the page changes.
    prompt.innerHTML=icon(step.persisted?'check':'alert');prompt.classList.toggle('unsaved',!step.persisted);prompt.setAttribute('aria-label',step.persisted?'Saved':'Saved for this page only');
    calibrationTimer=win.setTimeout(closeController,step.persisted?1000:3000);
   }else{prompt.textContent=step.next;prompt.setAttribute('aria-label','Press '+step.next);}
  }
  win.HandheldOSD.reset?.();controllerDialog.showModal();controllerDialog.focus();calibration.begin(render);
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
 // With more than one player, the adult first picks whose saves; saveProfile is
 // that player, or undefined on a Cubby with one player, exactly as before players.
 let saveBusy=false,saveIds=[],saveProfile;
 const manyPlayers=()=>!!profiles&&profiles.list().length>1;
 function closeSaveManagement(){if(saveBusy)return;saveDialog.close();adult=false;tabs.options.focus();}
 function saveBack(){if(saveDialog.querySelector('.cancel-reset'))renderSaveList();else if(saveDialog.querySelector('.choose-save,.close-saves')&&saveProfile&&manyPlayers())renderSavePlayers();else closeSaveManagement();}
 function saveText(parent,tag,text,cls){const node=element(parent,tag,cls);node.textContent=text;return node;}
 function saveButton(parent,label,fn,cls){const b=saveText(parent,'button',label,cls);b.type='button';b.addEventListener('click',fn);return b;}
 function saveTitle(id){return [...library,...catalog].find(game=>game.id===id)?.title||id;}
 function playerName(id){return profiles?.list().find(x=>x.id===id)?.name||'';}
 function playerFace(parent,id){const p=profiles.list().find(x=>x.id===id),face=element(parent,'span','player-face');face.innerHTML=faceArt(p.avatar,Avatars);return face;}
 function saveHeading(){saveDialog.replaceChildren();const heading=saveText(saveDialog,'h1','Game saves');if(saveProfile&&manyPlayers()){heading.textContent=playerName(saveProfile);heading.prepend?.(playerFace(heading,saveProfile));heading.classList.add('player-heading');}}
 function renderSavePlayers(){
  saveProfile=undefined;saveDialog.replaceChildren();button(saveDialog,'back','Back',closeSaveManagement,'close-players dialog-back');
  const rows=element(saveDialog,'div','save-rows');
  for(const p of profiles.list()){const b=saveButton(rows,p.name,()=>loadSaves(p.id),'choose-player');b.prepend?.(playerFace(b,p.id));}
  rows.querySelector('.choose-player').focus();
 }
 function renderSaveList(message=''){
  saveHeading();saveText(saveDialog,'p','Delete a game’s saved progress to start it fresh. The game stays installed.');
  const feedback=saveText(saveDialog,'p',message,'save-feedback');feedback.setAttribute('role','status');
  if(!saveIds.length)saveText(saveDialog,'p','No saved games.');
  const rows=element(saveDialog,'div','save-rows');
  for(const id of saveIds)saveButton(rows,saveTitle(id),()=>confirmSaveReset(id),'choose-save');
  saveButton(saveDialog,'Back',saveBack,'close-saves').focus();
 }
 function confirmSaveReset(id){
  if(saveBusy)return;saveHeading();saveText(saveDialog,'h2',saveTitle(id));
  saveText(saveDialog,'p','Delete all saved progress for this game? This cannot be undone. Other games and Cubby settings will not change.');
  const feedback=saveText(saveDialog,'p','','save-feedback');feedback.setAttribute('role','status');
  const actions=element(saveDialog,'div','save-actions');
  const cancel=saveButton(actions,'Cancel',()=>renderSaveList(),'cancel-reset');
  saveButton(actions,'Delete saves',async()=>{
   if(saveBusy)return;saveBusy=true;feedback.textContent='Deleting…';for(const b of saveDialog.querySelectorAll('button'))b.disabled=true;
   try{await platform.resetGameSaves(id,saveProfile);if(disposed)return;saveIds=saveIds.filter(saved=>saved!==id);saveBusy=false;renderSaveList('Saves deleted. This game will start fresh.');}
   catch{if(disposed)return;feedback.textContent='Saves could not be fully deleted. Try again.';for(const b of saveDialog.querySelectorAll('button'))b.disabled=false;cancel.focus();}
   finally{saveBusy=false;}
  },'confirm-reset');cancel.focus();
 }
 async function loadSaves(player){
  saveProfile=player;saveHeading();saveText(saveDialog,'p','Loading saved games…');saveButton(saveDialog,'Back',saveBack,'close-saves').focus();
  try{const ids=await platform.savedGames(saveProfile);if(disposed||!saveDialog.open||saveProfile!==player)return;saveIds=ids;renderSaveList();}
  catch{if(disposed||!saveDialog.open||saveProfile!==player)return;saveHeading();saveText(saveDialog,'p','Saved games could not be loaded. Close this page and try again.','save-feedback').setAttribute('role','status');saveButton(saveDialog,'Back',saveBack,'close-saves').focus();}
 }
 function openSaveManagement(){
  if(adult)return;adult=true;saveProfile=undefined;saveDialog.replaceChildren();saveDialog.showModal();
  if(manyPlayers())renderSavePlayers();else loadSaves(profiles?profile:undefined);
 }
 saveDialog.addEventListener('cancel',e=>{e.preventDefault();if(saveBusy)return;saveBack();});
 // Game feeds, like the Players screens, have no words but names: here each feed's name,
 // which an adult typed. A feed is a card: its name, its games' covers, a picture only
 // when it isn't loading right, a switch, and picture buttons. Only entered from the
 // unlocked gear, on every host.
 const feedDialog=element(host,'dialog','save-management feed-management');feedDialog.setAttribute('aria-label','Game feeds');
 let feedBusy=false,feedConfig=null,feedSub=false,feedLoad=0,feedDisabled=[],feedBoard=null,feedStatuses={},feedSave=null;
 function closeFeeds(){if(feedBusy)return;feedLoad++;feedDialog.close();adult=false;options.querySelector('.manage-feeds')?.focus();}
 function feedBack(){if(feedBusy)return;if(feedSub)renderFeeds();else closeFeeds();}
 // sub: an edit or remove step, which ✕ or Back leaves for the list.
 function feedScreen(sub){feedDialog.replaceChildren();feedSub=sub;feedBoard=null;feedSave=null;}
 function feedTop(){feedScreen(false);const top=element(feedDialog,'div','feed-top'),back=iconButton(top,'back','Back',closeFeeds,'close-feeds dialog-back');element(top,'span','feed-heading').innerHTML=icon('store');return back;}
 function feedControls(disabled){
  feedDialog.setAttribute('aria-busy',String(disabled));
  if(disabled){feedDisabled=Array.from(feedDialog.querySelectorAll('button,input'),node=>[node,!!node.disabled]);for(const [node] of feedDisabled)node.disabled=true;}
  else{for(const [node,wasDisabled] of feedDisabled)node.disabled=wasDisabled;feedDisabled=[];}
 }
 // Saving shows only on the button pressed: it pulses until the change is stored. How
 // each feed then loaded shows on its card.
 async function saveFeeds(next,trigger,onSaved,onError){
  if(feedBusy)return;feedBusy=true;feedControls(true);trigger?.classList.add('is-busy');
  try{feedConfig=await platform.setFeedConfig(next);if(disposed)return;
   // Drain any old refresh before fetching the newly configured blend.
   try{await catalogChecking;catalog=await platform.catalog();loading.store=false;failed.store=false;feedStatuses=await platform.feedStatus?.()||{};}
   catch{try{feedStatuses=await platform.feedStatus?.()||feedStatuses;}catch{}}
   if(disposed)return;feedBusy=false;feedDisabled=[];onSaved();
  }catch(error){if(disposed)return;feedBusy=false;feedControls(false);trigger?.classList.remove('is-busy');onError?.(error);}
  finally{feedBusy=false;feedDialog.setAttribute('aria-busy','false');}
 }
 function feedChange(feeds,trigger,focus){saveFeeds({schema:1,feeds},trigger,()=>renderFeeds(focus),()=>{if(trigger.getAttribute('role')==='switch')trigger.setAttribute('aria-checked',String(trigger.getAttribute('aria-checked')!=='true'));refuse(trigger);trigger.focus();});}
 // A feed's covers come from the Store's own offers, which remember the feed they came from.
 function feedCovers(feed){return feed.enabled?catalog.filter(offer=>offer?._source?.feed_url===feed.url&&offer.artwork):[];}
 function feedCard(list,feed,index){
  const status=feedStatuses[feed.url]||{},down=feed.enabled&&status.state==='unavailable',stale=feed.enabled&&status.state==='cached';
  const card=element(list,'section','feed-card'+(feed.enabled?'':' is-off')+(down?' is-down':'')+(stale?' is-stale':''));card.setAttribute('aria-label',feed.name);
  const head=element(card,'div','feed-head');saveText(head,'span',feed.name,'feed-title');
  // Not loading: a broken link on a red card. Showing its last saved games: a dim clock.
  if(down||stale){const mark=element(head,'span','feed-mark');mark.innerHTML=icon(down?'unlink':'clock');mark.setAttribute('role','img');mark.setAttribute('aria-label',down?'Not loading':'Saved copy');}
  const toggle=element(head,'button','feed-toggle');toggle.type='button';toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(feed.enabled));toggle.setAttribute('aria-label','Use '+feed.name);element(toggle,'span','feed-knob');
  // The knob slides at once; a switch that couldn't be saved slides back and shakes.
  toggle.addEventListener('click',()=>{if(feedBusy)return;toggle.setAttribute('aria-checked',String(!feed.enabled));feedChange(feedConfig.feeds.map((item,i)=>i===index?{...item,enabled:!item.enabled}:item),toggle,[index,'feed-toggle']);});
  const strip=element(card,'div','feed-covers'),covers=feedCovers(feed);
  for(const offer of covers.slice(0,8)){const image=element(strip,'img');image.src=offer.artwork;image.alt='';}
  if(feed.enabled&&!down&&!covers.length&&status.count===0)element(strip,'span','feed-none').innerHTML=icon('empty');
  const tools=element(card,'div','feed-tools');
  for(const [name,label,delta,cls] of [['raise','Move up',-1,'feed-up'],['lower','Move down',1,'feed-down']]){
   const b=iconButton(tools,name,label+': '+feed.name,()=>{const feeds=feedConfig.feeds.slice();[feeds[index],feeds[index+delta]]=[feeds[index+delta],feeds[index]];feedChange(feeds,b,[index+delta,cls]);},cls);
   b.disabled=index+delta<0||index+delta>=feedConfig.feeds.length;
  }
  iconButton(tools,'pencil','Edit '+feed.name,()=>editFeed(index),'feed-edit');
  iconButton(tools,'trash','Remove '+feed.name,()=>confirmRemoveFeed(index),'feed-remove');
 }
 // focus: where to land after a change, [feed index, button class] or 'add'.
 function renderFeeds(focus){
  const back=feedTop(),list=element(feedDialog,'div','feed-rows');
  feedConfig.feeds.forEach((feed,index)=>feedCard(list,feed,index));
  const add=iconButton(list,'plus','Add a game feed',()=>editFeed(),'add-feed');add.disabled=feedConfig.feeds.length>=(win.HandheldGameFeeds?.MAX_FEEDS||16);
  const cards=list.querySelectorAll('.feed-card'),[at,cls]=Array.isArray(focus)?focus:[],card=cards[Math.min(at??0,cards.length-1)];
  // A feed moved to an end lands on its other chevron.
  const pick=focus!=='add'&&card&&[cls,{'feed-up':'feed-down','feed-down':'feed-up'}[cls],'feed-edit'].map(c=>c&&card.querySelector('.'+c)).find(b=>b&&!b.disabled);
  (pick||(!add.disabled&&add)||back).focus();
 }
 function confirmRemoveFeed(index){
  const feed=feedConfig.feeds[index];feedScreen(true);
  const picture=element(feedDialog,'div','remove-picture feed-remove-picture'),art=element(picture,'span','feed-picture'),cover=feedCovers(feed)[0];
  if(cover){const image=element(art,'img');image.src=cover.artwork;image.alt='';}else art.innerHTML=icon('store');
  element(picture,'span','remove-symbol').innerHTML=icon('trash');saveText(feedDialog,'p',feed.name,'feed-title feed-remove-name');
  const actions=element(feedDialog,'div','icon-actions');
  const cancel=iconButton(actions,'cancel','Cancel',()=>renderFeeds([index,'feed-remove']),'cancel-feed');
  const confirm=iconButton(actions,'trash','Remove '+feed.name,()=>saveFeeds({schema:1,feeds:feedConfig.feeds.filter((_,i)=>i!==index)},confirm,()=>renderFeeds([index,'feed-remove']),()=>{refuse(confirm);cancel.focus();}),'remove-confirm feed-remove-confirm');
  cancel.focus();
 }
 // Adding or editing: a name and a web address, each marked by a picture, then ✕ ✓.
 // ✓ stays dim until both can be saved; trying anyway, or a save that fails, shakes the
 // field at fault red (✓ itself when storing failed). On the handheld the shared keyboard
 // types into whichever field was chosen last, as the player name entry does.
 function editFeed(index){
  if(feedBusy)return;feedScreen(true);const current=feedConfig.feeds[index];
  const fields=element(feedDialog,'div','feed-fields'),wraps=new Map();
  function field(art,label,value,cls,max){const wrap=element(fields,'label','feed-field');element(wrap,'span','feed-field-icon').innerHTML=icon(art);const input=element(wrap,'input',cls);input.type='text';input.value=value;input.maxLength=max;input.autocomplete='off';input.spellcheck=false;input.setAttribute('autocapitalize','off');input.setAttribute('aria-label',label);wraps.set(input,wrap);return input;}
  const name=field('tag','Name',current?.name||'','feed-name-input',120),url=field('link','Web address',current?.url||'','feed-url-input',2048);url.inputMode='url';
  const others=feedConfig.feeds.filter((_,i)=>i!==index).map(feed=>feed.url);
  const nameProblem=()=>!name.value.trim()||/[\x00-\x1f\x7f]/.test(name.value);
  function urlProblem(){const raw=url.value.trim();let href=null;try{href=win.HandheldGameFeeds?win.HandheldGameFeeds.feedURL(raw):/^https:\/\/[^/\s]/i.test(raw)?raw:null;}catch{}return !href||others.includes(href);}
  const keys=win.CubbyDeviceProfile==='rg353v'&&win.HandheldKeyboard?element(feedDialog,'div','feed-keyboard'):null;let typing=null;
  function typeInto(input){if(!keys||typing===input)return;typing=input;for(const [each,wrap] of wraps)wrap.classList.toggle('is-typing',each===input);feedBoard=win.HandheldKeyboard.create({container:keys,field:input,layout:'web',capitalizeFirst:input===name});}
  // A red field turns back as soon as it is fixed; an unfinished one isn't red until tried.
  let save=null;
  function check(){for(const [input,problem] of [[name,nameProblem()],[url,urlProblem()]])if(!problem)input.classList.remove('invalid');save?.classList.toggle('is-dim',nameProblem()||urlProblem());}
  function blame(input){input.classList.add('invalid');refuse(input);if(keys)typeInto(input);else input.focus();}
  function attempt(){
   if(feedBusy)return;const bad=nameProblem()?name:urlProblem()?url:null;if(bad){blame(bad);return;}
   const feeds=feedConfig.feeds.slice(),next={name:name.value.trim(),url:url.value.trim(),enabled:current?.enabled??true};if(current)feeds[index]=next;else feeds.push(next);
   saveFeeds({schema:1,feeds},save,()=>renderFeeds([current?index:feeds.length-1,'feed-edit']),error=>{const message=String(error?.message||'');if(message==='Invalid feed settings')blame(name);else if(/HTTPS URL|already added/.test(message))blame(url);else refuse(save);});
  }
  for(const input of [name,url]){
   input.addEventListener('input',check);input.addEventListener('focus',()=>typeInto(input));
   // Typed keys belong to the field, not to the hub's controls.
   for(const type of ['keydown','keyup'])input.addEventListener(type,event=>{event.stopPropagation();if(type!=='keydown')return;if(event.key==='Enter')attempt();if(event.key==='Escape'){event.preventDefault?.();feedBack();}});
  }
  const actions=element(feedDialog,'div','icon-actions');
  iconButton(actions,'cancel','Cancel',()=>renderFeeds(current?[index,'feed-edit']:'add'),'cancel-feed');
  save=iconButton(actions,'check','Save',attempt,'save-feed');feedSave=attempt;check();
  if(keys){typeInto(name);feedBoard.focus();}else{name.focus();name.select?.();}
 }
 async function loadFeeds(){
  const generation=++feedLoad,back=feedTop();element(feedDialog,'div','feed-wait loading').innerHTML=icon('loading');back.focus();
  try{const config=await platform.feedConfig(),statuses=await platform.feedStatus?.()||{};if(disposed||!feedDialog.open||generation!==feedLoad)return;feedConfig=config;feedStatuses=statuses;renderFeeds();feedDialog.scrollTop=0;}
  catch{if(disposed||!feedDialog.open||generation!==feedLoad)return;feedTop();element(feedDialog,'div','feed-wait').innerHTML=icon('error');iconButton(element(feedDialog,'div','icon-actions'),'retry','Try again',loadFeeds,'retry-feeds').focus();}
 }
 function openFeeds(){if(adult||!settingsUnlocked)return;adult=true;feedDialog.showModal();loadFeeds();}
 feedDialog.addEventListener('cancel',e=>{e.preventDefault();feedBack();});
 // The child's side of players: their face and name at the top of the hub, and a picker
 // of faces. A child's own name is the one word the child hub shows (AGENTS.md); nothing
 // needs reading. With one player neither exists, so the hub looks as it always did.
 const playerButton=element(host.querySelector('.brand'),'button','player-button');playerButton.type='button';playerButton.hidden=true;playerButton.addEventListener('click',()=>openPicker());
 const playerDisc=element(playerButton,'span','player-disc'),playerLabel=element(playerButton,'span','player-label');
 function renderPlayer(){
  // With players the chip takes the logo's place: a fresh Cubby's chip is the logo.
  const current=profiles&&profiles.list().find(p=>p.id===profile);playerButton.hidden=!current;host.querySelector('.brand').classList.toggle('has-player',!!current);if(!current)return;
  if(playerButton.dataset.avatar!==current.avatar){playerDisc.innerHTML=faceArt(current.avatar,Avatars);playerButton.dataset.avatar=current.avatar;}
  playerLabel.textContent=current.name;playerButton.setAttribute('aria-label',current.name+'. Change player');fitPlayerName();
 }
 // The name shows only whole: if the top bar has no room, the face is enough.
 function fitPlayerName(){playerLabel.hidden=false;win.requestAnimationFrame?.(()=>{playerLabel.hidden=playerLabel.scrollWidth>playerLabel.clientWidth+1;});}
 if(profiles)win.addEventListener('resize',fitPlayerName);
 const picker=element(host,'section','player-picker');picker.hidden=true;picker.setAttribute('aria-label','Who is playing?');
 let picking=false,choosing=false;
 function openPicker(){
  if(!profiles||adult||picking)return;picking=true;pausePreview();renderFaces();
 }
 // Faces, and + while an animal is free. The first pick after Cubby starts can't be
 // skipped; after that Back keeps the player.
 function renderFaces(){
  picker.replaceChildren();kidBoard=null;kidSave=null;
  if(profiles.pinned()||!manyPlayers())button(picker,'back','Keep player',closePicker,'picker-back');
  const faces=element(picker,'div','picker-faces'),list=profiles.list(),more=profiles.freeAvatars().length>0;faces.dataset.count=String(list.length+(more?1:0));
  for(const p of list){const face=element(faces,'button','picker-face');face.type='button';face.dataset.profile=p.id;face.setAttribute('aria-label',p.name);element(face,'span','face-disc').innerHTML=faceArt(p.avatar,Avatars);element(face,'span','face-name').textContent=p.name;face.addEventListener('click',()=>choose(p.id));}
  if(more){const plus=element(faces,'button','picker-face picker-plus');plus.type='button';plus.setAttribute('aria-label','New player');element(plus,'span','face-disc').innerHTML=icon('plus');element(plus,'span','face-name');plus.addEventListener('click',kidAnimal);}
  picker.hidden=false;
  (Array.from(faces.querySelectorAll('.picker-face')).find(face=>face.dataset.profile===profile)||faces.querySelector('.picker-face'))?.focus();
 }
 // A child's +: their animal, then their name, with ✕ always going back unchanged. On a
 // fresh Cubby this takes over Cubby itself (same saves); after that it adds a player.
 let kidBoard=null,kidSave=null;
 function kidAnimal(){
  picker.replaceChildren();kidBoard=null;kidSave=null;
  const grid=element(picker,'div','picker-faces kid-animals'),free=profiles.freeAvatars();grid.dataset.count=String(free.length);
  for(const avatar of free){const face=element(grid,'button','picker-face');face.type='button';face.setAttribute('aria-label',Avatars.name(avatar));element(face,'span','face-disc').innerHTML=Avatars.svg(avatar);face.addEventListener('click',()=>kidName(avatar));}
  iconButton(element(picker,'div','kid-actions'),'cancel','Cancel',renderFaces,'kid-cancel');
  grid.querySelector('.picker-face')?.focus();
 }
 function kidName(avatar){
  picker.replaceChildren();
  const box=element(picker,'div','kid-name'),target=profiles.claimTarget();
  const entry=nameEntry(box,{avatar,value:'',keys:true,problem:raw=>profiles.nameProblem(target,raw),cancel:renderFaces,save:async name=>{
   let made;try{made=profiles.claim(avatar,name);}catch{return false;}
   renderPlayer();await choose(made.id);return true;
  }});
  kidBoard=entry.board;kidSave=entry.save;
 }
 function hidePicker(){picking=false;picker.hidden=true;picker.replaceChildren();kidBoard=null;kidSave=null;}
 function closePicker(){if(!picking)return;hidePicker();focusView();resumePreview();}
 async function choose(id){
  if(choosing)return;choosing=true;
  try{await profiles.select(id);}catch{return;}finally{choosing=false;}
  if(disposed)return;usePlayer(id);closePicker();
 }
 function usePlayer(id){profile=id;state.load(profiles.storageFor(id));renderPlayer();refreshOwnership();const star=detail.querySelector('.favorite');if(star&&state.detail)star.setAttribute('aria-pressed',String(state.isFavorite(state.detail.id)));}
 // Spatial focus among a few buttons: the nearest one in the pressed direction.
 function nearest(nodes,active,a){
  if(!nodes.includes(active))return null;const from=active.getBoundingClientRect(),x=from.left+from.width/2,y=from.top+from.height/2,horizontal=a==='left'||a==='right',sign=a==='right'||a==='down'?1:-1;let best=active,score=Infinity;
  for(const node of nodes){if(node===active)continue;const r=node.getBoundingClientRect(),dx=r.left+r.width/2-x,dy=r.top+r.height/2-y,primary=(horizontal?dx:dy)*sign,cost=primary+Math.abs(horizontal?dy:dx)*2;if(primary>4&&cost<score){score=cost;best=node;}}
  return best;
 }
 // Adult players page, behind the gear tab's question like every worded page.
 const playerDialog=element(host,'dialog','save-management player-management');playerDialog.setAttribute('aria-label','Players');
 let playerBusy=false;
 function closePlayers(){if(playerBusy)return;playerDialog.close();adult=false;tabs.options.focus();}
 function playersBack(){if(playerBusy)return;if(playerDialog.querySelector('.cancel-player'))renderPlayers();else closePlayers();}
 // Players screens have no words but the players' names: faces, names and picture buttons.
 function iconButton(parent,name,label,fn,cls){return button(parent,name,label,fn,'icon-button '+(cls||''));}
 function refuse(target){target.classList.remove('refused');void target.offsetWidth;target.classList.add('refused');}
 function renderPlayers(){
  playerDialog.replaceChildren();iconButton(playerDialog,'back','Back',closePlayers,'close-players-page dialog-back');
  const rows=element(playerDialog,'div','player-rows'),list=profiles.list();
  for(const p of list){
   // The player playing now wears the picker's ring.
   const row=element(rows,'div','player-row'+(list.length>1&&p.id===profile?' is-playing':''));playerFace(row,p.id);
   saveText(row,'span',p.name,'player-name');
   iconButton(row,'pencil','Rename '+p.name,()=>renamePlayer(p),'rename-player');
   iconButton(row,'swap','Change picture',()=>choosePicture(p),'change-picture');
   // Removing the only player returns the device to a fresh Cubby; Cubby itself stays.
   if(!profiles.fresh())iconButton(row,'trash','Remove '+p.name,()=>confirmRemovePlayer(p),'remove-player');
  }
  // Children add players with + on the hub, so this page only manages them.
  (rows.querySelector('.rename-player')||playerDialog.querySelector('.dialog-back')).focus();
 }
 function choosePicture(p){
  playerDialog.replaceChildren();
  const grid=element(playerDialog,'div','avatar-choices'),used=new Set(profiles.list().map(x=>x.avatar));
  for(const avatar of Avatars.ids){
   if(used.has(avatar)&&avatar!==p.avatar)continue;
   const choice=element(grid,'button','avatar-choice');choice.type='button';choice.innerHTML=Avatars.svg(avatar);choice.setAttribute('aria-label',Avatars.name(avatar));
   if(avatar===p.avatar)choice.setAttribute('aria-current','true');
   choice.addEventListener('click',()=>{
    // A picture whose animal name another player has is refused with a shake.
    try{if(avatar!==p.avatar)profiles.setAvatar(p.id,avatar);}
    catch{refuse(choice);return;}
    renderPlayer();renderPlayers();
   });
  }
  iconButton(element(playerDialog,'div','icon-actions'),'cancel','Cancel',()=>renderPlayers(),'cancel-player');
  (grid.querySelector('.avatar-choice[aria-current]')||grid.querySelector('.avatar-choice'))?.focus();
 }
 function confirmRemovePlayer(p){
  playerDialog.replaceChildren();
  const picture=element(playerDialog,'div','remove-picture');playerFace(picture,p.id);element(picture,'span','remove-symbol').innerHTML=icon('trash');
  const actions=element(playerDialog,'div','icon-actions');
  const cancel=iconButton(actions,'cancel','Cancel',()=>renderPlayers(),'cancel-player');
  const confirm=iconButton(actions,'trash','Remove '+p.name,async()=>{
   if(playerBusy)return;playerBusy=true;for(const b of playerDialog.querySelectorAll('button'))b.disabled=true;
   try{await profiles.remove(p.id);try{profiles.storageFor(p.id).removeItem(favoriteKey);}catch{}}
   catch{playerBusy=false;if(disposed)return;for(const b of playerDialog.querySelectorAll('button'))b.disabled=false;refuse(confirm);cancel.focus();return;}
   playerBusy=false;if(disposed)return;
   if(profiles.list().some(x=>x.id===profile))renderPlayer();else usePlayer(profiles.current());
   renderPlayers();
  },'remove-confirm');cancel.focus();
 }
 // Naming: a text field everywhere; on the handheld, which has only a controller, Cubby's
 // shared on-screen keyboard (keyboard.js, the same one the Wi-Fi password uses) types it.
 // ✓ stays dim until the name is one this player can have; trying anyway shakes the field.
 // One name entry for adults and children: a face, the field, and ✕ ✓. Keys come from
 // Cubby's shared on-screen keyboard (keyboard.js, as the Wi-Fi password uses) wherever
 // there may be no keyboard: the handheld, and a child's +. ✓ stays dim until the name
 // is one the player can have; trying anyway shakes the field red. No words.
 function nameEntry(parent,{avatar,value,keys,problem,save,cancel}){
  const entry=element(parent,'div','name-entry');element(entry,'span','player-face').innerHTML=faceArt(avatar,Avatars);
  const field=element(entry,'input','player-name-field');
  field.type='text';field.value=value;field.maxLength=win.HandheldProfiles.NAME_LENGTH;field.setAttribute('aria-label','Name');field.autocomplete='off';field.spellcheck=false;
  let ok=false,saveKey=null,busy=false;
  // A red outline marks a name that can't be used; an empty field is just unfinished.
  function check(){ok=!problem(field.value);field.classList.toggle('invalid',!ok&&!!field.value.trim());if(saveKey)saveKey.disabled=!ok;}
  async function attempt(){if(busy)return;check();if(!ok){field.classList.add('invalid');refuse(field);return;}busy=true;const done=await save(field.value);busy=false;if(!done)refuse(field);}
  // Typed keys belong to the field, not to the hub's controls.
  for(const type of ['keydown','keyup'])field.addEventListener(type,event=>{event.stopPropagation();if(type==='keydown'&&event.key==='Enter')attempt();if(type==='keydown'&&event.key==='Escape')cancel();});
  field.addEventListener('input',check);
  const board=keys&&win.HandheldKeyboard?win.HandheldKeyboard.create({container:element(parent,'div','name-keyboard'),field,layout:'name',capitalizeFirst:true}):null;
  const actions=element(parent,'div','icon-actions');
  iconButton(actions,'cancel','Cancel',cancel,'cancel-player');
  saveKey=iconButton(actions,'check','Save name',attempt,'save-name');check();
  if(board)board.focus();else{field.focus();field.select?.();}
  return {board,save:attempt};
 }
 let nameBoard=null,nameSave=null;
 function renamePlayer(p){
  playerDialog.replaceChildren();
  const entry=nameEntry(playerDialog,{avatar:p.avatar,value:p.name,keys:win.CubbyDeviceProfile==='rg353v',problem:raw=>profiles.nameProblem(p.id,raw),cancel:()=>renderPlayers(),save:name=>{try{profiles.rename(p.id,name);}catch{return false;}renderPlayer();renderPlayers();return true;}});
  nameBoard=entry.board;nameSave=entry.save;
 }
 function openPlayers(){if(adult||!profiles)return;adult=true;playerDialog.replaceChildren();playerDialog.showModal();renderPlayers();}
 playerDialog.addEventListener('cancel',e=>{e.preventDefault();playersBack();});
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
 function openSetting(href){if(href==='#adult-saves'){openSaveManagement();return;}if(href==='#adult-players'){openPlayers();return;}try{win.sessionStorage.setItem(settingsReturn,'1');}catch{}win.location.href=href;}
 function returningToSettings(){try{const marked=win.sessionStorage.getItem(settingsReturn)==='1';win.sessionStorage.removeItem(settingsReturn);return marked&&win.location?.hash==='#options';}catch{return false;}}

 const views=['library','store','options'],tabs={};let pendingTabFocus=null;for(const name of views)tabs[name]=button(nav,name,name,()=>activateView(name),'view-tab');
 function show(view,initial=false){if(adult)return;if(view!=='options')settingsUnlocked=false;pendingTabFocus=null;if(!initial)initialViewPending=false;pausePreview();state.show(view);tabs[view].setAttribute('aria-current','page');nav.style.setProperty('--active',views.indexOf(view));Object.keys(tabs).filter(x=>x!==view).forEach(x=>tabs[x].removeAttribute('aria-current'));body.hidden=view==='options';options.hidden=view!=='options';detail.hidden=true;body.classList.remove('has-detail');if(view==='options')renderOptions();else renderGrid();}
 // Activating a tab enters its content; merely navigating across tabs does not.
 function selectedCard(){const cards=Array.from(shelf.querySelectorAll('.game-card')).filter(card=>!card.disabled);return cards.find(card=>card.dataset.gameId===state.detail?.id)||cards[0];}
 function focusView(){(state.view==='options'?options.querySelector('button:not(:disabled)'):selectedCard()||shelf.querySelector('.retry-starter'))?.focus();}
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
 if(status){hideDetail();const box=element(shelf,'div','shelf-status '+status);box.setAttribute('role','status');box.setAttribute('aria-label',status==='loading'?'Loading':status==='error'?'Unable to load games':'No games');box.innerHTML='<span class="status-art">'+icon(status)+'</span>'+(status==='loading'?'<span class="status-dots"><i></i><i></i><i></i></span>':'');if(state.view==='library'&&starterGame){
  if(starterPending){const progress=element(box,'progress','install-progress');progress.setAttribute('aria-label','Download progress');const job=installStates[starterGame];if(job?.total){progress.max=job.total;progress.value=job.received||0;}else progress.removeAttribute('value');}
  if(starterFailed)button(box,'retry','Retry download',()=>loadStarterLibrary(),'retry-starter');
 }
 feature(null);return;}
 for(const game of store?[...catalog].sort((a,b)=>ownedInStore(a.id)-ownedInStore(b.id)):entries()){
 const card=button(shelf,'play','Preview game',()=>preview(game),'game-card');card.dataset.gameId=game.id;card.replaceChildren();const image=element(card,'img');image.src=game.artwork;image.alt='';
 element(card,'span','card-badge');setOwned(card);
 card.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')preview(game);});card.addEventListener('focus',()=>preview(game));
 }
 if(state.view==='library'&&starterFailed)button(shelf,'retry','Retry download',()=>loadStarterLibrary(),'retry-starter');
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
 const unsubscribeInstall=platform.onInstallState?.(states=>{if(disposed)return;const installedChanged=Object.entries(states).some(([id,s])=>s.phase==='installed'&&(installStates[id]?.phase!=='installed'||installStates[id]?.version!==s.version));installStates=states;refreshOwnership();if(starterPending&&state.view==='library')renderGrid();if(installedChanged&&!starterPending)refreshLibrary();});
 platform.installStatus?.().then(states=>{if(!disposed){installStates=states;refreshOwnership();}}).catch(()=>{});
 const gameUpdates=startGameUpdates(win,platform);
 function hideDetail(){pausePreview();detail.replaceChildren();state.detail=null;detail.hidden=true;body.classList.remove('has-detail');markSelection();}
 // Back changes focus, not selection: a populated shelf always has usable actions.
 function returnToGames(toTab=false){const card=shelf.querySelector('[data-game-id="'+state.detail?.id+'"]');(toTab?tabs[state.view]:card||tabs[state.view]).focus();}
 function renderOptions(){options.replaceChildren();gateSubmit=null;
 if(!settingsUnlocked){renderGate();return;}
 // Every tile shares one wrapping grid, so a handheld's short screen fits them in two rows.
 // Everyday management first; setup and advanced feeds follow, exit/power last.
 // DOM order is also the initial focus and keyboard/controller traversal order.
 const tiles=element(options,'div','settings-tiles'),controller=()=>{if(calibration)button(tiles,'controller','Adult controller setup',openController,'controller-settings settings-tile');};
 const feeds=()=>{if(platform.feedConfig&&platform.setFeedConfig)button(tiles,'store','Game feeds',openFeeds,'manage-feeds settings-tile');};
 const quit=()=>{if(platform.capabilities.quit)button(options,'quit','Quit application',openQuit,'quit-app');};
 // Device hosts have physical controls and their own adult pages, so they list
 // those here; key remapping only applies to hosts with a real keyboard.
 if(platform.settings?.length){for(const entry of platform.settings){if(entry.href==='#adult-players'&&!profiles)continue;const tile=button(tiles,entry.icon,entry.label,()=>openSetting(entry.href),'settings-tile');if(entry.notice)tile.dataset.notice='';}controller();feeds();if(platform.capabilities.power){const restart=button(tiles,'retry','Restart',()=>openPower('reboot','retry','Restart','Restarting…',restart),'settings-tile restart-device'),off=button(tiles,'quit','Power off',()=>openPower('poweroff','quit','Power off','Powering off…',off),'settings-tile power-off');}quit();
  // Past six tiles, a short screen takes four smaller ones a row to stay in two rows.
  tiles.classList.toggle('many',tiles.children.length>6);showNotice();showVersion();return;}
 if(profiles)button(tiles,'players','Players',()=>openSetting('#adult-players'),'manage-players settings-tile');
 button(tiles,'trash','Manage game saves',()=>openSetting('#adult-saves'),'manage-saves settings-tile');controller();
 const setup=element(tiles,'div','adult-entry');const b=button(setup,'keyboard','Adult keyboard setup',openAdult);b.insertAdjacentHTML('beforeend',icon('adult'));
 feeds();quit();
 tiles.classList.toggle('many',tiles.children.length>6);
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
 const input=win.HandheldInput.createInput({repeat:true,navigationShoulders:true,onAction:event=>{const a=event.action;if(picking){const nodes=Array.from(picker.querySelectorAll('button')).filter(b=>!b.disabled);
  // In a child's +, Back is ✕; on the name keys a shoulder changes case and Start is ✓.
  const step=picker.querySelector('.kid-cancel,.name-entry');
  if(a==='back'||a==='exit'){if(step)renderFaces();else if(profiles.pinned()||!manyPlayers())closePicker();}
  else if(kidBoard&&(a==='nextView'||a==='previousView'))kidBoard.toggleCase();
  else if(kidSave&&a==='pause')kidSave();
  else if(a==='confirm'||a==='pause')(nodes.includes(doc.activeElement)?doc.activeElement:picker.querySelector('.picker-face'))?.click();
  else if(['left','right','up','down'].includes(a))(nearest(nodes,doc.activeElement,a)||nodes[0])?.focus();return;}if(playerDialog.open){if(playerBusy)return;const nodes=Array.from(playerDialog.querySelectorAll('button')).filter(b=>!b.disabled),index=nodes.indexOf(doc.activeElement);
  // Keys are a grid: the D-pad moves across it, a shoulder changes case and Start saves.
  if(nameBoard&&playerDialog.querySelector('.name-keyboard')){if(a==='back'||a==='exit')playersBack();else if(a==='nextView'||a==='previousView')nameBoard.toggleCase();else if(a==='pause')nameSave?.();else if(a==='confirm')doc.activeElement?.click();else if(['left','right','up','down'].includes(a))(nearest(nodes,doc.activeElement,a)||nodes[0])?.focus();return;}
  if(a==='back'||a==='exit')playersBack();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a))nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();return;}if(controllerDialog.open){if(event.source==='gamepad')return;if(a==='back'||a==='exit')closeController();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const nodes=Array.from(controllerDialog.querySelectorAll('button')).filter(b=>!b.disabled),index=nodes.indexOf(doc.activeElement);nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();}return;}if(uninstallDialog.open){if(uninstallBusy)return;const nodes=Array.from(uninstallDialog.querySelectorAll('button'));if(a==='back'||a==='exit')closeUninstall();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const index=nodes.indexOf(doc.activeElement);nodes[(index+1)%nodes.length]?.focus();}return;}if(quitDialog.open){if(quitting)return;const nodes=Array.from(quitDialog.querySelectorAll('button'));if(a==='back'||a==='exit')closeQuit();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const index=nodes.indexOf(doc.activeElement);nodes[(index+1)%nodes.length]?.focus();}return;}if(feedDialog.open){if(feedBusy)return;const nodes=Array.from(feedDialog.querySelectorAll('button,input')).filter(b=>!b.disabled),active=doc.activeElement;if(a==='back'||a==='exit')feedBack();else if(feedBoard&&(a==='nextView'||a==='previousView'))feedBoard.toggleCase();else if(feedSave&&a==='pause')feedSave();else if(a==='confirm'||a==='pause'){if(active?.tagName?.toLowerCase()==='input'){if(feedBoard)feedBoard.focus();else feedSave?.();}else active?.click();}else if(['left','right','up','down'].includes(a))(nearest(nodes,active,a)||nodes[0])?.focus();return;}if(saveDialog.open){if(saveBusy)return;const nodes=Array.from(saveDialog.querySelectorAll('button')).filter(b=>!b.disabled),index=nodes.indexOf(doc.activeElement);if(a==='back'||a==='exit')saveBack();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a))nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();return;}if(adult){const nodes=Array.from(dialog.querySelectorAll('button')),index=nodes.indexOf(doc.activeElement);if(a==='back'||a==='exit')closeAdult(false);else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a))nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();return;}
 if(a==='exit'||a==='back'){if(!detail.hidden)returnToGames(doc.activeElement?.classList.contains('game-card')||doc.activeElement===tabs[state.view]);else activateView('library');return;}
 if(a==='select'||a==='nextView'||a==='previousView'){activateView(views[(views.indexOf(state.view)+(a==='previousView'?2:1))%3]);return;}
 const padKeys=Array.from(doc.activeElement?.closest?.('.gate-pad')?.querySelectorAll('button')||[]);
 if(padKeys.length){if(a==='pause'){gateSubmit?.();return;}if(['left','right','up','down'].includes(a)){const i=padKeys.indexOf(doc.activeElement),row=i-i%3;if(a==='up'&&i<3)tabs.options.focus();else padKeys[a==='left'?row+(i+2)%3:a==='right'?row+(i+1)%3:a==='up'?i-3:(i+3)%12]?.focus();return;}}
 const nodes=Array.from(host.querySelectorAll('button')).filter(b=>!b.closest('[hidden]')&&!b.closest('dialog')&&!b.disabled);if(!nodes.length)return;
 const active=doc.activeElement,index=nodes.indexOf(active);
 if(a==='confirm'||a==='pause'){if(index<0){const first=shelf.querySelector('.game-card:not(:disabled)')||nodes[0];first.focus();}else if(active.classList.contains('game-card')){preview(entries().find(g=>g.id===active.dataset.gameId));detail.querySelector('.play-game:not(:disabled),.download-game:not(:disabled)')?.focus();}else active.click();return;}
 if(['left','right','up','down'].includes(a)){const origin=active?.getBoundingClientRect(),horizontal=a==='left'||a==='right',positive=a==='right'||a==='down';let next;if(origin&&index>=0){const x=origin.left+origin.width/2,y=origin.top+origin.height/2;const inShelf=active.classList.contains('game-card');const candidates=nodes.filter(n=>n!==active&&(!horizontal||!inShelf||n.classList.contains('game-card'))).map(n=>{const r=n.getBoundingClientRect(),dx=r.left+r.width/2-x,dy=r.top+r.height/2-y,primary=horizontal?dx:dy,secondary=horizontal?dy:dx;return {n,primary,score:Math.abs(primary)+Math.abs(secondary)*2};}).filter(c=>positive?c.primary>4:c.primary < -4).sort((a,b)=>a.score-b.score);next=candidates[0]?.n;}if(!detail.hidden){if(a==='up'&&active?.classList.contains('game-card')&&!next?.classList.contains('game-card'))next=primaryAction()||next;else if(a==='right'&&active?.classList.contains('detail-close'))next=primaryAction()||next;else if(active?.closest('.detail-actions')){if(a==='down'&&!next?.closest('.detail-actions'))next=shelf.querySelector('.game-card.is-selected')||next;else if(a==='left'&&!next?.closest('.detail-actions'))next=detail.querySelector('.detail-close')||next;}}if(!next&&(active?.classList.contains('game-card')||!horizontal&&active?.classList.contains('view-tab')))return;if(a==='up'&&next?.classList.contains('view-tab')&&!active?.classList.contains('view-tab'))next=tabs[state.view];if(!next){const delta=positive?1:-1;next=nodes[(index+delta+nodes.length)%nodes.length];}next.focus();}
 }});
 function dispose(){if(disposed)return;disposed=true;win.clearTimeout(calibrationTimer);win.clearTimeout(rejectTimer);if(controllerDialog.open)calibration?.cancel();stopCatalog();gameUpdates.stop();stopBattery();win.clearInterval?.(noticeTimer);win.clearTimeout?.(powerTimer);pausePreview();stopCapture();unsubscribeInstall?.();unsubscribeAccount?.();input.dispose();win.removeEventListener('pagehide',dispose);win.removeEventListener('resize',fitPlayerName);win.removeEventListener('hashchange',openSettingsFromHash);win.removeEventListener('blur',pausePreview);win.removeEventListener('focus',resumePreview);}
 function resumePreview(){if(doc.activeElement===doc.body){focusView();win.requestAnimationFrame?.(()=>{if(!disposed&&doc.activeElement===doc.body)focusView();});}if(!detail.hidden&&!uninstallDialog.open)detail.querySelector('video')?.play().catch(()=>{});}
 win.addEventListener('pagehide',dispose);
 win.addEventListener('blur',pausePreview);win.addEventListener('focus',resumePreview);
 async function loadStarterLibrary(){
  starterPending=true;starterFailed=false;loading.library=true;failed.library=false;if(state.view==='library')renderGrid();
  try{await gameUpdates.idle();const seeded=await prepareStarter(platform,{id:starterGame,storage});
   // First preparation selects its game, but never overrides a game return or
   // navigation/selection the user made while the verified install was pending.
   if((seeded==='installed'||seeded==='present')&&initialViewPending&&state.view==='library'&&!returningGame&&!state.detail) returningGame=starterGame;
  }
  catch{starterFailed=true;}
  try{const entries=await platform.library();if(disposed)return;library=entries;failed.library=starterFailed&&!entries.length;}
  catch{if(disposed)return;failed.library=true;}
  if(disposed)return;starterPending=false;loading.library=false;initialViewPending=false;
  if(state.view==='library')renderGrid();refreshOwnership();finishTabFocus('library');
 }
 if(starterGame)loadStarterLibrary();
 // Only initial discovery may choose Store; explicit navigation always wins.
 for(const [view,request] of [...(!starterGame?[['library',platform.library()]]:[]),['store',platform.catalog()]])request.then(entries=>{if(disposed)return;if(view==='library')library=entries;else catalog=entries;loading[view]=false;if(view==='library'&&initialViewPending&&!entries.length){const stayed=doc.activeElement===tabs.library;show('store');if(stayed){tabs.store.focus();focusView();if(loading.store)pendingTabFocus='store';}}else if(state.view===view)renderGrid();if(view==='library'){initialViewPending=false;settleStore();refreshOwnership();}finishTabFocus(view);}).catch(()=>{if(disposed)return;failed[view]=true;loading[view]=false;if(view==='library')initialViewPending=false;if(state.view===view)renderGrid();finishTabFocus(view);});
 // Adult pages return here so Back lands where the adult left, not on the library.
 function openSettingsFromHash(){if(win.location?.hash!=='#options'||quitDialog.open)return;if(picking)hidePicker();initialViewPending=false;show('options');options.querySelector('button')?.focus();win.history.replaceState(null,'',win.location.pathname);}
 settingsUnlocked=returningToSettings();activateView(win.location?.hash==='#options'?'options':'library',true);openSettingsFromHash();win.addEventListener('hashchange',openSettingsFromHash);
 // Who is playing is asked once each time Cubby starts; coming back from a game or an
 // adult page keeps the player.
 renderPlayer();if(manyPlayers()&&!profiles.pinned()&&win.location?.hash!=='#options')openPicker();
 win.fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'picker',errors:[]})}).catch(()=>{});
 return {state,show,dispose,refreshCatalog};
}
return {createState,mount,challenge,startBattery,startCatalogChecks,startGameUpdates,sweepGameUpdates,prepareStarter};
});

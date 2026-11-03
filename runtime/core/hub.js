/* Shared, wordless discovery UI. Adult keyboard setup is deliberately separate. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HandheldHub=api;})(globalThis,function(){
'use strict';
const favoriteKey='handheld:favorites:v1';
function createState(storage){
 let favorites=[];try{const value=JSON.parse(storage?.getItem(favoriteKey)||'[]');if(Array.isArray(value))favorites=value.filter(x=>typeof x==='string');}catch{}
 return {view:'library',detail:null,show(view){if(!['library','store','options'].includes(view))throw Error('Unknown view');this.view=view;this.detail=null;},select(game){this.detail=game;},isFavorite:id=>favorites.includes(id),favorite(id){favorites=favorites.includes(id)?favorites.filter(x=>x!==id):[...favorites,id];try{storage?.setItem(favoriteKey,JSON.stringify(favorites));}catch{}return favorites.includes(id);}};
}
const paths={trash:'M3 6h18M9 6V3h6v3M6 6l1 16h10l1-16M10 10v7M14 10v7',token:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 6.6l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5Z',library:'M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v7H3zM14 15h7v7h-7z',store:'M4 8h16l1 14H3ZM8 8V6a4 4 0 0 1 8 0v2',options:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 2h4l1 3 3 1 3 1v4l-2 1v3l1 3-3 3-3-1-2 2-3-1-1-3-3-1-2-3 2-3V7l3-1Z',play:'m8 4 13 8-13 8Z',back:'m14 4-8 8 8 8M6 12h16',star:'m12 2 3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1Z',check:'m4 12 5 5L21 5',touch:'M9 13V5a2 2 0 0 1 4 0v6l2-2 5 3v6l-4 4h-6l-6-7a2 2 0 0 1 3-2l2 2',auto:'M4 12a8 8 0 0 1 14-5l3 3M21 4v6h-6M20 14a8 8 0 0 1-14 5l-3-3M3 22v-6h6',off:'M3 3 21 21M8 8v7l4 6h6M13 8V4M18 12l3 2v4',keyboard:'M2 5h20v14H2ZM5 9h2m2 0h2m2 0h2m2 0h2M5 13h2m2 0h2m2 0h2m2 0h2M7 16h10',adult:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM5 23v-5a7 7 0 0 1 14 0v5',empty:'M3 9h18v12H3ZM3 9l3-5h12l3 5M9 13h6',error:'M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9ZM9.5 12.5h.01M14.5 12.5h.01M9.5 16.2q2.5-2 5 0',quit:'M12 2v10M6 5a9 9 0 1 0 12 0',cancel:'m5 5 14 14M19 5 5 19',loading:'M12 3a9 9 0 1 1-9 9',down:'M12 2v13m-5-5 5 5 5-5M3 18v4h18v-4',pick:'m6 9 6 6 6-6',alert:'m12 2 11 20H1ZM12 8v6m0 3v1'};
function icon(name){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
// Picture-only brand mark: a smiling cubby house.
const brand='<svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true"><path class="brand-roof" d="M24 3.5 44 18.5V39a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V18.5Z"/><rect class="brand-door" x="11" y="20" width="26" height="18" rx="6"/><g class="brand-face"><circle cx="19" cy="27.5" r="2.4"/><circle cx="29" cy="27.5" r="2.4"/><path d="M19.5 32.5q4.5 3.4 9 0"/></g></svg>';
function mount(host){
 const doc=host.ownerDocument,win=doc.defaultView;let storage;try{storage=win.localStorage;}catch{}
 const state=createState(storage),prefs=win.HandheldPreferences.preferences,platform=win.HandheldPlatform.createPlatform(win.HandheldPlatformOptions);
 let account=null,launchBusy=false,featured=null;
 let installStates={},library=[],catalog=[],loading={library:true,store:true},failed={library:false,store:false},adult=false,draft=null,cancelCapture=null,disposed=false;
 host.innerHTML='<header class="topbar"><div class="brand" aria-hidden="true">'+brand+'</div><nav class="view-nav" aria-label="Views"><span class="nav-pill" aria-hidden="true"></span></nav><div class="hud"></div></header>'+
  '<section class="view-body"><div class="hero"><div class="hero-backdrop" aria-hidden="true"></div><aside class="detail" hidden></aside><div class="hero-rest" aria-hidden="true"><div class="stage"><img class="rest-media" alt=""></div><div class="rest-hint">'+icon('pick')+'</div></div></div><div class="shelf-rail"><div class="shelf"></div></div></section>'+
  '<section class="options-panel" hidden></section><dialog class="adult-setup" aria-label="Adult keyboard setup"></dialog>';
 const nav=host.querySelector('.view-nav'),body=host.querySelector('.view-body'),backdrop=host.querySelector('.hero-backdrop'),restArt=host.querySelector('.hero-rest img'),shelf=host.querySelector('.shelf'),detail=host.querySelector('.detail'),options=host.querySelector('.options-panel'),dialog=host.querySelector('dialog.adult-setup');
 function button(parent,name,label,fn,cls){const b=doc.createElement('button');b.type='button';b.className=cls||'';b.setAttribute('aria-label',label);b.innerHTML=icon(name);b.addEventListener('click',fn);parent.appendChild(b);return b;}
 function element(parent,tag,cls){const e=doc.createElement(tag);if(cls)e.className=cls;parent.appendChild(e);return e;}
 const budget=element(host.querySelector('.hud'),'div','token-budget');budget.hidden=!platform.capabilities?.tokens;budget.setAttribute('role','status');
 function renderAccount(){if(!platform.capabilities?.tokens)return;budget.replaceChildren();budget.classList.toggle('empty-budget',account?.balance===0);budget.classList.toggle('no-budget',!account?.available);budget.setAttribute('aria-label',account?.available?account.balance+' tokens':'Tokens unavailable');
  if(account?.available&&account.balance>0){budget.style.setProperty('--coins',account.balance);for(let i=0;i<account.balance;i++){const coin=element(budget,'span','coin');coin.innerHTML=icon('token');}}else{budget.style.removeProperty('--coins');budget.innerHTML=icon(account?.available?'token':'alert');}refreshOwnership();}
 async function readAccount(){try{account=await platform.account();}catch{account={available:false};}if(!disposed)renderAccount();}
 async function launch(id){if(launchBusy)return;const latest=library.find(game=>game.id===id);if(!latest)return;if(!platform.capabilities?.tokens){win.location.href=latest.entrypoint;return;}launchBusy=true;refreshOwnership();try{await platform.launch(id);}catch{await readAccount();}finally{launchBusy=false;if(!disposed)refreshOwnership();}}
 const unsubscribeAccount=platform.onAccountState?.(value=>{account=value;if(!disposed)renderAccount();});
 if(platform.capabilities?.tokens)readAccount();
 const quitDialog=element(host,'dialog','quit-confirm');quitDialog.setAttribute('aria-label','Quit application?');
 let quitting=false;
 function closeQuit(){quitDialog.close();options.querySelector('.quit-app')?.focus();}
 function openQuit(){if(!platform.capabilities.quit||quitting)return;quitDialog.replaceChildren();const picture=element(quitDialog,'div','quit-picture');picture.innerHTML=icon('quit');const actions=element(quitDialog,'div','quit-actions');const cancel=button(actions,'back','Cancel quit',closeQuit,'cancel-quit');button(actions,'quit','Confirm quit',async()=>{if(quitting)return;quitting=true;try{await platform.quit();}catch{quitting=false;closeQuit();}},'confirm-quit');quitDialog.showModal();cancel.focus();}
 quitDialog.addEventListener('cancel',e=>{e.preventDefault();closeQuit();});
 const uninstallDialog=element(host,'dialog','uninstall-confirm');uninstallDialog.setAttribute('aria-label','Uninstall game? Saves are kept');
 let uninstallTarget=null,uninstallBusy=false,uninstallPreview=null;
 function closeUninstall(){if(uninstallBusy)return;uninstallDialog.close();uninstallTarget=null;refreshOwnership();detail.querySelector('.uninstall-game')?.focus();if(uninstallPreview?.isConnected&&!detail.hidden)uninstallPreview.play().catch(()=>{});uninstallPreview=null;}
 function openUninstall(game){
  if(!platform.capabilities.uninstall||uninstallBusy||launchBusy||!library.some(x=>x.id===game.id))return;
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
   await platform.uninstall(id);hideDetail();library=library.filter(game=>game.id!==id);if(state.view==='library')renderGrid();await refreshLibrary();
   try{catalog=await platform.catalog();failed.store=false;}catch{catalog=[];failed.store=true;}
   if(disposed)return;if(state.view==='store')renderGrid();uninstallBusy=false;closeUninstall();
   (shelf.querySelector('.game-card')||tabs[state.view]).focus();
  }catch{
   if(disposed)return;const failure=element(uninstallDialog,'span','uninstall-error');failure.setAttribute('role','status');failure.setAttribute('aria-label','Unable to uninstall; try again');failure.innerHTML=icon('alert');
   uninstallBusy=false;for(const b of uninstallDialog.querySelectorAll('button'))b.disabled=false;uninstallDialog.querySelector('.cancel-uninstall').focus();
  }finally{uninstallBusy=false;uninstallDialog.classList.remove('busy');for(const b of uninstallDialog.querySelectorAll('button'))b.disabled=false;if(!disposed)refreshOwnership();}
 }
 uninstallDialog.addEventListener('cancel',e=>{e.preventDefault();closeUninstall();});

 const views=['library','store','options'],tabs={};for(const name of views)tabs[name]=button(nav,name,name,()=>show(name),'view-tab');
 function show(view){if(adult)return;pausePreview();state.show(view);tabs[view].setAttribute('aria-current','page');nav.style.setProperty('--active',views.indexOf(view));Object.keys(tabs).filter(x=>x!==view).forEach(x=>tabs[x].removeAttribute('aria-current'));body.hidden=view==='options';options.hidden=view!=='options';detail.hidden=true;body.classList.remove('has-detail');if(view==='options')renderOptions();else renderGrid();}
 function primaryAction(){return detail.querySelector('.play-game:not(:disabled),.download-game:not(:disabled)')||detail.querySelector('.favorite');}
 function pausePreview(){detail.querySelector('video')?.pause();}
 function entries(){return state.view==='store'?catalog:library;}
 function badgeFor(id){return state.isFavorite(id)?icon('star'):state.view==='store'&&library.some(x=>x.id===id)?icon('check'):'';}
 function setBadge(badge,id){badge.innerHTML=badgeFor(id);badge.dataset.kind=state.isFavorite(id)?'favorite':badge.innerHTML?'installed':'';}
 // The hero always shows a game: the open preview, or a resting cover that invites a pick below.
 function feature(game){featured=game||null;const art=game?.artwork||'';if(restArt.getAttribute('src')!==art){if(art)restArt.src=art;else restArt.removeAttribute('src');}backdrop.style.backgroundImage=art?'url("'+art.replace(/["\\]/g,'\\$&')+'")':'';markSelection();}
 function markSelection(){const id=detail.hidden?null:state.detail?.id;shelf.classList.toggle('has-selection',!!id);for(const card of shelf.querySelectorAll('.game-card'))card.classList.toggle('is-selected',card.dataset.gameId===id);}
 function renderGrid(){shelf.replaceChildren();const status=loading[state.view]?'loading':failed[state.view]?'error':!entries().length?'empty':'';body.classList.toggle('is-status',!!status);
 if(status){const box=element(shelf,'div','shelf-status '+status);box.setAttribute('role','status');box.setAttribute('aria-label',status==='loading'?'Loading':status==='error'?'Unable to load games':'No games');box.innerHTML='<span class="status-art">'+icon(status)+'</span>'+(status==='loading'?'<span class="status-dots"><i></i><i></i><i></i></span>':'');feature(null);return;}
 for(const game of entries()){
 const card=button(shelf,'play','Preview game',()=>preview(game),'game-card');card.dataset.gameId=game.id;card.replaceChildren();const image=element(card,'img');image.src=game.artwork;image.alt='';
 setBadge(element(card,'span','card-badge'),game.id);
 card.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')preview(game);});card.addEventListener('focus',()=>preview(game));
 }
 const keep=entries().find(g=>g.id===(state.detail?.id||featured?.id));feature(keep||entries()[0]);}
 function preview(game){if(state.detail?.id===game.id&&!detail.hidden)return;pausePreview();state.select(game);detail.replaceChildren();detail.hidden=false;body.classList.add('has-detail');
 const stage=element(detail,'div','stage');
 button(stage,'back','Close preview',()=>closePreview(true),'detail-close');
 const media=doc.createElement(game.attract?'video':'img');media.className='preview-media';if(game.attract)media.poster=game.artwork;media.src=game.attract||game.artwork;if(game.attract){media.autoplay=true;media.muted=true;media.addEventListener('ended',()=>{media.load();media.play().catch(()=>{});});media.playsInline=true;media.setAttribute('playsinline','');media.addEventListener('error',()=>{const image=doc.createElement('img');image.className='preview-media';image.src=game.artwork;image.alt='';media.replaceWith(image);});}else media.alt='';stage.appendChild(media);if(game.attract)media.play().catch(()=>{});
 const actions=element(detail,'div','detail-actions');
 const star=button(actions,'star','Favorite',()=>{state.favorite(game.id);star.setAttribute('aria-pressed',String(state.isFavorite(game.id)));const badge=shelf.querySelector('[data-game-id="'+game.id+'"] .card-badge');if(badge)setBadge(badge,game.id);},'favorite');star.setAttribute('aria-pressed',String(state.isFavorite(game.id)));
 feature(game);
 refreshOwnership();
 }
 // Update ownership in place: asynchronous Library discovery must not restart the
 // Store trailer or steal focus from its favorite/back controls.
 function refreshOwnership(){
 for(const card of shelf.querySelectorAll('.game-card')){const badge=card.querySelector('.card-badge');if(badge)setBadge(badge,card.dataset.gameId);}
 if(detail.hidden||!state.detail)return;
 const actions=detail.querySelector('.detail-actions'),installed=library.find(x=>x.id===state.detail.id);if(!actions)return;
 if(installed){if(platform.capabilities.uninstall&&!actions.querySelector('.uninstall-game'))button(actions,'trash','Uninstall game',()=>openUninstall(installed),'uninstall-game');const remove=actions.querySelector('.uninstall-game'),phase=installStates[installed.id]?.phase;if(remove)remove.disabled=launchBusy||uninstallBusy||['checking','downloading','verifying','pending','uninstalling'].includes(phase);const previous=actions.querySelector('.download-game'),focused=previous===doc.activeElement;actions.querySelector('.not-installed')?.remove();previous?.remove();actions.querySelector('.install-progress')?.remove();if(!actions.querySelector('.play-game'))button(actions,'play','Play game',()=>launch(installed.id),'play-game');if(focused)actions.querySelector('.play-game')?.focus();const play=actions.querySelector('.play-game');if(platform.capabilities?.tokens){play.disabled=launchBusy||!account?.available||account.balance<1;play.setAttribute('aria-label',account?.balance===0?'No tokens; adult refill needed':account?.launchFailed?'Retry game launch for one token':'Play game for one token');play.innerHTML=icon(account?.launchFailed?'auto':'play')+icon('token');let failure=actions.querySelector('.launch-error');if(account?.launchFailed&&!failure){failure=element(actions,'span','launch-error');failure.setAttribute('aria-label','Launch failed; no token spent');failure.innerHTML=icon('alert');}else if(!account?.launchFailed)failure?.remove();}}
 else if(platform.capabilities?.install&&state.detail.manifest_url){
  actions.querySelector('.play-game')?.remove();actions.querySelector('.uninstall-game')?.remove();actions.querySelector('.launch-error')?.remove();
  actions.querySelector('.not-installed')?.remove();
  let download=actions.querySelector('.download-game');
  if(!download)download=button(actions,'down','Download game',()=>installGame(state.detail.id),'download-game');
  const status=installStates[state.detail.id],busy=status&&['checking','downloading','verifying','pending'].includes(status.phase);
  download.disabled=!!busy;download.innerHTML=icon(status?.phase==='error'?'auto':busy?'loading':'down');download.classList.toggle('loading',!!busy);download.setAttribute('aria-label',status?.phase==='error'?'Retry download':busy?'Downloading game':'Download game');
  let progress=actions.querySelector('.install-progress');if(!progress){progress=element(actions,'progress','install-progress');progress.setAttribute('aria-label','Download progress');}
  progress.hidden=!busy;if(status?.total){progress.max=status.total;progress.value=status.received||0;}else progress.removeAttribute('value');
 }
 else if(!actions.querySelector('.not-installed')){actions.querySelector('.play-game')?.remove();actions.querySelector('.uninstall-game')?.remove();const status=element(actions,'span','not-installed');status.setAttribute('aria-label','Not installed; adult installation required');status.innerHTML=icon('down');}
 }
 async function refreshLibrary(){try{const entries=await platform.library();if(disposed)return;const changed=JSON.stringify(entries)!==JSON.stringify(library);library=entries;if(changed&&state.view==='library'){const focusedId=doc.activeElement?.classList.contains('game-card')?doc.activeElement.dataset.gameId:null;renderGrid();if(focusedId)shelf.querySelector('[data-game-id="'+focusedId+'"]')?.focus();}refreshOwnership();}catch{/* Keep the installed library usable on a failed refresh. */}}
 async function installGame(id){if(disposed)return;installStates[id]={phase:'checking'};refreshOwnership();try{await platform.install(id);await refreshLibrary();}catch{installStates[id]={phase:'error'};refreshOwnership();}}
 const unsubscribeInstall=platform.onInstallState?.(states=>{if(disposed)return;const installedChanged=Object.entries(states).some(([id,s])=>s.phase==='installed'&&(installStates[id]?.phase!=='installed'||installStates[id]?.version!==s.version));installStates=states;refreshOwnership();if(installedChanged)refreshLibrary();});
 platform.installStatus?.().then(states=>{if(!disposed){installStates=states;refreshOwnership();}}).catch(()=>{});
 function hideDetail(){pausePreview();detail.replaceChildren();state.detail=null;detail.hidden=true;body.classList.remove('has-detail');markSelection();}
 function closePreview(focusCard){const id=state.detail?.id;hideDetail();if(focusCard){const card=shelf.querySelector('[data-game-id="'+id+'"]');if(card){suppressPreview=true;card.focus();suppressPreview=false;}}}
 let suppressPreview=false;
 // Closing via back must leave focus on the card without reopening its preview.
 shelf.addEventListener('focusin',()=>{if(suppressPreview)hideDetail();});
 function renderOptions(){options.replaceChildren();const touch=element(options,'div','touch-settings');touch.setAttribute('role','group');touch.setAttribute('aria-label','Touch controls');touch.innerHTML='<div class="setting-symbol">'+icon('touch')+'</div>';const modes=element(touch,'div','setting-choices');
 for(const [mode,glyph,label] of [['auto','auto','Automatic touch controls'],['on','touch','Show touch controls'],['off','off','Hide touch controls']]){const b=button(modes,glyph,label,()=>{prefs.set({touchOverlay:mode});updateTouch();});b.dataset.mode=mode;b.setAttribute('aria-pressed',String(prefs.get().touchOverlay===mode));}
 if(platform.capabilities.quit)button(options,'quit','Quit application',openQuit,'quit-app');
 const setup=element(options,'div','adult-entry');const b=button(setup,'keyboard','Adult keyboard setup',openAdult);b.insertAdjacentHTML('beforeend',icon('adult'));
 }
 function updateTouch(){options.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(prefs.get().touchOverlay===b.dataset.mode)));}
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
 const input=win.HandheldInput.createInput({navigationShoulders:true,onAction:event=>{const a=event.action;if(uninstallDialog.open){if(uninstallBusy)return;const nodes=Array.from(uninstallDialog.querySelectorAll('button'));if(a==='back'||a==='exit')closeUninstall();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const index=nodes.indexOf(doc.activeElement);nodes[(index+1)%nodes.length]?.focus();}return;}if(quitDialog.open){const nodes=Array.from(quitDialog.querySelectorAll('button'));if(a==='back'||a==='exit')closeQuit();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const index=nodes.indexOf(doc.activeElement);nodes[(index+1)%nodes.length]?.focus();}return;}if(adult){const nodes=Array.from(dialog.querySelectorAll('button')),index=nodes.indexOf(doc.activeElement);if(a==='back'||a==='exit')closeAdult(false);else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a))nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();return;}
 if(a==='exit'||a==='back'){if(!detail.hidden)closePreview(true);else show('library');return;}
 if(a==='select'||a==='nextView'||a==='previousView'){show(views[(views.indexOf(state.view)+(a==='previousView'?2:1))%3]);tabs[state.view].focus();return;}
 const nodes=Array.from(host.querySelectorAll('button')).filter(b=>!b.closest('[hidden]')&&!b.closest('dialog')&&!b.disabled);if(!nodes.length)return;
 const active=doc.activeElement,index=nodes.indexOf(active);
 if(a==='confirm'||a==='pause'){if(index<0){const first=shelf.querySelector('.game-card')||nodes[0];first.focus();}else if(active.classList.contains('game-card')){preview(entries().find(g=>g.id===active.dataset.gameId));detail.querySelector('.play-game:not(:disabled),.download-game:not(:disabled)')?.focus();}else active.click();return;}
 if(['left','right','up','down'].includes(a)){const origin=active?.getBoundingClientRect(),horizontal=a==='left'||a==='right',positive=a==='right'||a==='down';let next;if(origin&&index>=0){const x=origin.left+origin.width/2,y=origin.top+origin.height/2;const inShelf=active.classList.contains('game-card');const candidates=nodes.filter(n=>n!==active&&(!horizontal||!inShelf||n.classList.contains('game-card'))).map(n=>{const r=n.getBoundingClientRect(),dx=r.left+r.width/2-x,dy=r.top+r.height/2-y,primary=horizontal?dx:dy,secondary=horizontal?dy:dx;return {n,primary,score:Math.abs(primary)+Math.abs(secondary)*2};}).filter(c=>positive?c.primary>4:c.primary < -4).sort((a,b)=>a.score-b.score);next=candidates[0]?.n;}if(!detail.hidden){if(a==='up'&&active?.classList.contains('game-card')&&!next?.classList.contains('game-card'))next=primaryAction()||next;else if(a==='right'&&active?.classList.contains('detail-close'))next=primaryAction()||next;else if(active?.closest('.detail-actions')){if(a==='down'&&!next?.closest('.detail-actions'))next=shelf.querySelector('.game-card.is-selected')||next;else if(a==='left'&&!next?.closest('.detail-actions'))next=detail.querySelector('.detail-close')||next;}}if(!next&&active?.classList.contains('game-card'))return;if(a==='up'&&next?.classList.contains('view-tab')&&!active?.classList.contains('view-tab'))next=tabs[state.view];if(!next){const delta=positive?1:-1;next=nodes[(index+delta+nodes.length)%nodes.length];}next.focus();}
 }});
 const unsubscribe=prefs.subscribe(updateTouch);
 function dispose(){if(disposed)return;disposed=true;pausePreview();stopCapture();unsubscribe();unsubscribeInstall?.();unsubscribeAccount?.();input.dispose();}
 win.addEventListener('pagehide',dispose);
 win.addEventListener('blur',pausePreview);win.addEventListener('focus',()=>{if(!detail.hidden&&!uninstallDialog.open)detail.querySelector('video')?.play().catch(()=>{});});
 for(const [view,request] of [['library',platform.library()],['store',platform.catalog()]])request.then(entries=>{if(disposed)return;if(view==='library')library=entries;else catalog=entries;loading[view]=false;if(state.view===view)renderGrid();if(view==='library')refreshOwnership();}).catch(()=>{if(disposed)return;failed[view]=true;loading[view]=false;if(state.view===view)renderGrid();});show('library');
 win.fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'picker',errors:[]})}).catch(()=>{});
 return {state,show,dispose};
}
return {createState,mount};
});

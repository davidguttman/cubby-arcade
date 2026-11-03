/* Shared, wordless discovery UI. Adult keyboard setup is deliberately separate. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HandheldHub=api;})(globalThis,function(){
'use strict';
const favoriteKey='handheld:favorites:v1';
function createState(storage){
 let favorites=[];try{const value=JSON.parse(storage?.getItem(favoriteKey)||'[]');if(Array.isArray(value))favorites=value.filter(x=>typeof x==='string');}catch{}
 return {view:'library',detail:null,show(view){if(!['library','store','options'].includes(view))throw Error('Unknown view');this.view=view;this.detail=null;},select(game){this.detail=game;},isFavorite:id=>favorites.includes(id),favorite(id){favorites=favorites.includes(id)?favorites.filter(x=>x!==id):[...favorites,id];try{storage?.setItem(favoriteKey,JSON.stringify(favorites));}catch{}return favorites.includes(id);}};
}
const paths={library:'M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v7H3zM14 15h7v7h-7z',store:'M4 8h16l1 14H3ZM8 8V6a4 4 0 0 1 8 0v2',options:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 2h4l1 3 3 1 3 1v4l-2 1v3l1 3-3 3-3-1-2 2-3-1-1-3-3-1-2-3 2-3V7l3-1Z',play:'m8 4 13 8-13 8Z',back:'m14 4-8 8 8 8M6 12h16',star:'m12 2 3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1Z',check:'m4 12 5 5L21 5',touch:'M9 13V5a2 2 0 0 1 4 0v6l2-2 5 3v6l-4 4h-6l-6-7a2 2 0 0 1 3-2l2 2',auto:'M4 12a8 8 0 0 1 14-5l3 3M21 4v6h-6M20 14a8 8 0 0 1-14 5l-3-3M3 22v-6h6',off:'M3 3 21 21M8 8v7l4 6h6M13 8V4M18 12l3 2v4',keyboard:'M2 5h20v14H2ZM5 9h2m2 0h2m2 0h2m2 0h2M5 13h2m2 0h2m2 0h2m2 0h2M7 16h10',adult:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM5 23v-5a7 7 0 0 1 14 0v5',empty:'M3 7h18v14H3ZM3 7l4-4h10l4 4M7 13h10',error:'m12 2 11 20H1ZM12 8v6m0 3v1',quit:'M12 2v10M6 5a9 9 0 1 0 12 0',cancel:'m5 5 14 14M19 5 5 19',loading:'M12 3a9 9 0 1 1-9 9',down:'M12 2v13m-5-5 5 5 5-5M3 18v4h18v-4'};
function icon(name){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
function mount(host){
 const doc=host.ownerDocument,win=doc.defaultView;let storage;try{storage=win.localStorage;}catch{}
 const state=createState(storage),prefs=win.HandheldPreferences.preferences,platform=win.HandheldPlatform.createPlatform(win.HandheldPlatformOptions);
 let library=[],catalog=[],loading={library:true,store:true},failed={library:false,store:false},adult=false,draft=null,cancelCapture=null,disposed=false;
 host.innerHTML='<nav class="view-nav" aria-label="Views"></nav><section class="view-body"><div class="shelf"></div><aside class="detail" hidden></aside></section><section class="options-panel" hidden></section><dialog class="adult-setup" aria-label="Adult keyboard setup"></dialog>';
 const nav=host.querySelector('.view-nav'),body=host.querySelector('.view-body'),shelf=host.querySelector('.shelf'),detail=host.querySelector('.detail'),options=host.querySelector('.options-panel'),dialog=host.querySelector('dialog');
 function button(parent,name,label,fn,cls){const b=doc.createElement('button');b.type='button';b.className=cls||'';b.setAttribute('aria-label',label);b.innerHTML=icon(name);b.addEventListener('click',fn);parent.appendChild(b);return b;}
 const quitDialog=doc.createElement('dialog');quitDialog.className='quit-confirm';quitDialog.setAttribute('aria-label','Quit application?');host.appendChild(quitDialog);
 let quitting=false;
 function closeQuit(){quitDialog.close();options.querySelector('.quit-app')?.focus();}
 function openQuit(){if(!platform.capabilities.quit||quitting)return;quitDialog.replaceChildren();const picture=doc.createElement('div');picture.className='quit-picture';picture.innerHTML=icon('quit');quitDialog.appendChild(picture);const actions=doc.createElement('div');actions.className='quit-actions';quitDialog.appendChild(actions);const cancel=button(actions,'back','Cancel quit',closeQuit);button(actions,'quit','Confirm quit',async()=>{if(quitting)return;quitting=true;try{await platform.quit();}catch{quitting=false;closeQuit();}},'confirm-quit');quitDialog.showModal();cancel.focus();}
 quitDialog.addEventListener('cancel',e=>{e.preventDefault();closeQuit();});
 const tabs={};for(const name of ['library','store','options'])tabs[name]=button(nav,name,name,()=>show(name),'view-tab');
 function show(view){if(adult)return;pausePreview();state.show(view);tabs[view].setAttribute('aria-current','page');Object.keys(tabs).filter(x=>x!==view).forEach(x=>tabs[x].removeAttribute('aria-current'));body.hidden=view==='options';options.hidden=view!=='options';detail.hidden=true;body.classList.remove('has-detail');if(view==='options')renderOptions();else renderGrid();}
 function pausePreview(){detail.querySelector('video')?.pause();}
 function entries(){return state.view==='store'?catalog:library;}
 function renderGrid(){shelf.replaceChildren();if(loading[state.view]||failed[state.view]||!entries().length){const status=doc.createElement('div');status.className='shelf-status'+(loading[state.view]?' loading':'');status.setAttribute('role','status');status.setAttribute('aria-label',loading[state.view]?'Loading':failed[state.view]?'Unable to load games':'No games');status.innerHTML=icon(loading[state.view]?'loading':failed[state.view]?'error':'empty');shelf.appendChild(status);return;}
 for(const game of entries()){
 const card=button(shelf,'play','Preview game',()=>preview(game),'game-card');card.dataset.gameId=game.id;card.replaceChildren();const image=doc.createElement('img');image.src=game.artwork;image.alt='';card.appendChild(image);
 const badge=doc.createElement('span');badge.className='card-badge';badge.innerHTML=state.isFavorite(game.id)?icon('star'):state.view==='store'&&library.some(x=>x.id===game.id)?icon('check'):'';card.appendChild(badge);
 card.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')preview(game);});card.addEventListener('focus',()=>preview(game));
 }}
 function preview(game){if(state.detail?.id===game.id&&!detail.hidden)return;pausePreview();state.select(game);detail.replaceChildren();detail.hidden=false;body.classList.add('has-detail');
 button(detail,'back','Close preview',()=>closePreview(true),'detail-close');
 const media=doc.createElement(game.attract?'video':'img');media.className='preview-media';media.src=game.attract||game.artwork;if(game.attract){media.autoplay=true;media.muted=true;media.addEventListener('ended',()=>{media.load();media.play().catch(()=>{});});media.playsInline=true;media.setAttribute('playsinline','');media.addEventListener('error',()=>{const image=doc.createElement('img');image.className='preview-media';image.src=game.artwork;image.alt='';media.replaceWith(image);});}else media.alt='';detail.appendChild(media);if(game.attract)media.play().catch(()=>{});
 const actions=doc.createElement('div');actions.className='detail-actions';detail.appendChild(actions);
 const star=button(actions,'star','Favorite',()=>{state.favorite(game.id);star.setAttribute('aria-pressed',String(state.isFavorite(game.id)));const badge=shelf.querySelector('[data-game-id="'+game.id+'"] .card-badge');if(badge)badge.innerHTML=state.isFavorite(game.id)?icon('star'):state.view==='store'&&library.some(x=>x.id===game.id)?icon('check'):'';},'favorite');star.setAttribute('aria-pressed',String(state.isFavorite(game.id)));
 refreshOwnership();
 }
 // Update ownership in place: asynchronous Library discovery must not restart the
 // Store trailer or steal focus from its favorite/back controls.
 function refreshOwnership(){
 for(const card of shelf.querySelectorAll('.game-card')){const id=card.dataset.gameId,badge=card.querySelector('.card-badge');if(badge)badge.innerHTML=state.isFavorite(id)?icon('star'):state.view==='store'&&library.some(x=>x.id===id)?icon('check'):'';}
 if(detail.hidden||!state.detail)return;
 const actions=detail.querySelector('.detail-actions'),installed=library.find(x=>x.id===state.detail.id);if(!actions)return;
 if(installed){actions.querySelector('.not-installed')?.remove();if(!actions.querySelector('.play-game'))button(actions,'play','Play game',()=>{win.location.href=installed.entrypoint;},'play-game');}
 else if(!actions.querySelector('.not-installed')){const status=doc.createElement('span');status.className='not-installed';status.setAttribute('aria-label','Not installed; adult installation required');status.innerHTML=icon('down');actions.appendChild(status);}
 }
 function closePreview(focusCard){const id=state.detail?.id;pausePreview();state.detail=null;detail.hidden=true;body.classList.remove('has-detail');if(focusCard){const card=shelf.querySelector('[data-game-id="'+id+'"]');if(card){suppressPreview=true;card.focus();suppressPreview=false;}}}
 let suppressPreview=false;
 // Closing via back must leave focus on the card without reopening its preview.
 shelf.addEventListener('focusin',e=>{if(suppressPreview){pausePreview();detail.hidden=true;body.classList.remove('has-detail');state.detail=null;}});
 function renderOptions(){options.replaceChildren();const touch=doc.createElement('div');touch.className='touch-settings';touch.setAttribute('role','group');touch.setAttribute('aria-label','Touch controls');touch.innerHTML='<div class="setting-symbol">'+icon('touch')+'</div>';options.appendChild(touch);
 for(const [mode,glyph,label] of [['auto','auto','Automatic touch controls'],['on','touch','Show touch controls'],['off','off','Hide touch controls']]){const b=button(touch,glyph,label,()=>{prefs.set({touchOverlay:mode});updateTouch();});b.dataset.mode=mode;b.setAttribute('aria-pressed',String(prefs.get().touchOverlay===mode));}
 if(platform.capabilities.quit)button(options,'quit','Quit application',openQuit,'quit-app');
 const setup=doc.createElement('div');setup.className='adult-entry';options.appendChild(setup);const b=button(setup,'keyboard','Adult keyboard setup',openAdult);b.insertAdjacentHTML('beforeend',icon('adult'));
 }
 function updateTouch(){options.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(prefs.get().touchOverlay===b.dataset.mode)));}
 function stopCapture(){if(cancelCapture){cancelCapture();cancelCapture=null;}}
 function closeAdult(apply){stopCapture();if(draft){if(apply)draft.apply();else draft.cancel();}draft=null;adult=false;dialog.close();tabs.options.focus();}
 function openAdult(){if(adult)return;adult=true;draft=prefs.editKeyboard();dialog.replaceChildren();const heading=doc.createElement('h1');heading.textContent='Adult setup';dialog.appendChild(heading);const instruction=doc.createElement('p');instruction.textContent='Choose a control, then press a key. Changes apply only when saved.';dialog.appendChild(instruction);
 const rows=doc.createElement('div');rows.className='key-rows';dialog.appendChild(rows);const feedback=doc.createElement('p');feedback.className='key-feedback';feedback.setAttribute('role','status');dialog.appendChild(feedback);
 function renderRows(){rows.replaceChildren();for(const name of win.HandheldPreferences.BUTTONS){const b=doc.createElement('button');b.type='button';b.textContent=name+' · '+draft.get()[name].join(' / ');b.dataset.binding=name;b.addEventListener('click',()=>{stopCapture();feedback.textContent='Press a key for '+name+'. Use Cancel capture to stop.';b.classList.add('capturing');cancelCapture=input.captureKeyboard(code=>{try{draft.setBinding(name,[code]);stopCapture();feedback.textContent='';renderRows();rows.querySelector('[data-binding="'+name+'"]').focus();}catch{feedback.textContent='That key is already assigned. Choose another key or cancel capture.';}});});rows.appendChild(b);}}
 renderRows();const actions=doc.createElement('div');actions.className='adult-actions';dialog.appendChild(actions);
 for(const [label,fn] of [['Cancel capture',()=>{stopCapture();feedback.textContent='';renderRows();}],['Reset keys',()=>{stopCapture();draft.reset();feedback.textContent='';renderRows();}],['Cancel',()=>closeAdult(false)],['Save',()=>closeAdult(true)]]){const b=doc.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',fn);actions.appendChild(b);}
 dialog.showModal();dialog.querySelector('button').focus();}
 dialog.addEventListener('cancel',e=>{e.preventDefault();closeAdult(false);});
 const input=win.HandheldInput.createInput({navigationShoulders:true,onAction:event=>{const a=event.action;if(quitDialog.open){const nodes=Array.from(quitDialog.querySelectorAll('button'));if(a==='back'||a==='exit')closeQuit();else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a)){const index=nodes.indexOf(doc.activeElement);nodes[(index+1)%nodes.length]?.focus();}return;}if(adult){const nodes=Array.from(dialog.querySelectorAll('button')),index=nodes.indexOf(doc.activeElement);if(a==='back'||a==='exit')closeAdult(false);else if(a==='confirm'||a==='pause')doc.activeElement?.click();else if(['left','right','up','down'].includes(a))nodes[(index+(['left','up'].includes(a)?-1:1)+nodes.length)%nodes.length]?.focus();return;}
 if(a==='exit'||a==='back'){if(!detail.hidden)closePreview(true);else show('library');return;}
 if(a==='select'||a==='nextView'||a==='previousView'){const names=['library','store','options'];show(names[(names.indexOf(state.view)+(a==='previousView'?2:1))%3]);tabs[state.view].focus();return;}
 const nodes=Array.from(host.querySelectorAll('button')).filter(b=>!b.closest('[hidden]')&&!b.closest('dialog')&&!b.disabled);if(!nodes.length)return;
 const active=doc.activeElement,index=nodes.indexOf(active);
 if(a==='confirm'||a==='pause'){if(index<0){const first=shelf.querySelector('.game-card')||nodes[0];first.focus();}else if(active.classList.contains('game-card')){preview(entries().find(g=>g.id===active.dataset.gameId));detail.querySelector('.play-game')?.focus();}else active.click();return;}
 if(['left','right','up','down'].includes(a)){const origin=active?.getBoundingClientRect(),horizontal=a==='left'||a==='right',positive=a==='right'||a==='down';let next;if(origin&&index>=0){const x=origin.left+origin.width/2,y=origin.top+origin.height/2;const candidates=nodes.filter(n=>n!==active).map(n=>{const r=n.getBoundingClientRect(),dx=r.left+r.width/2-x,dy=r.top+r.height/2-y,primary=horizontal?dx:dy,secondary=horizontal?dy:dx;return {n,primary,score:Math.abs(primary)+Math.abs(secondary)*2};}).filter(c=>positive?c.primary>4:c.primary < -4).sort((a,b)=>a.score-b.score);next=candidates[0]?.n;}if(!next){const delta=positive?1:-1;next=nodes[(index+delta+nodes.length)%nodes.length];}next.focus();}
 }});
 const unsubscribe=prefs.subscribe(updateTouch);
 win.addEventListener('pagehide',()=>{disposed=true;pausePreview();stopCapture();unsubscribe();input.dispose();});
 win.addEventListener('blur',pausePreview);win.addEventListener('focus',()=>{if(!detail.hidden)detail.querySelector('video')?.play().catch(()=>{});});
 for(const [view,request] of [['library',platform.library()],['store',platform.catalog()]])request.then(entries=>{if(disposed)return;if(view==='library')library=entries;else catalog=entries;loading[view]=false;if(state.view===view)renderGrid();if(view==='library')refreshOwnership();}).catch(()=>{if(disposed)return;failed[view]=true;loading[view]=false;if(state.view===view)renderGrid();});show('library');
 win.fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'picker',errors:[]})}).catch(()=>{});
 return {state,show,dispose:()=>input.dispose()};
}
return {createState,mount};
});

const test=require('node:test'),assert=require('node:assert/strict');
const Hub=require('../runtime/core/hub.js');
test('library is the initial view and state tracks explicit selections',()=>{
 const store=new Map(),s=Hub.createState({getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)});
 assert.equal(s.view,'library');assert.equal(s.detail,null);
 s.show('store');s.select({id:'demo'});assert.equal(s.detail.id,'demo');
 s.favorite('demo');assert.equal(s.isFavorite('demo'),true);
 assert.equal(Hub.createState({getItem:k=>store.get(k)||null}).isFavorite('demo'),true);
 s.show('options');assert.equal(s.detail,null);assert.throws(()=>s.show('unknown'));
});

test('host-supplied settings replace keyboard setup and every icon resolves',()=>{
 const source=require('node:fs').readFileSync(require.resolve('../runtime/core/hub.js'),'utf8');
 assert.match(source,/platform\.settings\?\.length/);
 const paths=source.slice(source.indexOf('const paths={'),source.indexOf('function icon('));
 for(const [,name] of source.matchAll(/(?:icon\(|\?)'([a-z]+)'/g))if(/^(retry|play|down|loading)$/.test(name))assert.match(paths,new RegExp('[{,]'+name+":'"));
 const bridge=require('node:fs').readFileSync(require.resolve('../rocknix/bridge.js'),'utf8');
 assert.doesNotMatch(bridge,/⚙/);assert.match(bridge,/\/adult\/network/);assert.match(bridge,/\/adult\/updates/);
});
test('settings math question is easy mental math and matches its answer',()=>{
 const {challenge}=require('../runtime/core/hub.js');const ops=new Set();
 for(let i=0;i<2000;i++){
  const {text,answer}=challenge(),[,a,op,b]=text.match(/^What's (\d) ([+×]) (\d)\?$/);ops.add(op);
  const value=op==='+'?+a + +b:a*b;assert.equal(answer,String(value));assert.ok(value>=9&&value<=25,text);
 }
 assert.deepEqual([...ops].sort(),['+','×'].sort());
});
test('options contain adult setup but no manual touch controls',()=>{
 const source=require('node:fs').readFileSync('runtime/core/hub.js','utf8');
 assert.match(source,/Adult keyboard setup/);assert.doesNotMatch(source,/touch-settings|data-mode|Automatic touch controls|Show touch controls|Hide touch controls/);
});

// Small DOM adapter for exercising the mounted hub without a browser dependency.
function mountedHub(games,catalog=[],capabilities={},overrides={},windowOverrides={}){
 let onInstall,onAction,revision=0;
 class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.hidden=false;this.listeners={};this.style={setProperty(){},removeProperty(){}};this.className='';this.ownerDocument=doc;this.classList={contains:n=>this.className.split(' ').includes(n),add:n=>{if(!this.classList.contains(n))this.className+=' '+n;},remove:n=>{this.className=this.className.split(' ').filter(x=>x!==n).join(' ');},toggle:(n,on)=>{on??=!this.classList.contains(n);this.classList[on?'add':'remove'](n);}};}
  appendChild(e){this.children.push(e);e.parent=this;return e;}
  replaceChildren(...nodes){this.children=[];nodes.forEach(n=>this.appendChild(n));}
  set innerHTML(value){this._html=value;this.replaceChildren();if(value.includes('class="topbar"'))for(const cls of ['brand','view-nav','view-body','hero-backdrop','hero-rest','shelf','detail','options-panel','adult-setup','hud']){const e=this.appendChild(new Element(cls==='adult-setup'?'dialog':'div'));e.className=cls;if(cls==='detail')e.hidden=true;if(cls==='hero-rest')e.appendChild(new Element('img'));}}
  get innerHTML(){return this._html||'';}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  removeAttribute(k){delete this.attributes[k];}
  addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
  matches(selector){return selector.split(',').some(s=>{s=s.trim();const data=s.match(/\[data-game-id="([^"]+)"\]/);if(data)return this.dataset.gameId===data[1];const cls=s.match(/\.([\w-]+)/);return (!cls||this.classList.contains(cls[1]))&&(!s.startsWith('dialog')||this.tagName==='dialog')&&(!s.startsWith('button')||this.tagName==='button')&&(!s.startsWith('video')||this.tagName==='video')&&(!s.startsWith('img')||this.tagName==='img')&&(!s.includes(':not(:disabled)')||!this.disabled);});}
  querySelectorAll(selector){if(selector==='.hero-rest img')return this.querySelector('.hero-rest')?.querySelectorAll('img')||[];return this.children.flatMap(e=>[...(e.matches(selector)?[e]:[]),...e.querySelectorAll(selector)]);}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  getBoundingClientRect(){return {left:0,top:0,width:0,height:0};}
  closest(s){for(let e=this;e;e=e.parent)if(s==='[hidden]'?e.hidden:s==='dialog'?e.tagName==='dialog':e.matches(s))return e;return null;}
  focus(){doc.activeElement=this;for(const fn of this.listeners.focus||[])fn();let e=this.parent;while(e){for(const fn of e.listeners.focusin||[])fn();e=e.parent;}}
  showModal(){this.open=true;}close(){this.open=false;}
  click(){if(this.disabled)return;for(const fn of this.listeners.click||[])fn();}
  insertAdjacentHTML(){}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  play(){this.playCount=(this.playCount||0)+1;return Promise.resolve();}pause(){this.pauseCount=(this.pauseCount||0)+1;}load(){}
 }
 const doc={createElement:tag=>new Element(tag),activeElement:null};
 const platform={capabilities,library:async()=>games,catalog:async()=>catalog,install:async()=>{},onInstallState:fn=>{onInstall=fn;},installStatus:async()=>({}),...overrides};
 const windowListeners=new Map();
 doc.defaultView={localStorage:{getItem:()=>null},HandheldPreferences:{preferences:{subscribe:()=>()=>{},get:()=>({touchOverlay:'auto'})}},HandheldPlatform:{createPlatform:()=>platform},HandheldInput:{createInput:options=>(onAction=options.onAction,{dispose(){}})},
 addEventListener(type,listener){if(!windowListeners.has(type))windowListeners.set(type,new Set());windowListeners.get(type).add(listener);},
 removeEventListener(type,listener){windowListeners.get(type)?.delete(listener);},listenerCount:()=>[...windowListeners.values()].reduce((count,set)=>count+set.size,0),fetch:()=>Promise.resolve(),location:{},setTimeout:()=>0,clearTimeout(){},...windowOverrides};
 const host=new Element(),hub=Hub.mount(host);
 return {host,hub,action:action=>onAction({action}),refresh:entries=>{games=entries;onInstall({refresh:{phase:'installed',version:++revision}});}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const games=[{id:'one',artwork:'one.svg',entrypoint:'/one'},{id:'two',artwork:'two.svg',entrypoint:'/two'}];
test('nonempty Library selects and previews a game on load and return',async()=>{
 const {host,hub}=mountedHub(games);await settle();
 assert.equal(hub.state.detail?.id,'one');assert.equal(host.querySelector('.detail').hidden,false);
 assert.equal(host.querySelectorAll('.is-selected').length,1);
 hub.show('options');hub.show('library');
 assert.equal(hub.state.detail?.id,'one');assert.equal(host.querySelectorAll('.is-selected').length,1);
});
test('Library refresh preserves a selection and falls back when it disappears',async()=>{
 const {host,hub,refresh}=mountedHub(games);await settle();
 host.querySelector('[data-game-id="two"]').click();refresh([...games,{id:'three',artwork:'three.svg'}]);await settle();
 assert.equal(hub.state.detail.id,'two');assert.equal(host.querySelectorAll('.is-selected').length,1);
 refresh([games[0]]);await settle();assert.equal(hub.state.detail.id,'one');assert.equal(host.querySelectorAll('.is-selected').length,1);
 refresh([]);await settle();assert.equal(hub.state.detail,null);assert.equal(host.querySelector('.detail').hidden,true);assert.equal(host.querySelectorAll('.is-selected').length,0);
});
for(const view of ['library','store'])test(view+' Back preserves actionable selection and returns focus through shelf to tab',async()=>{
 const offers=games.map(game=>({...game,attract:game.id+'.webm',manifest_url:'/manifest'}));
 const control=view==='store'?'.download-game':'.play-game';
 const {host,hub,action}=mountedHub(view==='store'?[]:offers,offers,{install:true});await settle();hub.show(view);
 const card=host.querySelector('[data-game-id="two"]');card.click();
 const media=host.querySelector('.preview-media'),actions=host.querySelector('.detail-actions');
 const pauseCount=media.pauseCount||0,playCount=media.playCount;
 const assertSelection=()=>{
  assert.equal(hub.state.view,view);assert.equal(hub.state.detail?.id,'two');
  assert.equal(host.querySelector('.detail').hidden,false);
  assert.equal(host.querySelector('.preview-media'),media);assert.equal(host.querySelector('.detail-actions'),actions);
  assert.ok(host.querySelector(control));assert.equal(host.querySelector('.is-selected'),card);
  assert.equal(media.pauseCount||0,pauseCount);assert.equal(media.playCount,playCount);
 };
 host.querySelector('.detail-close').click();assertSelection();assert.equal(host.ownerDocument.activeElement,card);
 action('back');assertSelection();assert.equal(host.ownerDocument.activeElement.getAttribute('aria-label'),view);
 action('back');assertSelection();assert.equal(host.ownerDocument.activeElement.getAttribute('aria-label'),view);
 host.querySelector('.favorite').focus();action('exit');assertSelection();assert.equal(host.ownerDocument.activeElement,card);
 action('exit');assertSelection();assert.equal(host.ownerDocument.activeElement.getAttribute('aria-label'),view);
});
test('uninstalled Store selection keeps its download action after Back',async()=>{
 const offers=games.map(game=>({...game,manifest_url:'/manifest'}));
 const {host,hub,action}=mountedHub([],offers,{install:true});await settle();
 const card=host.querySelector('[data-game-id="two"]');card.click();
 const download=host.querySelector('.download-game');assert.ok(download);
 const media=host.querySelector('.preview-media');assert.equal(media.tagName,'img');assert.equal(media.src,'two.svg');
 assert.equal(host.querySelectorAll('video').length,0);
 host.querySelector('.detail-close').click();
 for(const control of ['back','back','exit']){
  action(control);assert.equal(hub.state.view,'store');assert.equal(hub.state.detail?.id,'two');
  assert.equal(host.querySelector('.detail').hidden,false);assert.equal(host.querySelector('.download-game'),download);
 }
});
test('empty Library remains an empty pictorial state',async()=>{
 const {host,hub}=mountedHub([]);await settle();hub.show('library');
 assert.equal(hub.state.detail,null);assert.equal(host.querySelector('.detail').hidden,true);assert.equal(host.querySelectorAll('.game-card').length,0);
});
test('mounted hub disposal removes its window lifecycle listeners and is idempotent',async()=>{
 const {host,hub}=mountedHub(games);await settle();
 const win=host.ownerDocument.defaultView;
 assert.equal(win.listenerCount(),4);
 assert.doesNotThrow(()=>hub.dispose());assert.equal(win.listenerCount(),0);
 hub.dispose();assert.equal(win.listenerCount(),0);
});

test('nonempty Store selects its first offer on load and return',async()=>{
 const {host,hub}=mountedHub(games,[{id:'offer',artwork:'offer.svg',manifest_url:'/offer.json'}]);await settle();
 hub.show('store');
 assert.equal(hub.state.detail?.id,'offer');assert.equal(host.querySelector('.detail').hidden,false);
 assert.equal(host.querySelectorAll('.is-selected').length,1);
 hub.show('options');hub.show('store');
 assert.equal(hub.state.detail?.id,'offer');assert.equal(host.querySelectorAll('.is-selected').length,1);
});
const shelfIds=host=>host.querySelectorAll('.game-card').map(card=>card.dataset.gameId);
const offers=games.map(game=>({...game,manifest_url:'/manifest'}));
for(const view of ['library','store'])for(const control of ['click','confirm','pause'])test(view+' tab '+control+' hands focus to the selected game action',async()=>{
 let installed;const {host,hub,action}=mountedHub(games,offers.map(g=>({...g,id:'offer-'+g.id})),{install:true},{install:async id=>{installed=id;}});await settle();
 const tab=host.querySelectorAll('.view-tab').find(t=>t.getAttribute('aria-label')===view);tab.focus();
 if(control==='click')tab.click();else action(control);
 const primary=host.querySelector(view==='library'?'.play-game':'.download-game');
 assert.equal(host.ownerDocument.activeElement,primary);
 action('confirm');await settle();
 if(view==='library')assert.equal(host.ownerDocument.defaultView.location.href,games[0].entrypoint);else assert.equal(installed,'offer-one');
 assert.equal(hub.state.view,view);
});
test('view cycling enters content, including the first options control',async()=>{
 const {host,hub,action}=mountedHub(games,[{...offers[0],id:'offer'}],{install:true});await settle();
 action('nextView');assert.equal(hub.state.view,'store');assert.equal(host.ownerDocument.activeElement,host.querySelector('.download-game'));
 action('select');assert.equal(hub.state.view,'options');assert.equal(host.ownerDocument.activeElement,host.querySelector('.options-panel').querySelector('button'));
 action('previousView');assert.equal(host.ownerDocument.activeElement,host.querySelector('.download-game'));
});
test('gear tab shows only the question until answered, and locks again on leaving',async()=>{
 const {host,hub,action}=mountedHub(games,[],{},{settings:[{icon:'trash',label:'Game saves',href:'#adult-saves'}]});await settle();
 const tab=host.querySelectorAll('.view-tab')[2];tab.focus();tab.click();
 const panel=host.querySelector('.options-panel');
 assert.equal(host.querySelector('.settings-tile'),null);assert.equal(host.ownerDocument.activeElement,host.querySelector('.gate-pad').querySelector('button'));
 action('confirm');assert.equal(host.querySelector('.gate-entry').textContent,'1');
 wrongGate(host);assert.equal(host.querySelector('.gate-feedback').textContent,'Try again.');assert.equal(host.querySelector('.gate-entry').textContent,'');assert.equal(host.querySelector('.settings-tile'),null);
 passGate(host);assert.equal(host.querySelector('.settings-gate'),null);assert.equal(host.ownerDocument.activeElement,panel.querySelector('.settings-tile'));
 hub.show('options');assert.ok(host.querySelector('.settings-tile'),'Staying on the tab stays unlocked');
 hub.show('library');hub.show('options');assert.equal(host.querySelector('.settings-tile'),null);assert.ok(host.querySelector('.settings-gate'));
});
test('every host gates its whole settings tab, including Quit',async()=>{
 const {host,hub}=mountedHub(games,[],{quit:true},{quit:async()=>{}});await settle();hub.show('options');
 for(const name of ['.quit-app','.manage-saves','.adult-entry'])assert.equal(host.querySelector(name),null,name);
 passGate(host);for(const name of ['.quit-app','.manage-saves','.adult-entry'])assert.ok(host.querySelector(name),name);
});
test('the question never traps a child: shoulders and Back move on, and the D-pad reaches the tabs',async()=>{
 const {host,hub,action}=mountedHub(games,[],{},{settings:[{icon:'trash',label:'Game saves',href:'#adult-saves'}]});await settle();
 action('previousView');assert.equal(hub.state.view,'options');action('nextView');assert.equal(hub.state.view,'library');
 action('previousView');assert.equal(hub.state.view,'options');action('back');assert.equal(hub.state.view,'library');
 action('previousView');const keys=host.querySelector('.gate-pad').querySelectorAll('button'),active=()=>host.ownerDocument.activeElement;
 action('right');assert.equal(active(),keys[1]);action('down');assert.equal(active(),keys[4]);action('left');assert.equal(active(),keys[3]);action('up');assert.equal(active(),keys[0]);
 action('left');assert.equal(active(),keys[2]);action('down');action('down');action('down');assert.equal(active(),keys[11]);action('down');assert.equal(active(),keys[2]);
 action('up');assert.equal(active(),host.querySelectorAll('.view-tab')[2]);
});
test('Start submits the answer from the keypad',async()=>{
 const {host,hub,action}=mountedHub(games,[],{},{settings:[{icon:'trash',label:'Game saves',href:'#adult-saves'}]});await settle();hub.show('options');
 host.querySelector('.gate-pad').querySelector('button').focus();typeAnswer(host);action('pause');assert.ok(host.querySelector('.settings-tile'));
});
test('returning from a worded page keeps the answered gate once; other arrivals ask again',async()=>{
 const stored=new Map(),sessionStorage={getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},history={replaceState(){}};
 const settings=[{icon:'wifi',label:'Wi-Fi settings',href:'/adult/network'}];
 const first=mountedHub(games,[],{},{settings},{sessionStorage,history,location:{}});await settle();first.hub.show('options');
 assert.equal(stored.size,0);passGate(first.host);first.host.querySelector('.settings-tile').click();assert.equal(stored.size,1);
 const back=mountedHub(games,[],{},{settings},{sessionStorage,history,location:{hash:'#options',pathname:'/'}});await settle();
 assert.equal(back.hub.state.view,'options');assert.ok(back.host.querySelector('.settings-tile'));assert.equal(stored.size,0);
 const again=mountedHub(games,[],{},{settings},{sessionStorage,history,location:{hash:'#options',pathname:'/'}});await settle();
 assert.equal(again.host.querySelector('.settings-tile'),null);assert.ok(again.host.querySelector('.settings-gate'));
 stored.set('cubby:settings-return','1');
 const home=mountedHub(games,[],{},{settings},{sessionStorage,history,location:{}});await settle();assert.equal(stored.size,0);home.hub.show('options');assert.equal(home.host.querySelector('.settings-tile'),null);
});
test('power tiles confirm first, stay put while shutting down, and report failure',async()=>{
 let calls=[],fail=false,expired=null;const settings=[{icon:'trash',label:'Game saves',href:'#adult-saves'}];
 const {host,hub,action}=mountedHub(games,[],{power:true},{settings,power:async mode=>{calls.push(mode);if(fail)throw Error('busy');}},{setTimeout:fn=>{expired=fn;return 1;}});await settle();hub.show('options');
 assert.equal(host.querySelector('.power-off'),null);passGate(host);
 const off=host.querySelector('.power-off'),restart=host.querySelector('.restart-device'),dialog=host.querySelector('.quit-confirm');
 off.click();assert.equal(dialog.open,true);assert.equal(dialog.getAttribute('aria-label'),'Power off?');assert.deepEqual(calls,[]);assert.equal(host.ownerDocument.activeElement,host.querySelector('.cancel-quit'));
 action('back');assert.equal(dialog.open,false);assert.equal(host.ownerDocument.activeElement,off);assert.deepEqual(calls,[]);
 restart.click();assert.equal(dialog.getAttribute('aria-label'),'Restart?');action('right');action('confirm');await settle();assert.deepEqual(calls,['reboot']);
 assert.equal(host.querySelector('.power-note').textContent,'Restarting…');assert.ok(host.querySelector('.confirm-quit').disabled);action('back');assert.equal(dialog.open,true,'Cannot back out of a shutdown');
 expired();assert.match(host.querySelector('.power-note').textContent,/Could not restart/);assert.equal(host.querySelector('.confirm-quit').disabled,false);
 action('back');assert.equal(dialog.open,false);assert.equal(host.ownerDocument.activeElement,restart);
 fail=true;off.click();host.querySelector('.confirm-quit').click();await settle();assert.deepEqual(calls,['reboot','poweroff']);assert.match(host.querySelector('.power-note').textContent,/Could not power off/);assert.equal(host.ownerDocument.activeElement,host.querySelector('.cancel-quit'));
});
test('hosts without power control show no power tiles',async()=>{
 const {host,hub}=mountedHub(games,[],{},{settings:[{icon:'trash',label:'Game saves',href:'#adult-saves'}]});await settle();hub.show('options');passGate(host);
 assert.equal(host.querySelector('.power-off'),null);assert.equal(host.querySelector('.restart-device'),null);
});
test('tab activation never focuses a disabled Play action',async()=>{
 const {host}=mountedHub(games,[],{tokens:true},{account:async()=>({available:true,balance:0})});await settle();
 const tab=host.querySelectorAll('.view-tab')[0];tab.focus();tab.click();
 assert.equal(host.querySelector('.play-game').disabled,true);
 assert.equal(host.ownerDocument.activeElement,host.querySelector('.favorite'));
});
test('activating a loading tab transfers focus only if the user stayed on that tab',async()=>{
 for(const moveAway of [false,true]){
  let resolve;const {host}=mountedHub(games,new Promise(r=>{resolve=r;}),{install:true});await settle();
  const tabs=host.querySelectorAll('.view-tab');tabs[1].focus();tabs[1].click();assert.equal(host.ownerDocument.activeElement,tabs[1]);
  if(moveAway)tabs[2].focus();resolve([{...offers[0],id:'offer'}]);await settle();
  assert.equal(host.ownerDocument.activeElement,moveAway?tabs[2]:host.querySelector('.download-game'));
 }
});
test('empty, failed and all-owned tab activation keeps a usable tab focused',async()=>{
 for(const catalog of [[],games,null]){
  const {host}=mountedHub(games,catalog||[],{install:true},catalog?{}:{catalog:async()=>{throw Error('offline');}});await settle();
  const tab=host.querySelectorAll('.view-tab')[1];tab.focus();tab.click();assert.equal(host.ownerDocument.activeElement,tab);
 }
});
test('Store shows Library games as inert checked pictures after its offers',async()=>{
 const {host,hub}=mountedHub([games[0]],[games[0],games[1]],{install:true,uninstall:true});await settle();
 hub.show('library');host.querySelector('.favorite').click();hub.show('store');
 assert.deepEqual(shelfIds(host),['two','one']);assert.equal(hub.state.detail.id,'two');
 const owned=host.querySelector('[data-game-id="one"]'),offer=host.querySelector('[data-game-id="two"]');
 assert.equal(owned.disabled,true);assert.ok(owned.classList.contains('is-owned'));assert.equal(owned.getAttribute('aria-label'),'In library');
 assert.equal(owned.querySelector('.card-badge').dataset.kind,'installed');
 assert.equal(offer.disabled,false);assert.ok(!offer.classList.contains('is-owned'));
 hub.show('library');const card=host.querySelector('[data-game-id="one"]');
 assert.equal(card.disabled,false);assert.equal(card.querySelector('.card-badge').dataset.kind,'favorite');
});
test('Store with every game owned rests with nothing to activate',async()=>{
 const {host,hub,action}=mountedHub(games,games,{install:true,uninstall:true});await settle();
 hub.show('store');const doc=host.ownerDocument;
 assert.equal(hub.state.detail,null);assert.equal(host.querySelector('.detail').hidden,true);
 assert.ok(host.querySelector('.view-body').classList.contains('all-owned'));
 assert.equal(host.querySelectorAll('.game-card').every(card=>card.disabled),true);
 for(const name of ['.play-game','.uninstall-game','.favorite','.download-game'])assert.equal(host.querySelector(name),null);
 const tab=host.querySelectorAll('.view-tab').find(x=>x.getAttribute('aria-current'));tab.focus();
 action('down');action('up');assert.equal(doc.activeElement,tab);
 doc.activeElement=null;action('confirm');assert.ok(doc.activeElement.classList.contains('view-tab'));
 hub.show('library');assert.ok(!host.querySelector('.view-body').classList.contains('all-owned'));assert.ok(host.querySelector('.play-game'));
});
test('finished Store download hands off to Library Play',async()=>{
 const {host,hub,refresh}=mountedHub([],offers,{install:true});await settle();
 host.querySelector('[data-game-id="two"]').click();host.querySelector('.download-game').click();
 refresh([games[1]]);await settle();
 assert.equal(hub.state.view,'library');assert.equal(hub.state.detail.id,'two');
 assert.equal(host.ownerDocument.activeElement,host.querySelector('.play-game'));
});
test('download finishing behind another Store preview stays in the Store',async()=>{
 const {host,hub,refresh}=mountedHub([],offers,{install:true});await settle();
 host.querySelector('[data-game-id="one"]').click();host.querySelector('.download-game').click();
 const other=host.querySelector('[data-game-id="two"]');other.click();const media=host.querySelector('.preview-media');
 refresh([games[0]]);await settle();
 assert.equal(hub.state.view,'store');assert.equal(hub.state.detail.id,'two');assert.equal(host.querySelector('.preview-media'),media);
 assert.equal(host.querySelector('[data-game-id="one"]').disabled,true);assert.equal(other.disabled,false);
});
test('late Library discovery moves Store off a game it turns out to own',async()=>{
 let resolve;const {host,hub}=mountedHub(new Promise(r=>{resolve=r;}),games,{install:true});
 await settle();hub.show('store');await settle();assert.equal(hub.state.detail.id,'one');
 resolve([games[0]]);await settle();
 assert.equal(hub.state.view,'store');assert.equal(hub.state.detail.id,'two');assert.deepEqual(shelfIds(host),['two','one']);
});

function gateAnswer(host){const q=host.querySelector('.gate-question').textContent.match(/(\d) ([+×]) (\d)/);return String(q[2]==='+'?+q[1] + +q[3]:q[1]*q[3]);}
function typeGate(host,answer){const keys=host.querySelector('.gate-pad').querySelectorAll('button');for(const digit of answer)keys.find(b=>b.textContent===digit).click();}
function typeAnswer(host){typeGate(host,gateAnswer(host));}
function passGate(host){typeAnswer(host);host.querySelector('.gate-submit').click();}
function wrongGate(host){host.querySelector('.gate-erase').click();host.querySelector('.gate-erase').click();typeGate(host,String(+gateAnswer(host)+1));host.querySelector('.gate-submit').click();}
test('save deletion requires adult gate and explicit confirmation; cancel preserves saves',async()=>{
 let saves=['one','uninstalled'],resets=[];
 const {host,hub,action}=mountedHub(games,[],{}, {savedGames:async()=>saves,resetGameSaves:async id=>{resets.push(id);saves=saves.filter(x=>x!==id);}});await settle();hub.show('options');
 assert.equal(host.querySelector('.manage-saves'),null);assert.equal(host.querySelector('.save-management').open,undefined);
 passGate(host);host.querySelector('.manage-saves').click();await settle();assert.equal(host.querySelector('.save-management').open,true);
 const choice=host.querySelectorAll('.choose-save')[0];choice.click();assert.deepEqual(resets,[]);assert.equal(host.ownerDocument.activeElement,host.querySelector('.cancel-reset'));
 host.querySelector('.cancel-reset').click();assert.deepEqual(resets,[]);assert.equal(host.querySelectorAll('.choose-save').length,2);
 host.querySelectorAll('.choose-save')[1].click();host.querySelector('.confirm-reset').click();host.querySelector('.confirm-reset').click();await settle();
 assert.deepEqual(resets,['uninstalled']);assert.match(host.querySelector('.save-feedback').textContent,/deleted/);assert.equal(host.querySelectorAll('.choose-save').length,1);
 action('back');assert.equal(host.querySelector('.save-management').open,false);assert.equal(host.ownerDocument.activeElement.getAttribute('aria-label'),'options');
});
test('device save tile sits behind the shared gate; reset errors retain retry and cancel',async()=>{
 const {host,hub}=mountedHub(games,[],{}, {settings:[{icon:'trash',label:'Game saves',href:'#adult-saves'}],savedGames:async()=>['one'],resetGameSaves:async()=>{throw Error('denied');}});await settle();hub.show('options');passGate(host);host.querySelector('.settings-tile').click();await settle();
 host.querySelector('.choose-save').click();host.querySelector('.confirm-reset').click();await settle();
 assert.match(host.querySelector('.save-feedback').textContent,/could not/i);assert.equal(host.querySelector('.confirm-reset').disabled,false);assert.equal(host.querySelector('.cancel-reset').disabled,false);
});

test('catalog polling catches up online/visible, coalesces, and stops with document',async()=>{
 const events=new Map(),docEvents=new Map();let tick,reads=0,resolve,stopped=0;
 const win={document:{hidden:false,addEventListener:(n,f)=>docEvents.set(n,f),removeEventListener:n=>docEvents.delete(n)},navigator:{onLine:true},setInterval:(f,ms)=>{assert.equal(ms,300000);tick=f;return 7;},clearInterval:id=>{assert.equal(id,7);stopped++;},addEventListener:(n,f)=>events.set(n,f),removeEventListener:n=>events.delete(n)};
 const stop=Hub.startCatalogChecks(win,()=>{reads++;return new Promise(r=>resolve=r);});
 tick();tick();assert.equal(reads,1);resolve();await settle();win.document.hidden=true;tick();assert.equal(reads,1);
 win.document.hidden=false;win.navigator.onLine=false;docEvents.get('visibilitychange')();assert.equal(reads,1);
 win.navigator.onLine=true;events.get('online')();assert.equal(reads,2);stop();resolve();await settle();tick();assert.equal(reads,2);assert.equal(stopped,1);assert.equal(events.size,0);assert.equal(docEvents.size,0);
});

test('catalog refresh adds/removes Store offers without restarting preview or losing focus; failure keeps shelf',async()=>{
 let catalog=games;
 const {host,hub}=mountedHub([],[],{install:true},{catalog:async()=>catalog});await settle();
 const selected=host.querySelector('[data-game-id="one"]');selected.focus();const media=host.querySelector('.preview-media');
 catalog=[games[0],{...games[1],id:'three'}];await hub.refreshCatalog();
 assert.deepEqual(shelfIds(host),['one','three']);assert.equal(host.querySelector('.preview-media'),media);assert.equal(host.ownerDocument.activeElement.dataset.gameId,'one');
 catalog=[{...games[1],id:'three'}];await hub.refreshCatalog();assert.deepEqual(shelfIds(host),['three']);assert.equal(hub.state.detail.id,'three');
 catalog=Promise.reject(Error('offline'));await hub.refreshCatalog();assert.deepEqual(shelfIds(host),['three']);
 catalog=[];await hub.refreshCatalog();assert.deepEqual(shelfIds(host),[]);assert.equal(hub.state.detail,null);hub.dispose();
});

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
test('settings math question is random, whole-number and matches its answer',()=>{
 const {challenge}=require('../runtime/core/hub.js');const ops=new Set();
 for(let i=0;i<2000;i++){
  const {text,answer}=challenge(),[,a,op,b]=text.match(/^What's (\d+) ([+−×]) (\d+)\?$/);ops.add(op);
  const value=op==='+'?+a + +b:op==='−'?a-b:a*b;assert.equal(answer,String(value));assert.ok(value>=0&&answer.length<=3);
 }
 assert.deepEqual([...ops].sort(),['+','×','−'].sort());
});
test('options contain adult setup but no manual touch controls',()=>{
 const source=require('node:fs').readFileSync('runtime/core/hub.js','utf8');
 assert.match(source,/Adult keyboard setup/);assert.doesNotMatch(source,/touch-settings|data-mode|Automatic touch controls|Show touch controls|Hide touch controls/);
});

// Small DOM adapter for exercising the mounted hub without a browser dependency.
function mountedHub(games,catalog=[],capabilities={}){
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
  click(){for(const fn of this.listeners.click||[])fn();}
  insertAdjacentHTML(){}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  play(){this.playCount=(this.playCount||0)+1;return Promise.resolve();}pause(){this.pauseCount=(this.pauseCount||0)+1;}load(){}
 }
 const doc={createElement:tag=>new Element(tag),activeElement:null};
 const platform={capabilities,library:async()=>games,catalog:async()=>catalog,install:async()=>{},onInstallState:fn=>{onInstall=fn;},installStatus:async()=>({})};
 const windowListeners=new Map();
 doc.defaultView={localStorage:{getItem:()=>null},HandheldPreferences:{preferences:{subscribe:()=>()=>{},get:()=>({touchOverlay:'auto'})}},HandheldPlatform:{createPlatform:()=>platform},HandheldInput:{createInput:options=>(onAction=options.onAction,{dispose(){}})},
 addEventListener(type,listener){if(!windowListeners.has(type))windowListeners.set(type,new Set());windowListeners.get(type).add(listener);},
 removeEventListener(type,listener){windowListeners.get(type)?.delete(listener);},listenerCount:()=>[...windowListeners.values()].reduce((count,set)=>count+set.size,0),fetch:()=>Promise.resolve(),location:{}};
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

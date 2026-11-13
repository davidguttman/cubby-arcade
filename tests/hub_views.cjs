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
function mountedHub(games,catalog=[],capabilities={},overrides={},windowOverrides={},mediaOverrides={},geometry=null){
 let onInstall,onAction,revision=0;
 const work={queries:0,layout:0,htmlReads:0,copyWrites:0,selectionWrites:0};
 class Element{
  constructor(tag='div'){if(tag==='video')Object.assign(this,mediaOverrides);this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.hidden=false;this.listeners={};this.style={setProperty(){},removeProperty(){}};this.className='';this.ownerDocument=doc;this.classList={contains:n=>this.className.split(' ').includes(n),add:n=>{if(!this.classList.contains(n))this.className+=' '+n;},remove:n=>{this.className=this.className.split(' ').filter(x=>x!==n).join(' ');},toggle:(n,on)=>{if(n==='is-selected'||n==='is-copy-selected')work.selectionWrites++;on??=!this.classList.contains(n);this.classList[on?'add':'remove'](n);}};}
  appendChild(e){if(e.tagName==='#fragment'){for(const child of [...e.children])this.appendChild(child);return e;}this.children.push(e);e.parent=this;return e;}
  insertBefore(e,before){const nodes=e.tagName==='#fragment'?[...e.children]:[e],index=this.children.indexOf(before);this.children.splice(index,0,...nodes);for(const node of nodes)node.parent=this;}
  cloneNode(deep){const copy=new Element(this.tagName);copy.className=this.className;copy.attributes={...this.attributes};copy.dataset={...this.dataset};copy._html=this._html;if(deep)for(const child of this.children)copy.appendChild(child.cloneNode(true));return copy;}
  get clientWidth(){work.layout++;return geometry&&this.classList.contains('shelf')?geometry.width:0;}
  get offsetWidth(){work.layout++;return geometry&&(this.classList.contains('game-card')||this.classList.contains('shelf-copy'))?geometry.cardWidth:0;}
  get offsetLeft(){work.layout++;if(!geometry||!this.parent)return 0;const siblings=this.parent.children.filter(e=>e.classList.contains('game-card')||e.classList.contains('shelf-copy'));return geometry.padding+siblings.indexOf(this)*(geometry.cardWidth+geometry.gap);}
  replaceChildren(...nodes){if(this.classList.contains('shelf-copy'))work.copyWrites++;this.children=[];nodes.forEach(n=>this.appendChild(n));}
  set innerHTML(value){this._html=value;this.replaceChildren();if(value.includes('class="topbar"'))for(const cls of ['brand','view-nav','view-body','hero-backdrop','hero-rest','shelf','detail','options-panel','adult-setup','hud']){const e=this.appendChild(new Element(cls==='adult-setup'?'dialog':'div'));e.className=cls;if(cls==='detail')e.hidden=true;if(cls==='hero-rest')e.appendChild(new Element('img'));}}
  get innerHTML(){work.htmlReads++;return this._html||'';}
  set src(value){this.setAttribute('src',value);}
  get src(){return this.attributes.src;}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  removeAttribute(k){delete this.attributes[k];}
  addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
  removeEventListener(k,f){this.listeners[k]=(this.listeners[k]||[]).filter(fn=>fn!==f);}
  matches(selector){return selector.split(',').some(s=>{s=s.trim();if(s.includes(' ')){const parts=s.split(/\s+/),last=parts.pop();return this.matches(last)&&!!this.parent?.closest(parts.join(' '));}const data=s.match(/\[data-game-id="([^"]+)"\]/);if(data)return this.dataset.gameId===data[1];const cls=s.match(/\.([\w-]+)/);return (!cls||this.classList.contains(cls[1]))&&(!s.startsWith('dialog')||this.tagName==='dialog')&&(!s.startsWith('button')||this.tagName==='button')&&(!s.startsWith('video')||this.tagName==='video')&&(!s.startsWith('img')||this.tagName==='img')&&(!s.includes(':not(:disabled)')||!this.disabled);});}
  querySelectorAll(selector){work.queries++;if(selector==='.hero-rest img')return this.querySelector('.hero-rest')?.querySelectorAll('img')||[];return this.children.flatMap(e=>[...(e.matches(selector)?[e]:[]),...e.querySelectorAll(selector)]);}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  getBoundingClientRect(){work.layout++;const width=this.clientWidth||this.offsetWidth,left=this.offsetLeft-(this.parent?.scrollLeft||0);return {left,top:0,width,height:0,right:left+width};}
  closest(s){for(let e=this;e;e=e.parent)if(s==='[hidden]'?e.hidden:s==='dialog'?e.tagName==='dialog':e.matches(s))return e;return null;}
  focus(){doc.activeElement=this;for(const fn of this.listeners.focus||[])fn();let e=this.parent;while(e){for(const fn of e.listeners.focusin||[])fn();e=e.parent;}}
  showModal(){this.open=true;}close(){this.open=false;}
  click(){if(this.disabled)return;for(const fn of this.listeners.click||[])fn();}
  dispatchEvent(event){for(const fn of this.listeners[event.type]||[])fn(event);return true;}
  insertAdjacentHTML(){}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  play(){this.playCount=(this.playCount||0)+1;return Promise.resolve();}pause(){this.pauseCount=(this.pauseCount||0)+1;}load(){this.loadCount=(this.loadCount||0)+1;}
 }
 const doc={createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('#fragment'),activeElement:null};
 const platform={capabilities,library:async()=>games,catalog:async()=>catalog,install:async()=>{},onInstallState:fn=>{onInstall=fn;},installStatus:async()=>({}),...overrides};
 const windowListeners=new Map();
 doc.defaultView={localStorage:{getItem:()=>null},HandheldPreferences:{preferences:{subscribe:()=>()=>{},get:()=>({touchOverlay:'auto'})}},HandheldPlatform:{createPlatform:()=>platform},HandheldInput:{createInput:options=>(onAction=options.onAction,{dispose(){}})},
 getComputedStyle:()=>({paddingLeft:String(geometry?.padding||0),paddingRight:String(geometry?.padding||0)}),
 addEventListener(type,listener){if(!windowListeners.has(type))windowListeners.set(type,new Set());windowListeners.get(type).add(listener);},
 removeEventListener(type,listener){windowListeners.get(type)?.delete(listener);},fire(type){for(const fn of windowListeners.get(type)||[])fn();},listenerCount:()=>[...windowListeners.values()].reduce((count,set)=>count+set.size,0),fetch:()=>Promise.resolve(),location:{},setTimeout:()=>0,clearTimeout(){},...windowOverrides};
 const host=new Element(),hub=Hub.mount(host);
 return {host,hub,work,action:(action,source)=>onAction({action,source}),refresh:entries=>{games=entries;onInstall({refresh:{phase:'installed',version:++revision}});}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const games=[{id:'one',artwork:'one.svg',entrypoint:'/one'},{id:'two',artwork:'two.svg',entrypoint:'/two'}];
test('device uses small artwork and deferred trailer, falling back only once',async()=>{
 const clock=devicePreviewClock(),game={id:'small',entrypoint:'/small',artwork:'original.png',attract:'original.webm',media:{thumbnail:{url:'thumb.jpg'},artwork:{url:'hero.jpg'},attract:{url:'clip.mp4'}}};
 const {host}=mountedHub([game],[],{}, {},clock.window);await settle();
 const card=host.querySelector('.game-card img'),poster=host.querySelector('.preview-poster'),video=host.querySelector('video');
 assert.equal(host.querySelector('.game-card').querySelector('img').src,'thumb.jpg');
 assert.equal(poster.src,'hero.jpg');assert.equal(video.poster,'hero.jpg');assert.equal(video.src,undefined);
 clock.run();assert.equal(video.src,'clip.mp4');
 poster.dispatchEvent({type:'error'});assert.equal(poster.src,'original.png');
 poster.dispatchEvent({type:'error'});assert.equal(poster.src,'original.png');
 video.dispatchEvent({type:'error'});assert.equal(video.src,'original.webm');
 video.dispatchEvent({type:'error'});assert.equal(host.querySelector('video'),null);
});
test('desktop keeps original artwork and trailers when device derivatives exist',async()=>{
 const game={id:'small',entrypoint:'/small',artwork:'original.png',attract:'original.webm',media:{thumbnail:{url:'thumb.jpg'},artwork:{url:'hero.jpg'},attract:{url:'clip.mp4'}}};
 const {host}=mountedHub([game]);await settle();
 assert.equal(host.querySelector('.game-card').querySelector('img').src,'original.png');
 assert.equal(host.querySelector('video').src,'original.webm');
});
test('new catalog media upgrades Library pictures without replacing its playing trailer or focus',async()=>{
 const clock=devicePreviewClock(),original={...games[0],attract:'original.webm'};
 let current=[original],offers=[];
 const {host,hub}=mountedHub(current,[],{}, {library:async()=>current,catalog:async()=>offers},clock.window);await settle();clock.run();
 const video=host.querySelector('video'),card=host.querySelector('.game-card');card.focus();
 current=[{...original,media:{thumbnail:{url:'thumb.jpg'},artwork:{url:'hero.jpg'},attract:{url:'clip.mp4'}}}];offers=current;
 await hub.refreshCatalog();
 assert.equal(host.querySelector('video'),video);assert.equal(video.src,'original.webm');assert.equal(video.playCount,1);
 assert.equal(host.ownerDocument.activeElement,card);assert.equal(card.querySelector('img').src,'thumb.jpg');assert.equal(host.querySelector('.preview-poster').src,'hero.jpg');
});
test('nonempty Library selects and previews a game on load and return',async()=>{
 const {host,hub}=mountedHub(games);await settle();
 assert.equal(hub.state.detail?.id,'one');assert.equal(host.querySelector('.detail').hidden,false);
 assert.equal(host.querySelectorAll('.is-selected').length,1);
 hub.show('options');hub.show('library');
 assert.equal(hub.state.detail?.id,'one');assert.equal(host.querySelectorAll('.is-selected').length,1);
});
test('Library refresh preserves a selection and falls back when it disappears',async()=>{
 const {host,hub,refresh}=mountedHub(games);await settle();
 host.querySelector('[data-game-id="two"]').focus();refresh([...games,{id:'three',artwork:'three.svg'}]);await settle();
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
test('preview video overlays the in-flow poster inside the stage',()=>{
 const css=require('node:fs').readFileSync('runtime/core/hub.css','utf8');
 assert.match(css,/\.stage \.preview-video\{position:absolute;inset:0\}/);
});
test('video previews keep selected artwork visible until a presented frame, including restarts',async()=>{
 const frames=[];
 const {host}=mountedHub(games.map(game=>({...game,attract:game.id+'.webm'})),[],{},{},{},{requestVideoFrameCallback:fn=>frames.push(fn)});await settle();
 const video=host.querySelector('video'),poster=host.querySelector('.preview-poster');
 assert.ok(poster,'a separate image must cover native video startup');assert.equal(poster.src,'one.svg');assert.equal(video.style.opacity,'0');
 video.readyState=2;video.dispatchEvent({type:'loadeddata'});assert.equal(video.style.opacity,'0','decoded data is not a presented frame');
 video.dispatchEvent({type:'playing'});assert.equal(video.style.opacity,'0');frames.shift()();assert.equal(video.style.opacity,'1');
 video.dispatchEvent({type:'ended'});assert.equal(video.style.opacity,'0');
 video.dispatchEvent({type:'playing'});const stale=frames.shift();video.dispatchEvent({type:'loadstart'});stale();assert.equal(video.style.opacity,'0','obsolete frame callbacks must not uncover a reset video');
 host.querySelector('[data-game-id="two"]').focus();assert.equal(host.querySelector('.preview-poster').src,'two.svg');assert.equal(host.querySelector('video').style.opacity,'0');
});
test('older video engines reveal only on playback and retain artwork on failure',async()=>{
 const frames=[];const {host}=mountedHub([{...games[0],attract:'one.webm'}],[],{},{},{requestAnimationFrame:fn=>frames.push(fn)});await settle();
 const video=host.querySelector('video'),poster=host.querySelector('.preview-poster');assert.ok(poster);assert.equal(video.style.opacity,'0');
 video.readyState=2;video.dispatchEvent({type:'playing'});assert.equal(video.style.opacity,'0');frames.shift()();assert.equal(video.style.opacity,'1');
 video.dispatchEvent({type:'error'});assert.equal(host.querySelector('video'),null);assert.equal(host.querySelector('.preview-poster'),poster);
});
test('rejected preview playback leaves the artwork visible',async()=>{
 const {host}=mountedHub([{...games[0],attract:'one.webm'}],[],{},{},{},{play(){return Promise.reject(new Error('blocked'));}});await settle();
 assert.equal(host.querySelector('.preview-poster')?.src,'one.svg');assert.equal(host.querySelector('video').style.opacity,'0');
});
function devicePreviewClock(){
 let next=0,now=0;const jobs=new Map();
 function advance(ms){const until=now+ms;for(;;){const due=[...jobs].filter(([,job])=>job.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;const [id,job]=due;jobs.delete(id);now=job.at;job.fn();}now=until;}
 return {jobs,advance,window:{CubbyDeviceProfile:'rg353v',AbortController,fetch:()=>new Promise(()=>{}),setTimeout(fn,delay){const id=++next;jobs.set(id,{fn,delay,at:now+delay});return id;},clearTimeout(id){jobs.delete(id);}},run(){advance(280);}};
}
test('selection reuses preview shell, poster and Library actions without stale targets',async()=>{
 const {host,hub}=mountedHub(games,[],{uninstall:true});await settle();
 const stage=host.querySelector('.stage'),close=host.querySelector('.detail-close'),poster=host.querySelector('.preview-media'),actions=host.querySelector('.detail-actions'),star=host.querySelector('.favorite'),play=host.querySelector('.play-game'),remove=host.querySelector('.uninstall-game');
 host.querySelector('[data-game-id="two"]').focus();
 assert.equal(host.querySelector('.stage'),stage);assert.equal(host.querySelector('.detail-close'),close);assert.equal(host.querySelector('.preview-media'),poster);assert.equal(poster.src,'two.svg');
 assert.equal(host.querySelector('.detail-actions'),actions);assert.equal(host.querySelector('.favorite'),star);assert.equal(host.querySelector('.play-game'),play);assert.equal(host.querySelector('.uninstall-game'),remove);
 star.click();assert.equal(hub.state.isFavorite('two'),true);assert.equal(hub.state.isFavorite('one'),false);
 play.click();assert.equal(host.ownerDocument.defaultView.location.href,'/two');
 remove.click();assert.equal(host.querySelector('.uninstall-picture img').src,'two.svg');host.querySelector('.cancel-uninstall').click();
 host.querySelector('[data-game-id="one"]').focus();assert.equal(star.getAttribute('aria-pressed'),'false');star.click();assert.equal(hub.state.isFavorite('one'),true);
});
test('device reuses its poster across video and image selections while retiring each video',async()=>{
 const clock=devicePreviewClock(),entries=[{...games[0],attract:'one.webm'},games[1],{id:'three',artwork:'three.svg',entrypoint:'/three',attract:'three.webm'}];
 const {host}=mountedHub(entries,[],{},{},clock.window);await settle();clock.run();
 const poster=host.querySelector('.preview-poster'),old=host.querySelector('video'),stage=host.querySelector('.stage');
 host.querySelector('[data-game-id="two"]').focus();assert.equal(host.querySelector('.preview-media'),poster);assert.equal(poster.src,'two.svg');assert.equal(host.querySelector('video'),null);assert.equal(old.src,undefined);assert.equal(old.autoplay,false);
 poster.dispatchEvent({type:'error'});assert.equal(old.poster,'one.svg','a reused poster must not mutate a retired video');
 host.querySelector('[data-game-id="three"]').focus();assert.equal(host.querySelector('.stage'),stage);assert.equal(host.querySelector('.preview-poster'),poster);assert.equal(poster.src,'three.svg');
 const video=host.querySelector('video');assert.notEqual(video,old);assert.equal(video.src,undefined);clock.run();assert.equal(video.src,'three.webm');
});
test('Store preview reuses download control and installs only the current offer',async()=>{
 const installed=[],offers=games.map(g=>({...g,manifest_url:'/manifest/'+g.id}));
 const {host,hub}=mountedHub([],offers,{install:true},{install:async id=>{installed.push(id);throw Error('offline');}});await settle();hub.show('store');
 const download=host.querySelector('.download-game'),progress=host.querySelector('.install-progress');
 host.querySelector('[data-game-id="two"]').focus();assert.equal(host.querySelector('.download-game'),download);assert.equal(host.querySelector('.install-progress'),progress);
 download.click();await settle();assert.deepEqual(installed,['two']);
});
test('reused preview clears obsolete download state and never leaks a poster listener',async()=>{
 const clock=devicePreviewClock(),first={...games[0],manifest_url:'/one.json',attract:'one.webm',media:{artwork:{url:'small-one.jpg'}}},second={...games[1],attract:'two.webm',media:{artwork:{url:'small-two.jpg'}}};
 const {host,hub}=mountedHub([],[first,second],{install:true},{},clock.window);await settle();hub.show('store');
 const poster=host.querySelector('.preview-poster'),count=poster.listeners.error.length;
 host.querySelector('[data-game-id="two"]').focus();assert.equal(poster.listeners.error.length,count);assert.equal(host.querySelector('.download-game'),null);assert.equal(host.querySelector('.install-progress'),null);assert.ok(host.querySelector('.not-installed'));
 const video=host.querySelector('video');poster.dispatchEvent({type:'error'});assert.equal(poster.src,'two.svg');assert.equal(video.poster,'two.svg');
 host.querySelector('[data-game-id="one"]').focus();assert.equal(host.querySelector('.not-installed'),null);assert.ok(host.querySelector('.download-game'));assert.equal(poster.listeners.error.length,count);
});
for(const view of ['library','store'])test('device '+view+' selects immediately but starts only the settled trailer',async()=>{
 const clock=devicePreviewClock(),offers=games.map(game=>({...game,attract:game.id+'.webm',manifest_url:'/manifest'}));
 const {host,hub}=mountedHub(view==='library'?offers:[],offers,{install:true}, {},clock.window);await settle();
 const first=host.querySelector('video');assert.equal(first.src,undefined);assert.equal(first.playCount,undefined);
 assert.ok(host.querySelector(view==='library'?'.play-game':'.download-game'));assert.ok(!host.querySelector(view==='library'?'.play-game':'.download-game').disabled);
 host.querySelector('[data-game-id="two"]').focus();
 assert.equal(hub.state.detail.id,'two');assert.equal(host.querySelector('.preview-poster').src,'two.svg');
 const second=host.querySelector('video');assert.equal(second.src,undefined);clock.run();
 assert.equal(first.playCount,undefined);assert.equal(first.src,undefined);assert.equal(first.loadCount,1);assert.equal(second.src,'two.webm');assert.equal(second.playCount,1);hub.dispose();
});
for(const view of ['library','store'])for(const repeat of [190,200])test('held device '+view+' navigation at '+repeat+'ms defers trailers until settled',async()=>{
 const clock=devicePreviewClock(),offers=games.map(game=>({...game,attract:game.id+'.webm',manifest_url:'/manifest'}));
 const {host,hub}=mountedHub(view==='library'?offers:[],offers,{install:true},{},clock.window);await settle();
 const seen=[host.querySelector('video')];
 for(let i=0;i<6;i++){
  clock.advance(repeat);
  assert.ok(seen.every(video=>!video.playCount),'controller repeats must not open intermediate trailers');
  host.querySelector('[data-game-id="'+games[(i+1)%2].id+'"]').focus();seen.push(host.querySelector('video'));
 }
 clock.advance(279);assert.ok(seen.every(video=>!video.playCount));
 clock.advance(1);assert.equal(seen.at(-1).playCount,1);assert.ok(seen.slice(0,-1).every(video=>!video.playCount));hub.dispose();
});
test('device pending trailer is canceled by leaving, blur and disposal and restarts on focus',async()=>{
 const clock=devicePreviewClock(),{host,hub}=mountedHub([{...games[0],attract:'one.webm'}],[],{}, {},clock.window);await settle();
 const win=host.ownerDocument.defaultView,video=host.querySelector('video');
 // Exercise the same lifecycle callbacks a real window dispatches.
 win.fire('blur');clock.run();assert.equal(video.src,undefined);
 win.fire('focus');clock.run();assert.equal(video.src,'one.webm');
 hub.show('store');hub.show('library');const next=host.querySelector('video');hub.dispose();clock.run();assert.equal(next.src,undefined);
});
test('leaving device discovery cancels an unloaded trailer and desktop remains immediate',async()=>{
 const clock=devicePreviewClock(),{host,hub}=mountedHub([{...games[0],attract:'one.webm'}],[],{}, {},clock.window);await settle();
 const video=host.querySelector('video');hub.show('options');clock.run();assert.equal(video.src,undefined);assert.equal(video.playCount,undefined);assert.equal(video.loadCount,1);hub.dispose();
 const desktop=mountedHub([{...games[0],attract:'one.webm'}]);await settle();assert.equal(desktop.host.querySelector('video').src,'one.webm');assert.equal(desktop.host.querySelector('video').playCount,1);desktop.hub.dispose();
});
test('discarding a started preview releases its source when switching views and disposing',async()=>{
 const {host,hub}=mountedHub([{...games[0],attract:'one.webm'}]);await settle();
 const video=host.querySelector('video');hub.show('options');assert.equal(video.src,undefined);assert.equal(video.loadCount,1);
 hub.show('library');const next=host.querySelector('video');assert.equal(next.src,'one.webm');hub.dispose();assert.equal(next.src,undefined);assert.equal(next.loadCount,1);
 next.dispatchEvent({type:'ended'});assert.equal(next.playCount,1,'detached video events cannot restart playback');
});
test('scrolling beneath a stationary pointer cannot replace the controller selection',async()=>{
 const {host,hub}=mountedHub(games);await settle();
 const one=host.querySelector('[data-game-id="one"]'),two=host.querySelector('[data-game-id="two"]');
 two.focus();one.dispatchEvent({type:'pointerenter',pointerType:'mouse'});
 assert.equal(hub.state.detail.id,'two','layout-induced pointer entry is not a game selection');
 one.dispatchEvent({type:'pointermove',pointerType:'touch'});assert.equal(hub.state.detail.id,'two');
 one.dispatchEvent({type:'pointermove',pointerType:'mouse'});assert.equal(hub.state.detail.id,'one','actual mouse movement still previews a game');
});
for(const device of [false,true])test('retired videos release their decoder and cannot restart or reveal on delayed events; device='+device,async()=>{
 const frames=[],cancelled=[],clock=device?devicePreviewClock():null;
 const {host,hub}=mountedHub(games.map(game=>({...game,attract:game.id+'.webm'})),[],{},{},clock?.window||{},{requestVideoFrameCallback:fn=>(frames.push(fn),frames.length),cancelVideoFrameCallback:id=>cancelled.push(id)});await settle();clock?.run();
 const old=host.querySelector('video');old.readyState=2;old.dispatchEvent({type:'playing'});
 const lateFrame=frames[0],plays=old.playCount;
 host.querySelector('[data-game-id="two"]').focus();
 assert.equal(old.loadCount,1,'retiring must reset the media resource, not only pause');
 assert.deepEqual(cancelled,[1]);
 old.dispatchEvent({type:'ended'});old.dispatchEvent({type:'playing'});lateFrame();
 assert.equal(old.playCount,plays,'a queued end event must never restart a retired trailer');
 assert.equal(old.style.opacity,'0','a queued frame must never reveal a retired trailer');
 assert.equal(host.querySelector('.preview-poster').src,'two.svg');
 if(device){assert.equal(host.querySelector('video').src,undefined);clock.run();}
 assert.equal(host.querySelector('video').src,'two.webm');
 const current=host.querySelector('video');hub.show('options');
 assert.equal(current.loadCount,1,'leaving the library releases its decoder too');
 hub.dispose();
});
test('empty Library remains an empty pictorial state',async()=>{
 const {host,hub}=mountedHub([]);await settle();hub.show('library');
 assert.equal(hub.state.detail,null);assert.equal(host.querySelector('.detail').hidden,true);assert.equal(host.querySelectorAll('.game-card').length,0);
});
test('mounted hub disposal removes its window lifecycle listeners and is idempotent',async()=>{
 const {host,hub}=mountedHub(games);await settle();
 const win=host.ownerDocument.defaultView;
 assert.equal(win.listenerCount(),5);
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
function loopShelf(count=24,library=null,windowOverrides={}){
 const entries=Array.from({length:count},(_,i)=>({id:'game-'+i,artwork:i+'.svg',entrypoint:'/'+i,manifest_url:'/manifest/'+i}));
 const geometry={width:480,cardWidth:100,gap:20,padding:16};
 return {...mountedHub(library||entries,entries,{install:true},{},windowOverrides,{},geometry),geometry,entries};
}
test('selection navigation changes only old/new cards and copies without shelf scans or layout',async()=>{
 const {host,hub,action,work}=loopShelf();await settle();
 const cards=host.querySelectorAll('.game-card'),copies=host.querySelectorAll('.shelf-copy');cards[0].focus();
 const before={...work};action('right');const delta=Object.fromEntries(Object.keys(work).map(key=>[key,work[key]-before[key]]));
 assert.equal(hub.state.detail.id,'game-1');assert.equal(host.ownerDocument.activeElement,cards[1]);
 assert.equal(delta.layout,0,'steady selection uses cached geometry');assert.equal(delta.htmlReads,0,'selection never serializes shelf markup');
 assert.equal(delta.copyWrites,0,'selection does not replace copy contents');assert.ok(delta.selectionWrites<=6,JSON.stringify(delta));
 // No shelf-wide query is allowed; detail/ancestor work stays constant as the shelf grows.
 assert.ok(delta.queries<100,JSON.stringify(delta));
 assert.deepEqual(cards.filter(card=>card.classList.contains('is-selected')),[cards[1]]);
 assert.equal(copies.filter(copy=>copy.classList.contains('is-copy-selected')).length,2);hub.dispose();
});
test('a fitting shelf keeps its nonwrapping ends and cached selection geometry',async()=>{
 const {host,hub,action,work}=loopShelf(2);await settle();const cards=host.querySelectorAll('.game-card');
 assert.equal(host.querySelectorAll('.shelf-copy').length,0);cards[0].focus();action('left');assert.equal(host.ownerDocument.activeElement,cards[0]);
 const before=work.layout;action('right');assert.equal(host.ownerDocument.activeElement,cards[1]);assert.equal(work.layout,before);action('right');assert.equal(host.ownerDocument.activeElement,cards[1]);hub.dispose();
});
test('native circular scroll and controller wrap keep the selection with fresh geometry after resize and rebuild',async()=>{
 const {host,hub,action,work,geometry,entries,refresh}=loopShelf(8);await settle();
 const shelf=host.querySelector('.shelf'),cards=host.querySelectorAll('.game-card');cards[0].focus();action('left');
 assert.equal(hub.state.detail.id,'game-7');assert.equal(host.ownerDocument.activeElement,cards[7]);action('right');assert.equal(hub.state.detail.id,'game-0');
 const centered=shelf.scrollLeft,cycle=8*120;shelf.scrollLeft=centered+cycle*3;shelf.dispatchEvent({type:'scroll'});assert.equal(shelf.scrollLeft,centered);
 const before=work.layout;shelf.scrollLeft=centered-cycle*2;shelf.dispatchEvent({type:'scroll'});assert.equal(shelf.scrollLeft,centered);assert.equal(work.layout,before,'scroll normalization reads no geometry');
 geometry.width=600;geometry.cardWidth=130;host.ownerDocument.defaultView.fire('resize');const resized=shelf.scrollLeft;assert.notEqual(resized,centered);
 action('right');action('left');assert.equal(shelf.scrollLeft,resized,'selection uses new resize geometry');
 refresh(entries.slice(0,2));await settle();assert.equal(host.querySelectorAll('.shelf-copy').length,0);assert.equal(hub.state.detail.id,'game-0');hub.dispose();
});
test('container/card resize observation invalidates geometry and disconnects on disposal',async()=>{
 let observer;class ResizeObserver{constructor(callback){this.callback=callback;this.nodes=new Set();observer=this;}observe(node){this.nodes.add(node);}disconnect(){this.nodes.clear();}}
 const {host,hub,action,geometry}=loopShelf(8,null,{ResizeObserver});await settle();
 const shelf=host.querySelector('.shelf'),cards=host.querySelectorAll('.game-card');assert.ok(observer.nodes.has(shelf));assert.ok(cards.every(card=>observer.nodes.has(card)));
 const previous=shelf.scrollLeft;geometry.cardWidth=140;geometry.width=530;observer.callback();const next=shelf.scrollLeft;assert.notEqual(next,previous);
 action('right');action('left');assert.equal(shelf.scrollLeft,next);hub.dispose();assert.equal(observer.nodes.size,0);
 observer.callback();assert.equal(host.querySelectorAll('.shelf-copy').length,16,'queued resize after disposal does no work');
});
test('updated device artwork reaches circular copies and their pointer/click controls use the refreshed game',async()=>{
 const entries=Array.from({length:8},(_,i)=>({id:'game-'+i,artwork:i+'.svg',entrypoint:'/'+i})),clock=devicePreviewClock(),geometry={width:480,cardWidth:100,gap:20,padding:16};let current=entries;
 const {host,hub}=mountedHub(entries,[],{},{library:async()=>current,catalog:async()=>current},clock.window,{},geometry);await settle();
 const copies=host.querySelectorAll('.shelf-copy'),second=copies.find(copy=>copy.dataset.gameId==='game-1'),unrelated=copies.find(copy=>copy.dataset.gameId==='game-2').querySelector('img');
 current=entries.map((game,i)=>i===1?{...game,media:{thumbnail:{url:'thumb.jpg'},artwork:{url:'hero.jpg'}}}:game);await hub.refreshCatalog();
 for(const copy of copies.filter(copy=>copy.dataset.gameId==='game-1'))assert.equal(copy.querySelector('img').src,'thumb.jpg');
 assert.equal(copies.find(copy=>copy.dataset.gameId==='game-2').querySelector('img'),unrelated);
 second.dispatchEvent({type:'pointermove',pointerType:'touch'});assert.equal(hub.state.detail.id,'game-0');
 const shelf=host.querySelector('.shelf'),scroll=shelf.scrollLeft;second.dispatchEvent({type:'pointermove',pointerType:'mouse'});assert.equal(hub.state.detail.id,'game-1');assert.equal(shelf.scrollLeft,scroll,'hover does not recenter native scrolling');
 assert.equal(host.querySelector('.preview-media').src,'hero.jpg');second.click();assert.equal(host.ownerDocument.activeElement,host.querySelectorAll('.game-card')[1]);hub.dispose();
});
test('favorites and ownership update circular copies without replacing unrelated contents',async()=>{
 const {host,hub,action,refresh,entries}=loopShelf(8,[]);await settle();
 const cards=host.querySelectorAll('.game-card'),copies=host.querySelectorAll('.shelf-copy'),unrelated=copies.find(copy=>copy.dataset.gameId==='game-2').querySelector('img');
 host.querySelector('.favorite').click();
 for(const copy of copies.filter(copy=>copy.dataset.gameId==='game-0'))assert.equal(copy.querySelector('.card-badge').dataset.kind,'favorite');
 assert.equal(copies.find(copy=>copy.dataset.gameId==='game-2').querySelector('img'),unrelated);
 cards[1].focus();refresh([entries[0]]);await settle();
 for(const copy of host.querySelectorAll('.shelf-copy').filter(copy=>copy.dataset.gameId==='game-0')){assert.ok(copy.classList.contains('is-owned'));assert.equal(copy.querySelector('.card-badge').dataset.kind,'installed');assert.equal(copy.getAttribute('aria-hidden'),'true');}
 assert.equal(cards[0].getAttribute('aria-label'),'In library');assert.equal(hub.state.detail.id,'game-1');action('left');assert.equal(hub.state.detail.id,'game-7','updated navigation index skips the newly owned game');hub.dispose();
});
const shelfIds=host=>host.querySelectorAll('.game-card').map(card=>card.dataset.gameId);
const offers=games.map(game=>({...game,manifest_url:'/manifest'}));
for(const view of ['library','store'])for(const control of ['click','confirm','pause'])test(view+' tab '+control+' hands focus to the bottom game card',async()=>{
 let installed;const {host,hub,action}=mountedHub(games,offers.map(g=>({...g,id:'offer-'+g.id})),{install:true},{install:async id=>{installed=id;}});await settle();
 const tab=host.querySelectorAll('.view-tab').find(t=>t.getAttribute('aria-label')===view);tab.focus();
 if(control==='click')tab.click();else action(control);
 const primary=host.querySelector(view==='library'?'.play-game':'.download-game');
 assert.equal(host.ownerDocument.activeElement,host.querySelector('.is-selected'));
 action('confirm');assert.equal(host.ownerDocument.activeElement,primary);
 action('confirm');await settle();
 if(view==='library')assert.equal(host.ownerDocument.defaultView.location.href,games[0].entrypoint);else assert.equal(installed,'offer-one');
 assert.equal(hub.state.view,view);
});
test('view cycling enters content, including the first options control',async()=>{
 const {host,hub,action}=mountedHub(games,[{...offers[0],id:'offer'}],{install:true});await settle();
 action('nextView');assert.equal(hub.state.view,'store');assert.equal(host.ownerDocument.activeElement,host.querySelector('.is-selected'));
 action('select');assert.equal(hub.state.view,'options');assert.equal(host.ownerDocument.activeElement,host.querySelector('.options-panel').querySelector('button'));
 action('previousView');assert.equal(host.ownerDocument.activeElement,host.querySelector('.is-selected'));
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
test('power tile opens submenu; confirms each action before executing; reports failure',async()=>{
 let calls=[],fail=false,expired=null;const settings=[{icon:'trash',label:'Game saves',href:'#adult-saves'}];
 const {host,hub,action}=mountedHub(games,[],{power:true},{settings,power:async mode=>{calls.push(mode);if(fail)throw Error('busy');}},{setTimeout:fn=>{expired=fn;return 1;}});await settle();hub.show('options');
 assert.equal(host.querySelector('.power-menu'),null);passGate(host);
 const powerTile=host.querySelector('.power-menu'),dialog=host.querySelector('.quit-confirm');
 // Open power menu, cancel
 powerTile.click();assert.equal(dialog.open,true);assert.equal(dialog.getAttribute('aria-label'),'Power');assert.equal(host.ownerDocument.activeElement,host.querySelector('.cancel-quit'));
 action('back');assert.equal(dialog.open,false);assert.equal(host.ownerDocument.activeElement,powerTile);assert.deepEqual(calls,[]);
 // Open menu → choose Power off → cancel from confirmation
 powerTile.click();host.querySelector('.power-off').click();
 assert.equal(dialog.open,true);assert.equal(dialog.getAttribute('aria-label'),'Power off?');assert.deepEqual(calls,[]);assert.equal(host.ownerDocument.activeElement,host.querySelector('.cancel-quit'));
 action('back');assert.equal(dialog.open,false);assert.equal(host.ownerDocument.activeElement,powerTile);assert.deepEqual(calls,[]);
 // Open menu → choose Restart → confirm
 powerTile.click();host.querySelector('.power-restart').click();assert.equal(dialog.getAttribute('aria-label'),'Restart?');action('right');action('confirm');await settle();assert.deepEqual(calls,['reboot']);
 assert.equal(host.querySelector('.power-note').textContent,'Restarting…');assert.ok(host.querySelector('.confirm-quit').disabled);action('back');assert.equal(dialog.open,true,'Cannot back out of a shutdown');
 expired();assert.match(host.querySelector('.power-note').textContent,/Could not restart/);assert.equal(host.querySelector('.confirm-quit').disabled,false);
 action('back');assert.equal(dialog.open,false);assert.equal(host.ownerDocument.activeElement,powerTile);
 // Fail path: power off
 fail=true;powerTile.click();host.querySelector('.power-off').click();host.querySelector('.confirm-quit').click();await settle();assert.deepEqual(calls,['reboot','poweroff']);assert.match(host.querySelector('.power-note').textContent,/Could not power off/);assert.equal(host.ownerDocument.activeElement,host.querySelector('.cancel-quit'));
});
test('hosts without power control show no power tile',async()=>{
 const {host,hub}=mountedHub(games,[],{},{settings:[{icon:'trash',label:'Game saves',href:'#adult-saves'}]});await settle();hub.show('options');passGate(host);
 assert.equal(host.querySelector('.power-menu'),null);
});
test('tab activation never focuses a disabled Play action',async()=>{
 const {host}=mountedHub(games,[],{tokens:true},{account:async()=>({available:true,balance:0})});await settle();
 const tab=host.querySelectorAll('.view-tab')[0];tab.focus();tab.click();
 assert.equal(host.querySelector('.play-game').disabled,true);
 assert.equal(host.ownerDocument.activeElement,host.querySelector('.is-selected'));
});
test('activating a loading tab transfers focus only if the user stayed on that tab',async()=>{
 for(const moveAway of [false,true]){
  let resolve;const {host}=mountedHub(games,new Promise(r=>{resolve=r;}),{install:true});await settle();
  const tabs=host.querySelectorAll('.view-tab');tabs[1].focus();tabs[1].click();assert.equal(host.ownerDocument.activeElement,tabs[1]);
  if(moveAway)tabs[2].focus();resolve([{...offers[0],id:'offer'}]);await settle();
  assert.equal(host.ownerDocument.activeElement,moveAway?tabs[2]:host.querySelector('.is-selected'));
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
test('finished Store download hands off to Library game row',async()=>{
 const {host,hub,refresh}=mountedHub([],offers,{install:true});await settle();
 host.querySelector('[data-game-id="two"]').click();host.querySelector('.download-game').click();
 refresh([games[1]]);await settle();
 assert.equal(hub.state.view,'library');assert.equal(hub.state.detail.id,'two');
 assert.equal(host.ownerDocument.activeElement,host.querySelector('.is-selected'));
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
test('controller setup is adult-gated and runs from the pad alone: A, B, X, Y, auto-save, close',async()=>{
 const buttons=Array.from({length:17},()=>({pressed:false,value:0})),pad={id:'Steam Xbox controller',index:0,mapping:'standard',buttons,axes:[0,0]};
 const saved=new Map(),storage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)};
 let time=0,timers=[];const setTimeout=(fn,ms)=>timers.push({fn,ms})-1,clearTimeout=id=>{if(timers[id])timers[id].fn=null;};
 const fire=ms=>{for(const timer of timers.splice(0))if(timer.fn&&timer.ms===ms)timer.fn();else timers.push(timer);};
 const calibration=require('../runtime/core/host-osd.js').createCalibration(()=>[pad],storage,()=>time);
 const {host,hub,action}=mountedHub(games,[],{},{},{HandheldOSD:{calibration,reset(){}},setTimeout,clearTimeout});await settle();hub.show('options');
 assert.equal(host.querySelector('.controller-settings'),null);passGate(host);
 const press=(...indices)=>{buttons.forEach((b,n)=>{b.pressed=indices.includes(n);b.value=b.pressed?1:0;});return calibration.getGamepads();};
 const dialog=host.querySelector('.controller-setup'),prompt=()=>dialog.querySelector('.calibration-prompt'),lit=()=>dialog.querySelectorAll('.calibration-glyph').filter(g=>g.classList.contains('is-set')).map(g=>g.textContent).join('');
 // Chosen with the pad's own A: setup opens straight into capture, with no choices to make.
 press(0);host.querySelector('.controller-settings').click();
 assert.equal(dialog.open,true);assert.equal(prompt().textContent,'A');assert.equal(prompt().getAttribute('aria-label'),'Press A');
 const tags=node=>[node.tagName,...node.children.flatMap(tags)];assert.deepEqual(tags(dialog).filter(t=>['button','select','input','label'].includes(t)),['button']);assert.equal(dialog.querySelector('button').className,'cancel-controller');
 assert.equal(press(0)[0].buttons.some(b=>b.pressed),false);assert.equal(prompt().classList.contains('waiting'),true,'the opening press is still held');
 const focused=host.ownerDocument.activeElement;action('right','gamepad');action('confirm','gamepad');action('previousView','gamepad');assert.equal(host.ownerDocument.activeElement,focused);assert.equal(hub.state.view,'options');
 press();assert.equal(prompt().classList.contains('waiting'),false);press(1);press();
 assert.equal(prompt().textContent,'B');assert.equal(lit(),'A');
 press(1);assert.equal(prompt().classList.contains('rejected'),true,'duplicate shows a cue');fire(400);assert.equal(prompt().classList.contains('rejected'),false);
 press();press(0);press();press(3);assert.equal(lit(),'ABX');press();
 press(2);assert.equal(lit(),'ABXY');assert.equal(prompt().classList.contains('done'),true);assert.equal(dialog.open,true,'confirmation stays briefly');
 assert.deepEqual(JSON.parse(saved.get('cubby:controller-labels:v1')),{[JSON.stringify([pad.id,'standard',17,2])]:[1,0,3,2]});
 fire(1000);assert.equal(dialog.open,false);assert.equal(host.ownerDocument.activeElement,host.querySelector('.controller-settings'));
 assert.equal(press(2)[0].buttons.some(b=>b.pressed),false,'the final press drains');press();assert.equal(press(1)[0].buttons[0].pressed,true);
 // Start exits unchanged; so does ten seconds idle; the same A, B, X, Y as the defaults resets.
 press();host.querySelector('.controller-settings').click();press();press(9);assert.equal(dialog.open,false);assert.equal(press(9)[0].buttons.some(b=>b.pressed),false);
 press();host.querySelector('.controller-settings').click();press();press(0);time+=10000;press();assert.equal(dialog.open,false);assert.equal(saved.size,1);
 press();host.querySelector('.controller-settings').click();for(const i of [0,1,2,3]){press();press(i);}fire(1000);assert.equal(dialog.open,false);
 assert.deepEqual(JSON.parse(saved.get('cubby:controller-labels:v1')),{});press();assert.equal(press(1)[0].buttons[1].pressed,true);
 // Desktop extras: Escape (dialog cancel) and the close button.
 host.querySelector('.controller-settings').click();press();press(1);dialog.listeners.cancel[0]({preventDefault(){}});assert.equal(dialog.open,false);
 press();host.querySelector('.controller-settings').click();dialog.querySelector('.cancel-controller').click();assert.equal(dialog.open,false);assert.equal(calibration.isBlocking(),true);press();assert.equal(calibration.isBlocking(),false);
 hub.show('library');hub.show('options');assert.equal(host.querySelector('.controller-settings'),null);hub.dispose();
});
test('controller setup never asks for a mouse, touch, or keyboard',()=>{
 const source=require('node:fs').readFileSync('runtime/core/hub.js','utf8');
 assert.doesNotMatch(source,/Use a mouse|controller-choice|start-calibration|save-controller|reset-controller|refresh-controllers/);
});
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

for(const library of [games,[]])test('initial discovery focuses the enabled bottom card in '+(library.length?'Library':'Store'),async()=>{
 const {host,hub}=mountedHub(library,offers,{install:true});await settle();
 assert.equal(hub.state.view,library.length?'library':'store');
 assert.equal(host.ownerDocument.activeElement,host.querySelector('.is-selected'));
 assert.equal(host.ownerDocument.activeElement.disabled,false);
});
test('launch and fresh hub return restore the launched game on the bottom row',async()=>{
 const values=new Map(),sessionStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 const first=mountedHub(games,[],{},{},{sessionStorage});await settle();
 first.host.querySelector('[data-game-id="two"]').focus();first.host.querySelector('.play-game').click();
 assert.equal(first.host.ownerDocument.defaultView.location.href,'/two');first.hub.dispose();
 const second=mountedHub(games,[],{},{},{sessionStorage});await settle();
 assert.equal(second.hub.state.detail.id,'two');assert.equal(second.host.ownerDocument.activeElement,second.host.querySelector('[data-game-id="two"]'));
});
test('same-document native launch settles on the shelf without stealing later deliberate focus',async()=>{
 for(const moveAway of [false,true]){
  let complete;const {host}=mountedHub(games,[],{tokens:true},{account:async()=>({available:true,balance:2}),launch:()=>new Promise(resolve=>{complete=resolve;})});await settle();
  const play=host.querySelector('.play-game');play.focus();play.click();
  if(moveAway)host.querySelector('.favorite').focus();complete();await settle();
  assert.equal(host.ownerDocument.activeElement,host.querySelector(moveAway?'.favorite':'.is-selected'));
 }
});
test('initial discovery does not steal deliberate focus while loading',async()=>{
 let resolve;const {host}=mountedHub(new Promise(r=>{resolve=r;}));
 const settings=host.querySelectorAll('.view-tab')[2];settings.focus();resolve(games);await settle();
 assert.equal(host.ownerDocument.activeElement,settings);
});
test('initial load failure keeps the active tab usable',async()=>{
 const {host}=mountedHub([],[],{},{library:async()=>{throw Error('offline');}});await settle();
 assert.equal(host.ownerDocument.activeElement,host.querySelectorAll('.view-tab')[0]);
});

test('late Library ownership discovery moves focus to the next enabled Store card',async()=>{
 let resolve;const {host}=mountedHub(new Promise(r=>{resolve=r;}),offers,{install:true});await settle();
 host.querySelectorAll('.view-tab')[1].click();assert.equal(host.ownerDocument.activeElement.dataset.gameId,'one');
 resolve([games[0]]);await settle();
 assert.equal(host.ownerDocument.activeElement,host.querySelector('[data-game-id="two"]'));assert.equal(host.ownerDocument.activeElement.disabled,false);
});
test('a removed focused Library selection falls back to the remaining game row',async()=>{
 const {host,refresh}=mountedHub(games);await settle();host.querySelector('[data-game-id="two"]').focus();
 refresh([games[0]]);await settle();assert.equal(host.ownerDocument.activeElement,host.querySelector('[data-game-id="one"]'));
 refresh([]);await settle();assert.equal(host.ownerDocument.activeElement,host.querySelectorAll('.view-tab')[0]);
});

test('reactivating Store keeps its selected offer focused on the bottom row',async()=>{
 const {host}=mountedHub([],offers,{install:true});await settle();host.querySelector('[data-game-id="two"]').focus();
 host.querySelectorAll('.view-tab')[1].click();assert.equal(host.ownerDocument.activeElement,host.querySelector('[data-game-id="two"]'));
});
for(const catalogFirst of [false,true])test('empty Library fallback focuses Store regardless of discovery order '+catalogFirst,async()=>{
 let resolveLibrary,resolveCatalog;const {host}=mountedHub(new Promise(r=>{resolveLibrary=r;}),new Promise(r=>{resolveCatalog=r;}),{install:true});
 if(catalogFirst){resolveCatalog(offers);await settle();resolveLibrary([]);}else{resolveLibrary([]);await settle();resolveCatalog(offers);}
 await settle();assert.equal(host.ownerDocument.activeElement,host.querySelector('.is-selected'));
});

const starterKey='cubby:starter:v1:line-cutter';
function starterHarness(){const values=new Map();let games=[],installs=0;return {values,storage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},platform:{library:async()=>games,install:async id=>{installs++;games=[{id,entrypoint:'/verified'}];}},get installs(){return installs},set games(value){games=value}};}
test('starter uses real install once, verifies library, keeps saves and respects later uninstall',async()=>{
 const e=starterHarness();e.values.set('linecutter_run','saved');
 assert.equal(await Hub.prepareStarter(e.platform,{id:'line-cutter',storage:e.storage}),'installed');assert.equal(e.installs,1);assert.equal(e.values.get('linecutter_run'),'saved');assert.equal(e.values.get(starterKey),'1');
 e.games=[];assert.equal(await Hub.prepareStarter(e.platform,{id:'line-cutter',storage:e.storage}),'done');assert.equal(e.installs,1);
});
test('starter failure leaves no success marker, retries and never fakes an installed entry',async()=>{
 const e=starterHarness(),install=e.platform.install;let first=true;
 e.platform.install=async id=>{if(first){first=false;throw Error('offline');}return install(id);};
 await assert.rejects(Hub.prepareStarter(e.platform,{id:'line-cutter',storage:e.storage}),/offline/);assert.equal(e.values.has(starterKey),false);
 await Hub.prepareStarter(e.platform,{id:'line-cutter',storage:e.storage});assert.equal(e.values.get(starterKey),'1');
 const missing=starterHarness();missing.platform.install=async()=>{};await assert.rejects(Hub.prepareStarter(missing.platform,{id:'line-cutter',storage:missing.storage}),/not installed/);assert.equal(missing.values.has(starterKey),false);
});
test('existing starter game records success without reinstalling, no opt-in does no work',async()=>{
 const e=starterHarness();e.games=[{id:'line-cutter'}];assert.equal(await Hub.prepareStarter(e.platform,{id:'line-cutter',storage:e.storage}),'present');assert.equal(e.installs,0);
 assert.equal(await Hub.prepareStarter(e.platform,{}),'disabled');assert.equal(e.installs,0);
});
test('starter stays in Library with pictorial progress, then selects verified game for A-only launch',async()=>{
 let complete,installed=[];const game={id:'line-cutter',artwork:'/verified/cover.svg',entrypoint:'/verified/index.html'};
 const {host,hub,action}=mountedHub([],[],{install:true},{library:async()=>installed,install:()=>new Promise(resolve=>{complete=()=>{installed=[game];resolve();};})},{HandheldPlatformOptions:{starterGame:'line-cutter'},localStorage:{getItem:()=>null,setItem(){}}});
 await settle();assert.equal(hub.state.view,'library');assert.ok(host.querySelector('.install-progress'));assert.equal(host.querySelector('.download-game'),null);
 complete();await settle();assert.equal(hub.state.view,'library');assert.equal(hub.state.detail.id,'line-cutter');assert.equal(host.querySelector('.install-progress'),null);
 action('confirm');action('confirm');assert.equal(host.ownerDocument.defaultView.location.href,game.entrypoint);
});
for(const present of [false,true])test('first starter selects Line Cutter over an existing Library game, present='+present,async()=>{
 const starter={id:'line-cutter',artwork:'starter.svg',entrypoint:'/starter'};let installed=present?[games[0],starter]:[games[0]],installs=0;
 const {hub}=mountedHub([],[],{install:true},{library:async()=>installed,install:async()=>{installs++;installed.push(starter);}},{HandheldPlatformOptions:{starterGame:'line-cutter'},localStorage:{getItem:()=>null,setItem(){}}});
 await settle();assert.equal(hub.state.detail.id,'line-cutter');assert.equal(installs,present?0:1);
});
test('starter preparation preserves return-from-game selection',async()=>{
 const starter={id:'line-cutter',artwork:'starter.svg',entrypoint:'/starter'};
 const {hub}=mountedHub([games[0],starter],[],{install:true},{},{HandheldPlatformOptions:{starterGame:'line-cutter'},localStorage:{getItem:()=>null,setItem(){}},sessionStorage:{getItem:()=>games[0].id,removeItem(){}}});
 await settle();assert.equal(hub.state.detail.id,games[0].id);
});
test('starter completion respects navigation and Store selection made while waiting',async()=>{
 let complete,installed=[games[0]];const starter={id:'line-cutter',artwork:'starter.svg',entrypoint:'/starter'};
 const {host,hub}=mountedHub([],games,{install:true},{library:async()=>installed,install:()=>new Promise(resolve=>{complete=()=>{installed.push(starter);resolve();};})},{HandheldPlatformOptions:{starterGame:'line-cutter'},localStorage:{getItem:()=>null,setItem(){}}});
 await settle();hub.show('store');host.querySelector('[data-game-id="two"]').focus();complete();await settle();
 assert.equal(hub.state.view,'store');assert.equal(hub.state.detail.id,'two');
});
test('failed starter frees Library with pictorial retry and retries only on request',async()=>{
 let attempts=0,installed=[];const {host,hub}=mountedHub([],[],{install:true},{library:async()=>installed,install:async()=>{attempts++;if(attempts===1)throw Error('offline');installed=[{id:'line-cutter',artwork:'ok.svg',entrypoint:'/ok'}];}},{HandheldPlatformOptions:{starterGame:'line-cutter'},localStorage:{getItem:()=>null,setItem(){}}});
 await settle();assert.equal(hub.state.view,'library');assert.equal(attempts,1);assert.ok(host.querySelector('.retry-starter'));assert.equal(host.querySelector('.shelf-status').classList.contains('loading'),false);
 assert.equal(host.ownerDocument.activeElement,host.querySelector('.retry-starter'));host.querySelector('.retry-starter').click();await settle();assert.equal(attempts,2);assert.equal(hub.state.detail.id,'line-cutter');
});
test('a hub prepared while hidden focuses its Library card when the host activates',async()=>{
 let focus;const {host}=mountedHub(games,[],{},{},{addEventListener:(name,listener)=>{if(name==='focus')focus=listener;}});await settle();const doc=host.ownerDocument;doc.body={};doc.activeElement=doc.body;focus();assert.equal(doc.activeElement,host.querySelector('.is-selected'));
});
test('failed starter leaves existing installed games usable and exposes a retry',async()=>{
 const {host,hub}=mountedHub(games,[],{install:true},{install:async()=>{throw Error('offline');}},{HandheldPlatformOptions:{starterGame:'line-cutter'},localStorage:{getItem:()=>null,setItem(){}}});await settle();assert.equal(hub.state.detail.id,'one');assert.ok(host.querySelector('.play-game'));assert.ok(host.querySelector('.retry-starter'));
});
test('host activation retries an unfocused hidden-prepared hub after the visible frame',async()=>{
 let focus,afterFrame;const {host}=mountedHub(games,[],{},{},{addEventListener:(name,listener)=>{if(name==='focus')focus=listener;},requestAnimationFrame:fn=>afterFrame=fn});await settle();const doc=host.ownerDocument,card=host.querySelector('.is-selected');doc.body={};doc.activeElement=doc.body;const original=card.focus;card.focus=()=>{};focus();card.focus=original;assert.equal(doc.activeElement,doc.body);assert.equal(typeof afterFrame,'function');afterFrame();assert.equal(doc.activeElement,card);
});

// Players in the shared hub: the real player rules and pictures, against this DOM adapter.
const Profiles=require('../runtime/core/profiles.js'),Avatars=require('../runtime/core/avatars.js');
function memory(entries=[]){const values=new Map(entries);return {values,get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:k=>values.has(k)?values.get(k):null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};}
function playersHub({list,pin,overrides={},capabilities={},windowOverrides={},entries=[]}={}){
 const localStorage=memory(entries),sessionStorage=memory(pin?[[Profiles.PIN_KEY,pin]]:[]),calls=[];
 if(list)localStorage.setItem(Profiles.REGISTRY_KEY,JSON.stringify({profiles:list,active:list[0].id}));
 const mounted=mountedHub(games,[],{profiles:true,...capabilities},{useProfile:async id=>{calls.push(['use',id]);},removeProfile:async id=>{calls.push(['remove',id]);},savedGames:async id=>{calls.push(['saved',id]);return ['one'];},resetGameSaves:async(id,player)=>{calls.push(['reset',id,player]);},...overrides},
  {localStorage,sessionStorage,HandheldProfiles:Profiles,HandheldAvatars:Avatars,...windowOverrides});
 return {...mounted,localStorage,sessionStorage,calls};
}
const three=[{id:Profiles.FIRST,avatar:'bear'},{id:'p_fixture1',avatar:'fox'},{id:'p_fixture2',avatar:'frog'}];
function deviceSettings(){
 const window={addEventListener(){}};
 require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../rocknix/bridge.js'),'utf8'),{window});
 return window.HandheldPlatformOptions.settings;
}
const settingsLabels=host=>host.querySelector('.options-panel').querySelectorAll('button').map(button=>button.getAttribute('aria-label'));
for(const device of [false,true])test('everyday settings precede setup and feeds, with safe default focus; device='+device,async()=>{
 const calibration=require('../runtime/core/host-osd.js').createCalibration(()=>[],memory());
 const {host,hub}=playersHub({pin:Profiles.FIRST,capabilities:{quit:true,power:device},overrides:{
  settings:device?deviceSettings():[],feedConfig:async()=>({feeds:[]}),setFeedConfig:async value=>value,
  updateAttention:async()=>({attention:true})
 },windowOverrides:{HandheldOSD:{calibration,reset(){}},setInterval:()=>0,clearInterval(){}}});
 await settle();hub.show('options');assert.equal(host.querySelector('.manage-feeds'),null);passGate(host);
 const expected=device?['Wi-Fi settings','Cubby updates','Players','Game saves','Adult controller setup','Game feeds','Power','Quit application']:['Players','Manage game saves','Adult controller setup','Adult keyboard setup','Game feeds','Quit application'];
 assert.deepEqual(settingsLabels(host),expected);
 assert.equal(host.ownerDocument.activeElement.getAttribute('aria-label'),expected[0]);
 if(device){const update=host.querySelectorAll('.settings-tile').find(tile=>tile.getAttribute('aria-label')==='Cubby updates');assert.ok(Object.hasOwn(update.dataset,'notice'),'Update tile retains its attention marker');assert.ok(host.querySelectorAll('.view-tab')[2].classList.contains('has-notice'),'Gear retains update attention');}
 hub.show('library');hub.show('options');assert.ok(host.querySelector('.settings-gate'));assert.equal(host.querySelector('.manage-feeds'),null);
 hub.dispose();
});
test('settings omit unsupported advanced actions without displacing everyday defaults',async()=>{
 const {host,hub}=mountedHub(games);await settle();hub.show('options');passGate(host);
 assert.deepEqual(settingsLabels(host),['Manage game saves','Adult keyboard setup']);
 assert.equal(host.ownerDocument.activeElement,host.querySelector('.manage-saves'));hub.dispose();
 const device=mountedHub(games,[],{},{settings:deviceSettings()});await settle();device.hub.show('options');passGate(device.host);
 assert.deepEqual(settingsLabels(device.host),['Wi-Fi settings','Cubby updates','Game saves']);
 assert.equal(device.host.ownerDocument.activeElement.getAttribute('aria-label'),'Wi-Fi settings');device.hub.dispose();
});
const picker=host=>host.querySelector('.player-picker');
test('with players, Cubby asks who is playing on start; the first pick has no way around it',async()=>{
 const {host,action,calls,sessionStorage}=playersHub({list:three});await settle();
 assert.equal(picker(host).hidden,false);assert.equal(host.querySelector('.picker-back'),null);
 assert.deepEqual(host.querySelectorAll('.picker-face').map(face=>face.dataset.profile),[...three.map(p=>p.id),undefined],'Every player, then +');
 assert.equal(host.ownerDocument.activeElement.dataset.profile,Profiles.FIRST,'Focus starts on the last player');
 for(const a of ['back','exit','nextView','select'])action(a);assert.equal(picker(host).hidden,false);
 host.querySelectorAll('.picker-face')[1].focus();action('confirm');await settle();
 assert.equal(picker(host).hidden,true);assert.deepEqual(calls,[['use','p_fixture1']]);assert.equal(sessionStorage.getItem(Profiles.PIN_KEY),'p_fixture1');
 const button=host.querySelector('.player-button');assert.equal(button.hidden,false);assert.equal(button.dataset.avatar,'fox');
});
test('coming back to the hub keeps the player; the picture reopens the picker and Back keeps them',async()=>{
 const {host,action,hub}=playersHub({list:three,pin:'p_fixture2'});await settle();
 assert.equal(picker(host).hidden,true);assert.equal(host.querySelector('.player-button').dataset.avatar,'frog');
 host.querySelector('.player-button').click();assert.equal(picker(host).hidden,false);assert.ok(host.querySelector('.picker-back'));
 assert.equal(host.ownerDocument.activeElement.dataset.profile,'p_fixture2');
 action('back');assert.equal(picker(host).hidden,true);assert.equal(hub.state.view,'library');
});
test('switching player switches favorites, and a game launches only once the host plays as that player',async()=>{
 const order=[];
 const {host,hub}=playersHub({list:three,pin:Profiles.FIRST,capabilities:{tokens:true},entries:[['handheld:favorites:v1','["one"]'],['cubby:profile:p_fixture1:handheld:favorites:v1','["two"]']],
  overrides:{account:async()=>({available:true,balance:5}),useProfile:async id=>order.push('use '+id),launch:async id=>order.push('launch '+id)}});await settle();
 assert.equal(hub.state.isFavorite('one'),true);assert.equal(hub.state.isFavorite('two'),false);
 host.querySelector('.player-button').click();host.querySelectorAll('.picker-face')[1].click();await settle();
 assert.equal(hub.state.isFavorite('one'),false);assert.equal(hub.state.isFavorite('two'),true);
 order.length=0;host.querySelector('.play-game').click();await settle();assert.deepEqual(order,['use p_fixture1','launch one']);
});
test('a host that cannot switch player does not start the game',async()=>{
 const launched=[];const {host}=playersHub({list:three,pin:Profiles.FIRST,windowOverrides:{location:{}},overrides:{useProfile:async()=>{throw Error('ipc');}}});await settle();
 const location=host.ownerDocument.defaultView.location;host.querySelector('.play-game').click();await settle();assert.equal(location.href,undefined);
});
test('with players, the adult save page asks whose saves and resets only that player’s',async()=>{
 const {host,hub,calls,action}=playersHub({list:three,pin:Profiles.FIRST});await settle();hub.show('options');passGate(host);
 host.querySelector('.manage-saves').click();assert.equal(host.querySelectorAll('.choose-player').length,3);
 host.querySelectorAll('.choose-player')[2].click();await settle();assert.deepEqual(calls.at(-1),['saved','p_fixture2']);
 host.querySelector('.choose-save').click();host.querySelector('.confirm-reset').click();await settle();assert.deepEqual(calls.at(-1),['reset','one','p_fixture2']);
 action('back');assert.equal(host.querySelectorAll('.choose-player').length,3,'Back returns to the players');
 action('back');assert.equal(host.querySelector('.save-management').open,false);
});
test('a device lists the players page among its tiles, and a host without players hides it',async()=>{
 const settings=[{icon:'trash',label:'Game saves',href:'#adult-saves'},{icon:'players',label:'Players',href:'#adult-players'}];
 const withPlayers=playersHub({pin:Profiles.FIRST,overrides:{settings}});await settle();withPlayers.hub.show('options');passGate(withPlayers.host);
 assert.ok(withPlayers.host.querySelectorAll('.settings-tile').some(tile=>tile.getAttribute('aria-label')==='Players'));
 const without=mountedHub(games,[],{},{settings});await settle();without.hub.show('options');passGate(without.host);
 assert.equal(without.host.querySelectorAll('.settings-tile').some(tile=>tile.getAttribute('aria-label')==='Players'),false);
});
test('a child sees their own name under their face and beside it on the hub',async()=>{
 const list=[{id:Profiles.FIRST,avatar:'bear',name:'Theo'},{id:'p_fixture1',avatar:'fox'}];
 const {host}=playersHub({list});await settle();
 assert.deepEqual(host.querySelectorAll('.face-name').map(n=>n.textContent),['Theo','Fox',undefined],'Names, and a nameless +');
 assert.deepEqual(host.querySelectorAll('.picker-face').map(f=>f.getAttribute('aria-label')),['Theo','Fox','New player']);
 host.querySelectorAll('.picker-face')[0].click();await settle();
 assert.equal(host.querySelector('.player-label').textContent,'Theo');assert.equal(host.querySelector('.player-button').hidden,false);
});
test('adults name a player with a text field; a bad or taken name is refused with a red shake, not words',async()=>{
 const list=[{id:Profiles.FIRST,avatar:'bear',name:'Theo'},{id:'p_fixture1',avatar:'fox'}];
 const {host,hub,localStorage}=playersHub({list,pin:Profiles.FIRST});await settle();hub.show('options');passGate(host);host.querySelector('.manage-players').click();
 assert.deepEqual(host.querySelectorAll('.player-name').map(n=>n.textContent),['Theo','Fox']);
 assert.ok(host.querySelectorAll('.player-row')[0].classList.contains('is-playing'),'The player playing now wears the ring');
 host.querySelectorAll('.rename-player')[1].click();const field=host.querySelector('.player-name-field'),save=host.querySelector('.save-name');
 assert.equal(field.value,'Fox');assert.equal(field.maxLength,12);assert.equal(host.querySelector('.name-keyboard'),null,'Desktop and browser type on a real keyboard');
 assert.equal(host.ownerDocument.activeElement,field);assert.equal(save.disabled,false);
 const stopped=[];for(const type of ['keydown','keyup'])field.listeners[type][0]({key:'x',stopPropagation:()=>stopped.push(type)});assert.deepEqual(stopped,['keydown','keyup'],'Typed keys never drive the hub');
 const enter=()=>field.listeners.keydown[0]({key:'Enter',stopPropagation(){}});
 for(const [value,outlined] of [['theo',true],['Maya!',true],['  ',false]]){
  field.value=value;field.listeners.input[0]();
  assert.equal(save.disabled,true,value+': ✓ stays dim');assert.equal(field.classList.contains('invalid'),outlined,value+': red outline');
  enter();assert.ok(field.classList.contains('refused')&&field.classList.contains('invalid'),value+': trying anyway shakes it red');
 }
 assert.equal(host.querySelector('.save-feedback'),null,'No error words');
 field.value=' Maya ';field.listeners.input[0]();assert.equal(save.disabled,false);assert.equal(field.classList.contains('invalid'),false);save.click();
 assert.equal(JSON.parse(localStorage.getItem(Profiles.REGISTRY_KEY)).profiles[1].name,'Maya');
 assert.ok(host.querySelectorAll('.player-name').some(n=>n.textContent==='Maya'));
});

// The kid side of players: a fresh Cubby is one player, Cubby; + names it, then adds.
const Keyboard=require('../runtime/core/keyboard.js');
const device={CubbyDeviceProfile:'rg353v',HandheldKeyboard:Keyboard,AbortController,fetch:()=>Promise.reject(Error('offline'))};
const animals=host=>host.querySelector('.kid-animals').querySelectorAll('.picker-face');
function kidPlus(host){host.querySelector('.player-button').click();host.querySelector('.picker-plus').click();}
function kidType(host,action,word){const board=host.querySelector('.name-keyboard');for(const c of word){board.children.find(b=>b.textContent===c).focus();action('confirm');}}
test('a fresh Cubby is one player, Cubby, wearing the logo in the logo’s place, and writes nothing',async()=>{
 const {host,localStorage,sessionStorage}=playersHub();await settle();
 assert.equal(picker(host).hidden,true,'One player goes straight to the hub');
 const chip=host.querySelector('.player-button');assert.equal(chip.hidden,false);assert.equal(chip.dataset.avatar,'cubby');assert.equal(host.querySelector('.player-label').textContent,'Cubby');
 assert.ok(host.querySelector('.brand').classList.contains('has-player'),'The chip takes the logo’s spot');
 host.querySelector('.play-game').click();await settle();
 assert.equal(localStorage.length,0,'Playing as Cubby never writes player storage');assert.equal(sessionStorage.getItem(Profiles.PIN_KEY),Profiles.FIRST);
});
test('a child’s first + names Cubby in place, with no adult question; ✕ changes nothing',async()=>{
 const {host,action,localStorage,calls}=playersHub({windowOverrides:device});await settle();
 host.querySelector('.player-button').click();assert.equal(picker(host).hidden,false);
 assert.deepEqual(host.querySelectorAll('.face-name').map(n=>n.textContent),['Cubby',undefined]);assert.equal(host.querySelector('.settings-gate'),null,'The kid side asks no math');
 host.querySelector('.picker-plus').click();assert.equal(animals(host).length,8);
 action('back');assert.ok(host.querySelector('.picker-plus'),'Back is ✕: the faces again');assert.equal(localStorage.length,0);
 host.querySelector('.picker-plus').click();animals(host)[0].click();
 assert.equal(host.querySelector('.player-name-field').value,'','A child types their name');assert.equal(host.querySelector('.save-name').disabled,true,'✓ waits for a name');
 host.querySelector('.cancel-player').click();assert.equal(localStorage.length,0,'✕ changes nothing');
 host.querySelector('.picker-plus').click();animals(host)[0].click();
 kidType(host,action,'Theo');assert.equal(host.querySelector('.save-name').disabled,false);action('pause');await settle();
 assert.deepEqual(JSON.parse(localStorage.getItem(Profiles.REGISTRY_KEY)).profiles,[{id:Profiles.FIRST,avatar:'fox',name:'Theo'}],'Same player, now Theo the fox');
 assert.equal(picker(host).hidden,true);assert.equal(host.querySelector('.player-label').textContent,'Theo');assert.deepEqual(calls.at(-1),['use',Profiles.FIRST]);
});
test('after that + adds a player and plays as them; a taken name shakes red; + hides when every animal is used',async()=>{
 const list=[{id:Profiles.FIRST,avatar:'fox',name:'Theo'}];
 const {host,action,localStorage,sessionStorage}=playersHub({list,pin:Profiles.FIRST,windowOverrides:device});await settle();
 kidPlus(host);assert.equal(animals(host).some(f=>f.getAttribute('aria-label')==='Fox'),false,'A taken animal is not offered');
 animals(host)[0].click();kidType(host,action,'Theo');
 const field=host.querySelector('.player-name-field');assert.ok(field.classList.contains('invalid'));assert.equal(host.querySelector('.save-name').disabled,true);
 action('pause');assert.ok(field.classList.contains('refused'),'Start anyway shakes it');
 for(let i=0;i<4;i++){host.querySelector('.name-keyboard').children.find(b=>b.getAttribute('aria-label')==='Backspace').focus();action('confirm');}
 kidType(host,action,'Mia');action('pause');await settle();
 const players=JSON.parse(localStorage.getItem(Profiles.REGISTRY_KEY)).profiles;assert.equal(players.length,2);assert.equal(players[1].name,'Mia');
 assert.equal(sessionStorage.getItem(Profiles.PIN_KEY),players[1].id,'Plays as the new player');
 const full=['fox','frog','bear','bunny','panda','owl','cat','chick'].map((avatar,i)=>({id:i?'p_full'+i:Profiles.FIRST,avatar}));
 const crowded=playersHub({list:full,pin:Profiles.FIRST});await settle();crowded.host.querySelector('.player-button').click();
 assert.equal(crowded.host.querySelector('.picker-plus'),null);
});
test('adults rename, re-picture and remove players behind the gear question; the last one removed leaves a fresh Cubby',async()=>{
 const list=[{id:Profiles.FIRST,avatar:'bear',name:'Theo'},{id:'p_fixture1',avatar:'fox',name:'Maya'}];
 const {host,hub,localStorage,calls}=playersHub({list,pin:Profiles.FIRST});await settle();hub.show('options');
 assert.equal(host.querySelector('.manage-players'),null);passGate(host);host.querySelector('.manage-players').click();
 assert.equal(host.querySelector('.player-management').open,true);assert.equal(host.querySelector('.add-player'),null,'Children add players with + on the hub');
 host.querySelectorAll('.change-picture')[1].click();host.querySelectorAll('.avatar-choice').find(b=>b.getAttribute('aria-label')==='Owl').click();
 assert.equal(JSON.parse(localStorage.getItem(Profiles.REGISTRY_KEY)).profiles[1].avatar,'owl');
 host.querySelectorAll('.remove-player')[1].click();host.querySelector('.cancel-player').click();assert.equal(JSON.parse(localStorage.getItem(Profiles.REGISTRY_KEY)).profiles.length,2);
 host.querySelectorAll('.remove-player')[1].click();host.querySelector('.remove-confirm').click();await settle();
 assert.deepEqual(calls.filter(c=>c[0]==='remove'),[['remove','p_fixture1']]);assert.equal(JSON.parse(localStorage.getItem(Profiles.REGISTRY_KEY)).profiles.length,1);
 assert.equal(host.querySelectorAll('.player-name')[0].textContent,'Theo','The one left stays as they are');
 host.querySelector('.remove-player').click();host.querySelector('.remove-confirm').click();await settle();
 assert.equal(localStorage.getItem(Profiles.REGISTRY_KEY),null,'Back to a fresh Cubby');assert.equal(host.querySelectorAll('.player-name')[0].textContent,'Cubby');
 assert.equal(host.querySelector('.remove-player'),null,'Cubby itself has nothing to remove');assert.equal(host.querySelector('.player-button').dataset.avatar,'cubby');
});
test('player screens show no words but players’ names and keyboard letters',async()=>{
 const list=[{id:Profiles.FIRST,avatar:'bear',name:'Theo'},{id:'p_fixture1',avatar:'fox'},{id:'p_fixture2',avatar:'frog',name:'Josephine'}],names=new Set(['Theo','Fox','Josephine','Cubby']);
 const {host,hub,action}=playersHub({list,windowOverrides:device});await settle();
 const shown=[];
 function collect(screen){const walk=e=>{if(typeof e.textContent==='string'&&e.textContent&&!e.children?.length)shown.push([screen,e.textContent,!!e.parent?.classList.contains('cubby-keyboard')]);(e.children||[]).forEach(walk);};walk(host.querySelector('.player-picker'));walk(host.querySelector('.brand'));walk(host.querySelector('.player-management'));const saves=host.querySelector('.save-management');if(saves.querySelector('.choose-player'))walk(saves);}
 collect('picker');host.querySelectorAll('.picker-face')[0].click();await settle();collect('hub');
 kidPlus(host);collect('kid animal');animals(host)[0].click();collect('kid name');action('back');action('back');
 hub.show('options');passGate(host);host.querySelector('.manage-players').click();collect('players');
 host.querySelectorAll('.rename-player')[0].click();collect('name');host.querySelector('.cancel-player').click();
 host.querySelectorAll('.change-picture')[0].click();collect('picture');host.querySelector('.cancel-player').click();
 host.querySelectorAll('.remove-player')[1].click();collect('remove');host.querySelector('.cancel-player').click();
 host.querySelector('.close-players-page').click();host.querySelector('.manage-saves').click();collect('whose saves');
 assert.ok(shown.some(([screen,text])=>screen==='whose saves'&&text==='Josephine'),'Names are shown');assert.ok(shown.some(([screen,,key])=>screen==='kid name'&&key),'Keys are shown');
 for(const [screen,text,key] of shown)assert.ok(names.has(text)||(key&&[...text].length===1),screen+' shows words: '+text);
});

// Game feeds: an adult page with no words but feed names, like the Players screens.
const Feeds=require('../runtime/core/game-feeds.js');
function stableFeedState(){const config={schema:1,feeds:[{url:Feeds.DEFAULT_URL,name:'Cubby Arcade',enabled:true}]};return {schema:1,config,profiles:{p_first:config},cache:{},sources:{}};}
function feedHub(extra={},windowOverrides={},fetchCatalog=null){
 let saved=stableFeedState(),writes=0;
 const manager=Feeds.createManager({read:async()=>saved,write:async value=>{writes++;saved=structuredClone(value);},fetchCatalog:fetchCatalog||(async url=>[{id:url===Feeds.DEFAULT_URL?'cubby':'custom',title:'Game',artwork:url===Feeds.DEFAULT_URL?'https://assets.test/cubby.png':'https://assets.test/custom.png',manifest_url:'https://assets.test/game.json'}])});
 const mounted=mountedHub(games,[],{}, {feedConfig:()=>manager.config(),setFeedConfig:config=>manager.setConfig(config),catalog:()=>manager.catalog(),feedStatus:()=>manager.status(),...extra},windowOverrides);
 return {...mounted,manager,saved:()=>saved,writes:()=>writes};
}
async function openFeedsPage(host,hub){hub.show('options');passGate(host);host.querySelector('.manage-feeds').click();await settle();return host.querySelector('.feed-management');}
function typeFeed(dialog,name,url){dialog.querySelector('.feed-name-input').value=name;dialog.querySelector('.feed-url-input').value=url;}
const feedNames=dialog=>dialog.querySelectorAll('.feed-card').map(card=>card.querySelector('.feed-title').textContent);
const coversOf=card=>card.querySelector('.feed-covers').querySelectorAll('img');
test('feed management is gated on every host and add/edit/order/toggle/remove refresh the blended Store',async()=>{
 const {host,hub,manager}=feedHub({settings:[{icon:'wifi',label:'Network',href:'/adult/network'}]});await settle();hub.show('options');assert.equal(host.querySelector('.manage-feeds'),null);
 const dialog=await openFeedsPage(host,hub);assert.equal(dialog.open,true);assert.deepEqual(feedNames(dialog),['Cubby Arcade']);
 assert.equal(host.ownerDocument.activeElement,dialog.querySelector('.feed-edit'),'Lands on the first feed, as Players lands on the first rename');
 dialog.querySelector('.add-feed').click();typeFeed(dialog,'Other','https://other.test/catalog');dialog.querySelector('.save-feed').click();await settle();
 assert.equal((await manager.config()).feeds.length,2);assert.deepEqual(feedNames(dialog),['Cubby Arcade','Other']);assert.equal(host.ownerDocument.activeElement,dialog.querySelectorAll('.feed-edit')[1],'Back on the new feed');
 assert.equal(dialog.querySelectorAll('.feed-up')[0].disabled,true);assert.equal(dialog.querySelectorAll('.feed-down')[1].disabled,true,'Chevrons stop at the ends');
 dialog.querySelectorAll('.feed-up')[1].click();await settle();assert.equal((await manager.config()).feeds[0].name,'Other');assert.equal(host.ownerDocument.activeElement,dialog.querySelectorAll('.feed-down')[0],'Focus follows the moved feed');
 dialog.querySelectorAll('.feed-edit')[0].click();assert.equal(dialog.querySelector('.feed-url-input').value,'https://other.test/catalog');typeFeed(dialog,'Renamed','https://renamed.test/catalog');dialog.querySelector('.save-feed').click();await settle();assert.equal((await manager.config()).feeds[0].url,'https://renamed.test/catalog');
 const toggle=()=>dialog.querySelectorAll('.feed-toggle')[0];assert.equal(toggle().getAttribute('role'),'switch');assert.equal(toggle().getAttribute('aria-checked'),'true');
 toggle().click();await settle();assert.equal((await manager.config()).feeds[0].enabled,false);assert.equal(toggle().getAttribute('aria-checked'),'false');assert.ok(dialog.querySelectorAll('.feed-card')[0].classList.contains('is-off'),'A feed not in use dims');
 toggle().click();await settle();dialog.querySelector('.close-feeds').click();hub.show('store');assert.deepEqual(shelfIds(host),['custom','cubby']);
 await openFeedsPage(host,hub);dialog.querySelectorAll('.feed-remove')[0].click();assert.equal(dialog.querySelector('.feed-remove-name').textContent,'Renamed');assert.equal(dialog.querySelectorAll('.feed-card').length,0,'Removing asks first');
 dialog.querySelector('.cancel-feed').click();assert.equal((await manager.config()).feeds.length,2);assert.equal(host.ownerDocument.activeElement,dialog.querySelectorAll('.feed-remove')[0]);
 dialog.querySelectorAll('.feed-remove')[0].click();dialog.querySelector('.remove-confirm').click();await settle();assert.equal((await manager.config()).feeds.length,1);assert.deepEqual(feedNames(dialog),['Cubby Arcade']);
 dialog.querySelector('.close-feeds').click();hub.show('store');assert.deepEqual(shelfIds(host),['cubby']);hub.dispose();
});
test('feed cards show the covers of games that feed provides',async()=>{
 const {host,hub}=feedHub();await settle();const dialog=await openFeedsPage(host,hub);
 dialog.querySelector('.add-feed').click();typeFeed(dialog,'Other','https://other.test/catalog');dialog.querySelector('.save-feed').click();await settle();
 const covers=dialog.querySelectorAll('.feed-card').map(card=>coversOf(card).map(img=>img.src));
 assert.deepEqual(covers,[['https://assets.test/cubby.png'],['https://assets.test/custom.png']]);
 assert.ok(dialog.querySelectorAll('.feed-card').flatMap(coversOf).every(img=>img.alt===''),'Covers are pictures, not labels');
 dialog.querySelectorAll('.feed-toggle')[1].click();await settle();assert.equal(coversOf(dialog.querySelectorAll('.feed-card')[1]).length,0,'A feed not in use offers nothing');
 dialog.querySelector('.close-feeds').click();hub.dispose();
});
test('feed editor refuses bad fields with a red shake, writes nothing, and cancels back to the list',async()=>{
 const {host,hub,manager,writes}=feedHub();await settle();const dialog=await openFeedsPage(host,hub);
 dialog.querySelector('.add-feed').click();const name=dialog.querySelector('.feed-name-input'),url=dialog.querySelector('.feed-url-input'),save=dialog.querySelector('.save-feed');
 assert.ok(save.classList.contains('is-dim'),'✓ is dim until both fields can be saved');assert.ok(!save.disabled,'but pressing it still shows what is wrong');
 const before=writes();save.click();await settle();assert.ok(name.classList.contains('invalid')&&name.classList.contains('refused'),'An empty name shakes red');assert.equal(writes(),before);
 name.value='Nope';name.listeners.input[0]();assert.equal(name.classList.contains('invalid'),false,'Fixed fields turn back at once');
 url.value='http://unsafe.test/feed';save.click();await settle();assert.ok(url.classList.contains('invalid')&&url.classList.contains('refused'),'A non-HTTPS address shakes red');
 url.value=Feeds.DEFAULT_URL;url.classList.remove('refused');save.click();await settle();assert.ok(url.classList.contains('refused'),'A feed already added shakes red');
 assert.equal((await manager.config()).feeds.length,1);assert.equal(writes(),before);assert.ok(!save.disabled);
 dialog.querySelector('.cancel-feed').click();assert.equal(dialog.querySelectorAll('.feed-card').length,1);assert.equal(host.ownerDocument.activeElement,dialog.querySelector('.add-feed'));
 dialog.querySelector('.close-feeds').click();assert.equal(host.ownerDocument.activeElement,host.querySelector('.manage-feeds'));hub.show('library');hub.show('options');assert.equal(host.querySelector('.manage-feeds'),null);hub.dispose();
});
test('a validation error from the host shakes the address even when the hub could not check it',async()=>{
 const {host,hub,manager}=feedHub();await settle();const dialog=await openFeedsPage(host,hub);
 dialog.querySelectorAll('.feed-edit')[0].click();typeFeed(dialog,'Cubby Arcade','https://user:pw@other.test/feed');dialog.querySelector('.save-feed').click();await settle();
 assert.ok(dialog.querySelector('.feed-url-input').classList.contains('refused'));assert.equal((await manager.config()).feeds[0].url,Feeds.DEFAULT_URL);hub.dispose();
});
test('feed load and persistence failures stay in adult dialog as pictures and permit retry without losing draft',async()=>{
 let fail=true;const {host,hub}=feedHub({feedConfig:async()=>{if(fail)throw Error('disk');return {schema:1,feeds:[]};},setFeedConfig:async()=>{throw Error('disk');}});await settle();const dialog=await openFeedsPage(host,hub);
 assert.ok(dialog.querySelector('.feed-wait'));assert.equal(host.ownerDocument.activeElement,dialog.querySelector('.retry-feeds'));fail=false;dialog.querySelector('.retry-feeds').click();await settle();
 assert.equal(dialog.querySelectorAll('.feed-card').length,0);assert.equal(host.ownerDocument.activeElement,dialog.querySelector('.add-feed'),'With no feeds, + is the way on');
 dialog.querySelector('.add-feed').click();typeFeed(dialog,'Draft','https://other.test/feed');dialog.querySelector('.save-feed').click();await settle();
 assert.equal(dialog.querySelector('.feed-name-input').value,'Draft');const save=dialog.querySelector('.save-feed');assert.ok(save.classList.contains('refused'),'A save that could not be stored shakes ✓');assert.ok(!save.disabled);assert.equal(save.classList.contains('is-busy'),false);
 dialog.querySelector('.cancel-feed').click();dialog.querySelector('.close-feeds').click();hub.dispose();
});
test('a change that cannot be stored shakes the control pressed and leaves the feed as it was',async()=>{
 const {host,hub}=feedHub({setFeedConfig:async()=>{throw Error('disk');}});await settle();const dialog=await openFeedsPage(host,hub);
 const toggle=dialog.querySelector('.feed-toggle');toggle.click();await settle();assert.equal(toggle.getAttribute('aria-checked'),'true','The switch slides back');assert.ok(toggle.classList.contains('refused'));assert.equal(host.ownerDocument.activeElement,toggle);assert.equal(toggle.disabled,false);
 dialog.querySelector('.feed-remove').click();const confirm=dialog.querySelector('.remove-confirm');confirm.click();await settle();assert.ok(confirm.classList.contains('refused'));assert.equal(host.ownerDocument.activeElement,dialog.querySelector('.cancel-feed'));
 dialog.querySelector('.cancel-feed').click();assert.deepEqual(feedNames(dialog),['Cubby Arcade']);hub.dispose();
});
test('feed editor protects native typing and its modal stays put during a pending save',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const {host,hub,action}=feedHub({setFeedConfig:async config=>{await pending;return config;}});await settle();const dialog=await openFeedsPage(host,hub);dialog.querySelector('.add-feed').click();const name=dialog.querySelector('.feed-name-input');let stopped=false;name.dispatchEvent({type:'keydown',code:'KeyA',stopPropagation(){stopped=true;}});assert.equal(stopped,true);
 typeFeed(dialog,'Other','https://other.test/feed');action('pause','gamepad');await settle();const save=dialog.querySelector('.save-feed');assert.equal(save.disabled,true);assert.ok(save.classList.contains('is-busy'),'✓ pulses while saving');
 action('back','gamepad');assert.equal(dialog.open,true);release();await settle();assert.deepEqual(feedNames(dialog),['Cubby Arcade','Other']);action('back','gamepad');assert.equal(dialog.open,false);hub.dispose();
});
test('a saved feed configuration is not reported as failed if the following catalog refresh fails',async()=>{
 let refreshFails=false;const {host,hub,manager}=feedHub({catalog:async()=>{if(refreshFails)throw Error('refresh disk failure');return [];}});await settle();const dialog=await openFeedsPage(host,hub);refreshFails=true;dialog.querySelector('.feed-toggle').click();await settle();
 assert.equal((await manager.config()).feeds[0].enabled,false);assert.equal(dialog.querySelector('.feed-toggle').getAttribute('aria-checked'),'false');assert.equal(dialog.querySelector('.feed-toggle').classList.contains('refused'),false);assert.equal(dialog.querySelector('.feed-up').disabled,true);dialog.querySelector('.close-feeds').click();hub.dispose();
});
test('handheld feed fields are typed with the shared controller keyboard on whichever field is chosen',async()=>{
 let config=stableFeedState().config;const {host,hub,action}=mountedHub(games,[],{}, {feedConfig:async()=>config,setFeedConfig:async next=>(config=Feeds.validateConfig(next))},device);await settle();const dialog=await openFeedsPage(host,hub);
 dialog.querySelector('.add-feed').click();let keys=dialog.querySelector('.feed-keyboard');assert.ok(keys,'Keys are there at once, with nothing to press first');assert.equal(dialog.querySelector('.type-feed-name'),null);
 assert.equal(keys.dataset.layout,'web');assert.ok(keys.children.includes(host.ownerDocument.activeElement),'The D-pad starts on the keys');
 keys.querySelectorAll('button').find(b=>b.textContent==='Q').click();assert.equal(dialog.querySelector('.feed-name-input').value,'Q','A name starts with a capital');
 const url=dialog.querySelector('.feed-url-input');url.focus();assert.ok(url.parent.classList.contains('is-typing'));
 action('confirm','gamepad');assert.ok(keys.children.includes(host.ownerDocument.activeElement),'Confirm on a field goes to its keys');
 for(const char of 'https://q.test/feed')keys.querySelectorAll('button').find(b=>b.textContent===char).click();assert.equal(url.value,'https://q.test/feed');assert.equal(dialog.querySelector('.feed-name-input').value,'Q');
 action('nextView','gamepad');assert.ok(keys.querySelectorAll('button').some(b=>b.textContent==='Q'));action('pause','gamepad');await settle();assert.equal(config.feeds[1].url,'https://q.test/feed');assert.equal(config.feeds[1].name,'Q');dialog.querySelector('.close-feeds').click();hub.dispose();
});
test('feed cards show failed and saved-copy loads as pictures, after save and on reopening',async()=>{
 let saved=stableFeedState(),fail=new Set();
 const manager=Feeds.createManager({read:async()=>saved,write:async value=>{saved=value;},fetchCatalog:async url=>{if(fail.has(url))throw Error('Failed to fetch');return url===Feeds.DEFAULT_URL?[]:[{id:'other',title:'Other',artwork:'https://assets.test/o.png',manifest_url:'https://assets.test/o.json'}];}});
 const {host,hub}=feedHub({feedConfig:()=>manager.config(),setFeedConfig:next=>manager.setConfig(next),catalog:()=>manager.catalog(),feedStatus:()=>manager.status()});await settle();const dialog=await openFeedsPage(host,hub);
 assert.ok(dialog.querySelector('.feed-none'),'A feed that loaded with no games shows an empty box');
 fail.add('https://unavailable.test/catalog');dialog.querySelector('.add-feed').click();typeFeed(dialog,'Unavailable','https://unavailable.test/catalog');dialog.querySelector('.save-feed').click();await settle();
 const card=()=>dialog.querySelectorAll('.feed-card')[1];assert.ok(card().classList.contains('is-down'));assert.equal(card().querySelector('.feed-mark').getAttribute('aria-label'),'Not loading');assert.equal(dialog.querySelectorAll('.feed-card')[0].querySelector('.feed-mark'),null,'A feed that loads shows nothing extra');
 dialog.querySelector('.close-feeds').click();host.querySelector('.manage-feeds').click();await settle();assert.ok(card().classList.contains('is-down'),'Still red on reopening');
 dialog.querySelectorAll('.feed-toggle')[1].click();await settle();assert.ok(card().classList.contains('is-off'));assert.equal(card().classList.contains('is-down'),false);assert.equal(card().querySelector('.feed-mark'),null);
 fail.delete('https://unavailable.test/catalog');dialog.querySelectorAll('.feed-toggle')[1].click();await settle();assert.equal(card().querySelector('.feed-mark'),null);assert.equal(coversOf(card()).length,1);
 fail.add('https://unavailable.test/catalog');dialog.querySelectorAll('.feed-up')[1].click();await settle();const stale=dialog.querySelectorAll('.feed-card')[0];assert.ok(stale.classList.contains('is-stale'),'A refresh that failed after an earlier load keeps the saved games, dimly marked');assert.equal(stale.querySelector('.feed-mark').getAttribute('aria-label'),'Saved copy');
 dialog.querySelector('.close-feeds').click();hub.dispose();
});
test('feed screens show no words but feed names and keyboard letters, and every button is named for screen readers',async()=>{
 let fail=true;const {host,hub,action}=feedHub({},device,async url=>{if(url!==Feeds.DEFAULT_URL&&fail)throw Error('offline');return [{id:url===Feeds.DEFAULT_URL?'cubby':'other',title:'Game',artwork:'https://assets.test/a.png',manifest_url:'https://assets.test/g.json'}];});await settle();
 const shown=[],unnamed=[],names=new Set(['Cubby Arcade','Muse']);
 function collect(screen){const walk=e=>{const key=!!e.parent?.classList.contains('cubby-keyboard');if(typeof e.textContent==='string'&&e.textContent&&!e.children?.length)shown.push([screen,e.textContent,key]);if(['button','input'].includes(e.tagName)&&!key&&!e.getAttribute('aria-label'))unnamed.push(screen+' '+e.className);(e.children||[]).forEach(walk);};walk(host.querySelector('.feed-management'));}
 const dialog=await openFeedsPage(host,hub);collect('list');
 dialog.querySelector('.add-feed').click();collect('add');typeFeed(dialog,'Muse','https://muse.test/feed.json');dialog.querySelector('.save-feed').click();await settle();collect('with a failed feed');
 assert.ok(dialog.querySelector('.is-down'));
 dialog.querySelectorAll('.feed-edit')[1].click();dialog.querySelector('.feed-url-input').value='nope';dialog.querySelector('.save-feed').click();collect('edit error');action('back','gamepad');
 dialog.querySelectorAll('.feed-remove')[1].click();collect('remove');action('back','gamepad');
 dialog.querySelectorAll('.feed-toggle')[1].click();await settle();collect('disabled');
 assert.ok(shown.some(([screen,text])=>screen==='list'&&text==='Cubby Arcade'),'Names are shown');assert.ok(shown.some(([screen,,key])=>screen==='add'&&key),'Keys are shown');
 for(const [screen,text,key] of shown)assert.ok(names.has(text)||(key&&[...text].length===1),screen+' shows words: '+text);
 assert.deepEqual(unnamed,[]);dialog.querySelector('.close-feeds').click();hub.dispose();
});
test('the D-pad moves spatially between a feed card’s controls and from card to card',async()=>{
 const {host,hub,action}=feedHub();await settle();const dialog=await openFeedsPage(host,hub);
 dialog.querySelector('.add-feed').click();typeFeed(dialog,'Other','https://other.test/catalog');dialog.querySelector('.save-feed').click();await settle();
 const place=(node,left,top)=>{node.getBoundingClientRect=()=>({left,top,width:40,height:40});};
 dialog.querySelectorAll('.feed-card').forEach((card,i)=>{const y=i*200;place(card.querySelector('.feed-toggle'),300,y);['feed-up','feed-down','feed-edit','feed-remove'].forEach((cls,j)=>place(card.querySelector('.'+cls),150+j*50,y+60));});
 place(dialog.querySelector('.close-feeds'),0,-80);place(dialog.querySelector('.add-feed'),150,400);
 dialog.querySelectorAll('.feed-edit')[0].focus();action('right','gamepad');assert.equal(host.ownerDocument.activeElement,dialog.querySelectorAll('.feed-remove')[0]);
 action('down','gamepad');assert.equal(host.ownerDocument.activeElement,dialog.querySelectorAll('.feed-toggle')[1]);
 action('down','gamepad');assert.equal(host.ownerDocument.activeElement,dialog.querySelectorAll('.feed-remove')[1]);
 action('confirm','gamepad');assert.ok(dialog.querySelector('.remove-confirm'),'Confirm presses the focused button');action('back','gamepad');assert.equal(dialog.querySelectorAll('.feed-card').length,2);
 action('back','gamepad');assert.equal(dialog.open,false);hub.dispose();
});

test('profile switches clear both shelves immediately and discard an older profile refresh',async()=>{
 let active=Profiles.FIRST,finish;
 const stale=new Promise(resolve=>finish=resolve);let delayed=false;
 const {host,hub}=playersHub({list:three,pin:Profiles.FIRST,overrides:{setFeedProfile:id=>active=id,useProfile:async id=>{active=id;},library:async()=>active===Profiles.FIRST?[games[0]]:[games[1]],catalog:async()=>delayed&&active===Profiles.FIRST?stale:active===Profiles.FIRST?[games[0]]:[games[1]]}});
 await settle();assert.deepEqual(shelfIds(host),['one']);delayed=true;const pending=hub.refreshCatalog();
 host.querySelector('.player-button').click();host.querySelectorAll('.picker-face')[1].click();await settle();assert.deepEqual(shelfIds(host),['two']);
 delayed=false;finish([games[0]]);await pending;await settle();hub.show('store');assert.equal(shelfIds(host).includes('one'),false);hub.dispose();
});
test('adult feeds show the active player face and name',async()=>{
 const {host,hub}=playersHub({list:three,pin:'p_fixture1',overrides:{feedConfig:async()=>Feeds.defaultConfig(),setFeedConfig:async next=>next}});await settle();const dialog=await openFeedsPage(host,hub);
 assert.equal(dialog.querySelector('.feed-player-name').textContent,'Fox');assert.ok(dialog.querySelector('.feed-player').querySelector('.player-face'));assert.deepEqual(feedNames(dialog),['Cubby Arcade','Cubby Beta']);assert.equal(dialog.querySelectorAll('.feed-toggle')[1].getAttribute('aria-checked'),'false');hub.dispose();
});

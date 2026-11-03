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

// Small DOM adapter for exercising the mounted hub without a browser dependency.
function mountedHub(games){
 let onInstall,revision=0;
 class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.hidden=false;this.listeners={};this.style={setProperty(){},removeProperty(){}};this.className='';this.ownerDocument=doc;this.classList={contains:n=>this.className.split(' ').includes(n),add:n=>{if(!this.classList.contains(n))this.className+=' '+n;},remove:n=>{this.className=this.className.split(' ').filter(x=>x!==n).join(' ');},toggle:(n,on)=>{on??=!this.classList.contains(n);this.classList[on?'add':'remove'](n);}};}
  appendChild(e){this.children.push(e);e.parent=this;return e;}
  replaceChildren(...nodes){this.children=[];nodes.forEach(n=>this.appendChild(n));}
  set innerHTML(value){this._html=value;this.replaceChildren();if(value.includes('class="topbar"'))for(const cls of ['view-nav','view-body','hero-backdrop','hero-rest','shelf','detail','options-panel','adult-setup','hud']){const e=this.appendChild(new Element(cls==='adult-setup'?'dialog':'div'));e.className=cls;if(cls==='detail')e.hidden=true;if(cls==='hero-rest')e.appendChild(new Element('img'));}}
  get innerHTML(){return this._html||'';}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  removeAttribute(k){delete this.attributes[k];}
  addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
  matches(selector){return selector.split(',').some(s=>{s=s.trim();const data=s.match(/\[data-game-id="([^"]+)"\]/);if(data)return this.dataset.gameId===data[1];const cls=s.match(/\.([\w-]+)/);return (!cls||this.classList.contains(cls[1]))&&(!s.startsWith('dialog')||this.tagName==='dialog')&&(!s.startsWith('button')||this.tagName==='button')&&(!s.startsWith('video')||this.tagName==='video')&&(!s.startsWith('img')||this.tagName==='img')&&(!s.includes(':not(:disabled)')||!this.disabled);});}
  querySelectorAll(selector){if(selector==='.hero-rest img')return this.querySelector('.hero-rest')?.querySelectorAll('img')||[];return this.children.flatMap(e=>[...(e.matches(selector)?[e]:[]),...e.querySelectorAll(selector)]);}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  focus(){doc.activeElement=this;for(const fn of this.listeners.focus||[])fn();let e=this.parent;while(e){for(const fn of e.listeners.focusin||[])fn();e=e.parent;}}
  click(){for(const fn of this.listeners.click||[])fn();}
  insertAdjacentHTML(){}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  play(){return Promise.resolve();}pause(){}load(){}
 }
 const doc={createElement:tag=>new Element(tag),activeElement:null};
 const platform={capabilities:{},library:async()=>games,catalog:async()=>[],onInstallState:fn=>{onInstall=fn;},installStatus:async()=>({})};
 doc.defaultView={localStorage:{getItem:()=>null},HandheldPreferences:{preferences:{subscribe:()=>()=>{},get:()=>({touchOverlay:'auto'})}},HandheldPlatform:{createPlatform:()=>platform},HandheldInput:{createInput:()=>({dispose(){}})},addEventListener(){},fetch:()=>Promise.resolve(),location:{}};
 const host=new Element(),hub=Hub.mount(host);
 return {host,hub,refresh:entries=>{games=entries;onInstall({refresh:{phase:'installed',version:++revision}});}};
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
test('closing a Library preview retains the selected card without reopening it',async()=>{
 const {host,hub}=mountedHub(games);await settle();host.querySelector('[data-game-id="two"]').click();
 host.querySelector('.detail-close').click();
 assert.equal(host.querySelector('.detail').hidden,true);assert.equal(hub.state.detail,null);
 assert.equal(host.querySelectorAll('.is-selected').length,1);assert.equal(host.querySelector('.is-selected').dataset.gameId,'two');
});
test('empty Library remains an empty pictorial state',async()=>{
 const {host,hub}=mountedHub([]);await settle();hub.show('library');
 assert.equal(hub.state.detail,null);assert.equal(host.querySelector('.detail').hidden,true);assert.equal(host.querySelectorAll('.game-card').length,0);
});

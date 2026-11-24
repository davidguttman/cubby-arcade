const test=require('node:test');
const assert=require('node:assert/strict');
const {attachWorker}=require('../runtime/core/browser-store.js');
const origin='https://cubby.test';
// The root worker the play site installs: its shell must start offline and on a weak signal.
function worker(network){
 const stores=new Map(),listeners={},requests=[];
 const caches={async open(name){if(!stores.has(name))stores.set(name,new Map());const c=stores.get(name);return {
   async put(k,v){c.set(String(k),v.clone());},async match(k){return c.get(String(k))?.clone();},
   async addAll(paths){for(const p of paths){const r=await scope.fetch(new Request(origin+p));c.set(origin+p,r);}}};},
  async keys(){return [...stores.keys()];},async delete(name){return stores.delete(name);}};
 const scope={location:{origin},caches,indexedDB:{},crypto:globalThis.crypto,clients:{claim:async()=>{}},skipWaiting:async()=>{},
  addEventListener(type,fn){listeners[type]=fn;},fetch:async request=>{requests.push(new URL(request.url).pathname);return network(new URL(request.url).pathname);}};
 const lifecycle=async type=>{let done;listeners[type]({waitUntil(p){done=p;}});await done;};
 const fetch=async path=>{let answer;listeners.fetch({request:new Request(origin+path),respondWith(p){answer=p;},waitUntil(){}});return answer&&(await answer).text();};
 return {scope,stores,requests,lifecycle,fetch};
}
test('the shell answers from this build\'s saved copy, the catalogs from the network first, and old builds\' shells go',async()=>{
 let online=true,build='one';
 const w=worker(async path=>{if(!online)throw TypeError('offline');return new Response(build+':'+path);});
 attachWorker(w.scope,{shellVersion:'b',shellPaths:['/','/runtime/core/hub.js','/catalog']});
 (await w.scope.caches.open('cubby-shell-a'));(await w.scope.caches.open('cubby-game-x'));
 await w.lifecycle('install');await w.lifecycle('activate');
 assert.deepEqual((await w.scope.caches.keys()).sort(),['cubby-game-x','cubby-shell-b']);
 build='two';w.requests.length=0;
 // A newer server does not leak into this build's shell; the catalog is fetched fresh.
 assert.equal(await w.fetch('/runtime/core/hub.js'),'one:/runtime/core/hub.js');
 assert.equal(await w.fetch('/'),'one:/');
 assert.deepEqual(w.requests,[]);
 assert.equal(await w.fetch('/catalog'),'two:/catalog');
 // Offline: everything still answers, the catalog from its last copy.
 online=false;
 assert.equal(await w.fetch('/'),'one:/');
 assert.equal(await w.fetch('/catalog'),'two:/catalog');
 // Not part of the shell: the worker stays out of it.
 assert.equal(await w.fetch('/docs/x.html'),undefined);
});

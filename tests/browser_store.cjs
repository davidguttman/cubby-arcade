const test=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const {createBridge,validateRelease,createMetadataStore,installedResponse}=require('../runtime/core/browser-store.js');
const origin='https://cubby.test',manifestURL='https://games.test/arcade/manifest.json';
const hash=async text=>Buffer.from(await webcrypto.subtle.digest('SHA-256',Buffer.from(text))).toString('hex');
async function fixture(){
 const bytes={'play.html':'<script src="game.js"></script>','game.js':'window.game=true;','cover.png':'image'};
 const files={};for(const [name,body] of Object.entries(bytes))files[name]={url:'../releases/1.0/'+name,size:Buffer.byteLength(body),sha256:await hash(body)};
 const manifest={schema_version:2,id:'test-game',version:'1.0',runtime:'web',entrypoint:'play.html',artwork:'cover.png',files};
 return {bytes,manifest};
}
function memoryMetadata(){
 const records=new Map();return {
 async list(){return structuredClone([...records.values()]);},async get(id){return structuredClone(records.get(id)||{id,generation:0,active:null,releases:[]});},
 async change(id,generation,fn){const current=await this.get(id);if(generation!==undefined&&current.generation!==generation)throw Error('Game changed during installation');const next=fn(current);records.set(id,structuredClone(next));return next;}
 };
}
function memoryCaches(){const caches=new Map();return {async open(name){if(!caches.has(name))caches.set(name,new Map());const c=caches.get(name);return {async put(k,v){c.set(String(k),v.clone());},async match(k){return c.get(String(k))?.clone();},async addAll(){throw Error('not used');}};},async delete(name){return caches.delete(name);},async keys(){return [...caches.keys()];}};}
async function setup(){
 const {manifest,bytes}=await fixture(),metadata=memoryMetadata(),caches=memoryCaches();let broken=false,gate=null;const requests=[];
 const fetch=async url=>{requests.push(url);if(gate)await gate;if(url===origin+'/catalog')return Response.json([{id:manifest.id,title:'Test game',manifest_url:manifestURL,artwork:'https://games.test/cover.png'}]);if(url===manifestURL)return Response.json(manifest);const name=new URL(url).pathname.split('/').pop();return new Response(broken?'bad':bytes[name],{status:bytes[name]===undefined?404:200});};
 const options={origin,fetch,metadata,caches,crypto:webcrypto};return {options,manifest,bytes,metadata,caches,requests,bridge:createBridge(options),breakDownloads(){broken=true;},blockDownloads(promise){gate=promise;}};
}
test('resolves portable manifest paths and rejects ambiguous or unsafe assets',async()=>{
 const {manifest}=await fixture();assert.equal(validateRelease(manifest,'test-game',manifestURL).files['game.js'].url,'https://games.test/releases/1.0/game.js');
 for(const mutate of [m=>m.files['../oops']=m.files['game.js'],m=>m.files['game.js'].url='//evil.test/x',m=>m.files['game.js'].url='http://evil.test/x',m=>m.artwork='absent.png',m=>m.files['game.js'].size=-1,m=>m.id='other',m=>m.files['%2e%2e/x']=m.files['game.js']]){const invalid=structuredClone(manifest);mutate(invalid);assert.throws(()=>validateRelease(invalid,'test-game',manifestURL));}
});
test('downloads verified files, persists active Library and serves only owned installed paths',async()=>{
 const s=await setup(),states=[];s.bridge.onInstallState(value=>states.push(value));await s.bridge.catalog();await s.bridge.install('test-game');
 const [game]=await s.bridge.library();assert.match(game.entrypoint,/^\/__cubby_games__\/test-game\/[a-f0-9]+\/play.html$/);assert.equal(game.version,'1.0');
 const fresh=createBridge(s.options);assert.deepEqual(await fresh.library(),[game]);
 const response=await installedResponse(new Request(origin+game.entrypoint),s.options);const served=await response.text();assert.match(served,/data-handheld-system/);assert.ok(served.indexOf('/runtime/core/host-osd.js')<served.indexOf('game.js'));
 let raw;for(const name of await s.options.caches.keys()){raw=await(await s.options.caches.open(name)).match(origin+game.entrypoint);if(raw)break;}assert.ok(raw);assert.equal(await raw.text(),s.bytes['play.html']);assert.match(response.headers.get('content-type'),/text\/html/);
 assert.equal((await installedResponse(new Request(origin+game.entrypoint.replace('play.html','missing.js')),s.options)).status,404);
 assert.equal((await installedResponse(new Request(origin+game.entrypoint.replace('test-game','other-game')),s.options)).status,404);
 const partial=await installedResponse(new Request(origin+game.entrypoint,{headers:{range:'bytes=1-4'}}),s.options);assert.equal(partial.status,206);assert.equal(await partial.text(),served.slice(1,5));
 const suffix=await installedResponse(new Request(origin+game.entrypoint,{headers:{range:'bytes=-4'}}),s.options);assert.equal(await suffix.text(),served.slice(-4));
 assert.equal((await installedResponse(new Request(origin+game.entrypoint,{headers:{range:'bytes=999-'}}),s.options)).status,416);
 assert.equal(states.at(-1)['test-game'].phase,'installed');
});
test('same version cannot change inventory, but download locations are not identity',async()=>{
 const s=await setup();await s.bridge.catalog();await s.bridge.install('test-game');
 s.manifest.files['game.js'].sha256='0'.repeat(64);await assert.rejects(s.bridge.install('test-game'),/Immutable release conflict/);
 assert.equal((await s.bridge.library())[0].version,'1.0');
});
test('retained historical versions cannot be rewritten after an update',async()=>{
 const s=await setup();await s.bridge.catalog();await s.bridge.install('test-game');
 s.manifest.version='1.1';await s.bridge.install('test-game');const before=await s.bridge.library();
 s.manifest.version='1.0';s.bytes['game.js']='window.changed=true;';
 s.manifest.files['game.js'].size=Buffer.byteLength(s.bytes['game.js']);s.manifest.files['game.js'].sha256=await hash(s.bytes['game.js']);
 await assert.rejects(s.bridge.install('test-game'),/Immutable release conflict/);
 assert.deepEqual(await s.bridge.library(),before);
 s.bytes['game.js']='window.game=true;';s.manifest.files['game.js'].size=Buffer.byteLength(s.bytes['game.js']);s.manifest.files['game.js'].sha256=await hash(s.bytes['game.js']);
 await s.bridge.install('test-game');assert.equal((await s.bridge.library())[0].version,'1.0');
});
test('bad bytes and quota failure cannot replace an active release',async()=>{
 const s=await setup();await s.bridge.catalog();await s.bridge.install('test-game');const before=await s.bridge.library();s.manifest.version='1.1';s.breakDownloads();await assert.rejects(s.bridge.install('test-game'),/checksum|size/);assert.deepEqual(await s.bridge.library(),before);
 assert.equal((await s.caches.keys()).filter(n=>n.startsWith('cubby-game-')).length,1);
 const original=s.caches.open;s.caches.open=async name=>{if(name.startsWith('cubby-game-'))return {put:async()=>{throw Error('QuotaExceededError');}};return original(name);};
 await assert.rejects(s.bridge.install('test-game'));assert.deepEqual(await s.bridge.library(),before);
});
test('uninstall removes all managed releases, leaves external storage alone, and permits reinstall',async()=>{
 const s=await setup();await s.bridge.catalog();await s.bridge.install('test-game');const first=(await s.bridge.library())[0];s.manifest.version='1.1';await s.bridge.install('test-game');
 assert.equal((await s.caches.keys()).filter(n=>n.startsWith('cubby-game-')).length,2);await s.bridge.uninstall('test-game');assert.deepEqual(await s.bridge.library(),[]);
 assert.equal((await s.caches.keys()).filter(n=>n.startsWith('cubby-game-')).length,0);assert.equal((await installedResponse(new Request(origin+first.entrypoint),s.options)).status,404);
 await s.bridge.install('test-game');assert.equal((await s.bridge.library()).length,1);
});
test('multi-tab removal wins over an in-flight install and duplicate calls share one job',async()=>{
 const s=await setup();await s.bridge.catalog();await s.bridge.install('test-game');let release;const gate=new Promise(resolve=>release=resolve);s.blockDownloads(gate);s.manifest.version='1.1';
 const install=s.bridge.install('test-game');assert.equal(install,s.bridge.install('test-game'));await new Promise(resolve=>setImmediate(resolve));
 const other=createBridge(s.options);await other.uninstall('test-game');release();await assert.rejects(install,/changed during installation/);assert.deepEqual(await s.bridge.library(),[]);
});
test('catalog is discovery-only, cached for offline use and malformed entries never install',async()=>{
 const s=await setup();await s.bridge.catalog();assert.equal(s.requests.filter(url=>url===manifestURL).length,0);
 const offline=createBridge({...s.options,fetch:async()=>{throw Error('offline');}});assert.equal((await offline.catalog())[0].id,'test-game');
 await assert.rejects(s.bridge.install('../game'));await assert.rejects(s.bridge.install('not-offered'));
});
test('automatic checks update only installed offers, share a check and preserve old session URLs',async()=>{
 const s=await setup();await s.bridge.checkUpdates();assert.equal(s.requests.includes(manifestURL),false);
 await s.bridge.install('test-game');const first=(await s.bridge.library())[0];s.manifest.version='1.1';
 const check=s.bridge.checkUpdates();assert.equal(check,s.bridge.checkUpdates());await check;
 assert.equal((await s.bridge.library())[0].version,'1.1');
 assert.match(await(await installedResponse(new Request(origin+first.entrypoint),s.options)).text(),/game.js/);
});
test('unchanged checks fetch metadata only, including relocated download URLs',async()=>{
 const s=await setup();await s.bridge.install('test-game');const first=await s.bridge.library(),keys=await s.caches.keys();s.requests.length=0;
 for(const file of Object.values(s.manifest.files))file.url='https://elsewhere.test/'+new URL(file.url,manifestURL).pathname.split('/').pop();
 await s.bridge.checkUpdates();assert.deepEqual(await s.bridge.library(),first);assert.deepEqual(await s.caches.keys(),keys);
 assert.deepEqual(s.requests.sort(),[origin+'/catalog',manifestURL].sort());
});
test('failed background check retains active release and retries later',async()=>{
 const s=await setup();await s.bridge.install('test-game');const first=await s.bridge.library();s.manifest.version='1.1';s.breakDownloads();
 await s.bridge.checkUpdates();assert.deepEqual(await s.bridge.library(),first);
 const offline=createBridge({...s.options,fetch:async()=>{throw Error('offline');}});await offline.checkUpdates();assert.deepEqual(await offline.library(),first);
});
test('unlisted installed games are not checked',async()=>{
 const s=await setup();await s.bridge.install('test-game');const requests=[];
 const bridge=createBridge({...s.options,fetch:async url=>{requests.push(url);return Response.json([]);}});
 await bridge.checkUpdates();assert.deepEqual(requests,[origin+'/catalog']);assert.equal((await bridge.library()).length,1);
});
test('a check cannot resurrect a game uninstalled while catalog discovery was pending',async()=>{
 const s=await setup();await s.bridge.install('test-game');let release;const gate=new Promise(resolve=>release=resolve);
 const bridge=createBridge({...s.options,fetch:async(url,options)=>{if(url===origin+'/catalog')await gate;return s.options.fetch(url,options);}});
 const check=bridge.checkUpdates();await new Promise(resolve=>setImmediate(resolve));await s.bridge.uninstall('test-game');release();await check;
 assert.deepEqual(await bridge.library(),[]);
});
test('aborted background work never commits even if fetch ignores its signal',async()=>{
 const s=await setup();await s.bridge.install('test-game');const first=await s.bridge.library();s.manifest.version='1.1';let release;const gate=new Promise(resolve=>release=resolve);s.blockDownloads(gate);
 const controller=new AbortController(),check=s.bridge.checkUpdates({signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();release();await check;
 assert.deepEqual(await s.bridge.library(),first);assert.equal((await s.caches.keys()).filter(name=>name.startsWith('cubby-game-')).length,1);
});
test('cancellation during IndexedDB commit preparation leaves the old release active',async()=>{
 const s=await setup();await s.bridge.install('test-game');const first=await s.bridge.library();s.manifest.version='1.1';
 const controller=new AbortController(),change=s.metadata.change.bind(s.metadata);
 s.metadata.change=async(id,generation,update)=>{controller.abort();return change(id,generation,update);};
 await s.bridge.checkUpdates({signal:controller.signal});assert.deepEqual(await s.bridge.library(),first);
 assert.equal((await s.caches.keys()).filter(name=>name.startsWith('cubby-game-')).length,1);
});
test('background update detects multi-tab removal after fetching starts',async()=>{
 const s=await setup();await s.bridge.install('test-game');s.manifest.version='1.1';let release,reached;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>reached=resolve);
 const updater=createBridge({...s.options,fetch:async(url,options)=>{if(url===manifestURL){reached();await gate;}return s.options.fetch(url,options);}});
 const check=updater.checkUpdates();await started;await s.bridge.uninstall('test-game');release();await check;
 assert.deepEqual(await updater.library(),[]);assert.equal((await s.caches.keys()).filter(name=>name.startsWith('cubby-game-')).length,0);
});

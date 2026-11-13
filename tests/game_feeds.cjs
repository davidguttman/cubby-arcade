const test=require('node:test'),assert=require('node:assert/strict');
const Feeds=require('../runtime/core/game-feeds.js');
test('optional media derivatives preserve descriptors and reject unbounded or invalid metadata',()=>{
 const item={url:'https://cdn.example/cover.jpg',size:9000,sha256:'a'.repeat(64),source_sha256:'b'.repeat(64)},offer={id:'demo',title:'Demo',manifest_url:'https://game.example/manifest.json',artwork:'https://game.example/cover.png',media:{thumbnail:item}};
 assert.deepEqual(Feeds.validateEntries([offer]),[offer]);
 for(const media of [[],{bad:item},{thumbnail:{...item,size:true}},{thumbnail:{...item,size:65537}},{thumbnail:{...item,sha256:'bad'}},{thumbnail:{...item,url:'http://cdn.example/a.jpg'}},{thumbnail:{...item,source_sha256:null}}])assert.throws(()=>Feeds.validateEntries([{...offer,media}]));
});
const A='https://cubby.david.app/catalog',B='https://other.example/catalog';
const config=feeds=>({schema:1,feeds});
const feed=(url,name='Feed',enabled=true)=>({url,name,enabled});
const game=(id,host='games.example')=>({id,title:id,manifest_url:`https://${host}/${id}/manifest.json`,artwork:`https://${host}/${id}/cover.png`});
const cache=(...entries)=>Object.fromEntries(entries);
function memory(initial){let value=initial;const writes=[];return {read:async()=>structuredClone(value),write:async next=>{value=structuredClone(next);writes.push(value);},writes,value:()=>structuredClone(value)};}

test('absent configuration migrates to Cubby; explicit empty feeds stays empty',()=>{
 assert.deepEqual(Feeds.defaultConfig(),config([feed(A,'Cubby Arcade'),feed(Feeds.BETA_URL,'Cubby Beta',false)]));
 assert.deepEqual(Feeds.validateConfig(config([])),config([]));
 const first=Feeds.defaultConfig();first.feeds[0].name='Changed';assert.equal(Feeds.defaultConfig().feeds[0].name,'Cubby Arcade');
});
test('canonical HTTPS URLs reject unsafe inputs and duplicate identities',()=>{
 assert.equal(Feeds.feedURL('https://EXAMPLE.com:443/catalog'),'https://example.com/catalog');
 for(const url of ['http://example.com/catalog','file:///tmp/feed','https://user:pass@example.com/catalog','https://example.com/catalog#part',' https://example.com/catalog','https://example.com/\\x','https://example.com/%00','https://example.com/%ZZ'])assert.throws(()=>Feeds.feedURL(url),url);
 assert.throws(()=>Feeds.validateConfig(config([feed('https://EXAMPLE.com:443/catalog'),feed('https://example.com/catalog')])));
 for(const bad of [null,[],{},config([feed(A,'')]),config([feed(A,'a'.repeat(121))]),config([{url:A,name:'Test',enabled:1}]),{schema:2,feeds:[]}])assert.throws(()=>Feeds.validateConfig(bad));
});
test('merging preserves enabled feed/game order, deduplicates IDs and owns source metadata',()=>{
 const x=game('x'),y=game('y'),z=game('z');x._source={feed_url:'https://wrong.example/catalog'};
 const entries=Feeds.mergeCatalog(config([feed(A),feed(B)]),cache([A,[x,y]],[B,[game('x','second.example'),z]]));
 assert.deepEqual(entries.map(e=>e.id),['x','y','z']);assert.deepEqual(entries[0]._source,{feed_url:A,manifest_url:x.manifest_url});
 assert.deepEqual(Feeds.mergeCatalog(config([feed(A,'Feed',false),feed(B)]),cache([A,[x]],[B,[z]])).map(e=>e.id),['z']);
 entries[0].title='mutated';assert.equal(x.title,'x');
});
test('updates require pinned enabled source and manifest, not winning discovery offer',()=>{
 const original=game('x'),other=game('x','other.example'),settings=config([feed(B),feed(A)]),entries=cache([A,[original]],[B,[other]]),source={feed_url:A,manifest_url:original.manifest_url};
 assert.equal(Feeds.mergeCatalog(settings,entries)[0].manifest_url,other.manifest_url);
 assert.equal(Feeds.updateOffer('x',source,settings,entries).manifest_url,original.manifest_url);
 assert.equal(Feeds.updateOffer('x',source,config([feed(B),feed(A,'Feed',false)]),entries),null);
 assert.equal(Feeds.updateOffer('x',source,config([feed(B)]),entries),null);
 assert.equal(Feeds.updateOffer('x',source,settings,cache([A,[game('x','changed.example')]])),null);
 assert.equal(Feeds.updateOffer('x',null,settings,entries),null);
});
test('legacy ownership only comes from the built-in feed, never a collision winner',()=>{
 const original=game('x');const entries=cache([A,[original]],[B,[game('x','other.example'),game('y')]]);
 assert.deepEqual(Feeds.legacySource('x',entries),{feed_url:A,manifest_url:original.manifest_url});
 assert.equal(Feeds.legacySource('y',entries),null);
});
test('manager loads defaults, refreshes feeds independently and keeps only validated last-good data',async()=>{
 const disk=memory();let failA=false,failB=false;const calls=[];
 const manager=Feeds.createManager({...disk,fetchCatalog:async url=>{calls.push(url);if(url===A&&failA)throw Error('offline');if(url===B&&failB)return 'invalid';return [game(url===A?'x':'y')];},validateCatalog:entries=>{if(!Array.isArray(entries))throw Error('invalid');return entries;}});
 assert.deepEqual(await manager.config(),Feeds.defaultConfig());
 await manager.setConfig(config([feed(A),feed(B)]));assert.deepEqual((await manager.catalog()).map(e=>e.id),['x','y']);
 failA=true;failB=true;assert.deepEqual((await manager.catalog()).map(e=>e.id),['x','y']);
 await manager.setConfig(config([feed(A,'Feed',false),feed(B)]));calls.length=0;
 assert.deepEqual((await manager.catalog()).map(e=>e.id),['y']);assert.deepEqual(calls,[B]);
 const reloaded=Feeds.createManager({...disk,fetchCatalog:async()=>{throw Error('offline');}});
 assert.deepEqual((await reloaded.catalog()).map(e=>e.id),['y']);
});
test('a first-run failed feed does not hide healthy offers or create cached junk',async()=>{
 const disk=memory(),manager=Feeds.createManager({...disk,fetchCatalog:async url=>{if(url===A)throw Error('offline');return [game('y')];}});
 await manager.setConfig(config([feed(A),feed(B)]));assert.deepEqual((await manager.catalog()).map(e=>e.id),['y']);
 assert.equal(Object.hasOwn(disk.value().cache,A),false);
});
test('pin persists original source; disabling/removing preserves ownership; forget affects only ownership',async()=>{
 const disk=memory(),original=game('x'),manager=Feeds.createManager({...disk,fetchCatalog:async url=>[url===A?original:game('x','other.example')]});
 await manager.setConfig(config([feed(A),feed(B)]));const [offer]=await manager.catalog();await manager.pin('x',offer);
 await manager.setConfig(config([feed(B),feed(A)]));await manager.catalog();assert.equal((await manager.updateOffer('x')).manifest_url,original.manifest_url);
 await manager.setConfig(config([feed(B)]));assert.equal(await manager.updateOffer('x'),null);assert.deepEqual(disk.value().sources.x,Feeds.sourceOf(offer));
 await manager.forget('x');assert.equal(disk.value().sources.x,undefined);assert.ok(disk.value().cache[A]);
});
test('legacy migration persists only safe default sources once',async()=>{
 const disk=memory(),manager=Feeds.createManager({...disk,fetchCatalog:async url=>url===A?[game('x')]:[game('x','other.example'),game('y')]});
 await manager.setConfig(config([feed(B),feed(A)]));await manager.catalog();await manager.migrateInstalled(['x','y']);
 assert.deepEqual(disk.value().sources.x,{feed_url:A,manifest_url:game('x').manifest_url});assert.equal(disk.value().sources.y,undefined);
 await manager.setConfig(config([feed(B)]));await manager.migrateInstalled(['x']);assert.equal(disk.value().sources.x.feed_url,A);
});
test('legacy migration rechecks cached ownership after queued catalog refreshes',async()=>{
 const disk=memory({schema:1,config:Feeds.defaultConfig(),cache:{[A]:[game('x')]},sources:{}});
 let finishFetch,fetchStarted,finishWrite,writeStarted;
 const fetching=new Promise(resolve=>fetchStarted=resolve),writing=new Promise(resolve=>writeStarted=resolve);
 const manager=Feeds.createManager({...disk,
  fetchCatalog:()=>new Promise(resolve=>{finishFetch=resolve;fetchStarted();}),
  write:async next=>{if(!finishWrite){await new Promise(resolve=>{finishWrite=resolve;writeStarted();});}await disk.write(next);}
 });
 const refresh=manager.catalog();await fetching;
 const settings=manager.setConfig(Feeds.defaultConfig());await writing;
 const migration=manager.migrateInstalled(['x']);
 finishFetch([]);
 // Let the refresh queue its cache mutation behind the blocked settings write,
 // while migration is still waiting to inspect that write's published state.
 await new Promise(resolve=>setImmediate(resolve));finishWrite();
 await Promise.all([settings,refresh,migration]);
 const reloaded=Feeds.createManager({...disk,fetchCatalog:async()=>[]});
 assert.deepEqual(await reloaded.config(),Feeds.defaultConfig());
 assert.equal(await reloaded.source('x'),null);
 assert.equal(Object.hasOwn(disk.value().sources,'x'),false);
});
test('configuration changes while fetching never resurrect removed feed offers',async()=>{
 const disk=memory();let finish,started;const ready=new Promise(resolve=>started=resolve);
 const manager=Feeds.createManager({...disk,fetchCatalog:()=>new Promise(resolve=>{finish=resolve;started();})});
 const pending=manager.catalog();await ready;await manager.setConfig(config([]));finish([game('x')]);assert.deepEqual(await pending,[]);assert.deepEqual(await manager.config(),config([]));
});
test('abort is propagated rather than converted into a cached successful refresh',async()=>{
 const disk=memory(),controller=new AbortController(),manager=Feeds.createManager({...disk,fetchCatalog:async()=>{controller.abort();throw Error('aborted');}});
 await assert.rejects(manager.catalog({signal:controller.signal}),{name:'AbortError'});
 assert.equal(disk.writes.length,0);
});
test('failed persistence is reported and does not replace live settings',async()=>{
 const manager=Feeds.createManager({read:async()=>undefined,write:async()=>{throw Error('disk full');},fetchCatalog:async()=>[]});
 await assert.rejects(manager.setConfig(config([])),/disk full/);assert.deepEqual(await manager.config(),Feeds.defaultConfig());
});
test('game IDs cannot be coerced and prototype names never imply source ownership',async()=>{
 assert.throws(()=>Feeds.validateEntries([game(123)]));
 const disk=memory(),manager=Feeds.createManager({...disk,fetchCatalog:async()=>[game('constructor')]});
 await assert.rejects(manager.forget(null),/Invalid game id/);
 assert.equal(await manager.source('constructor'),null);assert.equal(await manager.updateOffer('constructor'),null);
 const [offer]=await manager.catalog();await manager.pin('constructor',offer);
 assert.equal((await manager.updateOffer('constructor')).id,'constructor');await manager.forget('constructor');assert.equal(await manager.source('constructor'),null);
});
test('an existing pin cannot be reassigned by a later install or altered source metadata',async()=>{
 const disk=memory(),manager=Feeds.createManager({...disk,fetchCatalog:async url=>[game('x',url===A?'first.example':'second.example')]});
 await manager.setConfig(config([feed(A),feed(B)]));const [first]=await manager.catalog();await manager.pin('x',first);
 await manager.setConfig(config([feed(B),feed(A)]));const [second]=await manager.catalog();await assert.rejects(manager.pin('x',second),/another source/);
 await assert.rejects(manager.pin('x',{...second,_source:{...second._source,manifest_url:first.manifest_url}}),/does not match/);
 assert.equal((await manager.source('x')).feed_url,A);
});
test('invalid cached catalogs are discarded while trusted source pins remain intact',async()=>{
 const disk=memory({schema:1,config:Feeds.defaultConfig(),cache:{[A]:[{id:'x'}]},sources:{x:{feed_url:A,manifest_url:game('x').manifest_url}}});
 const manager=Feeds.createManager({...disk,fetchCatalog:async()=>{throw Error('offline');}});
 assert.deepEqual(await manager.catalog(),[]);assert.equal((await manager.source('x')).feed_url,A);assert.equal(await manager.updateOffer('x'),null);
});
test('issued install offers stay pinnable when refresh removes or changes their catalog entry',async()=>{
 for(const replacement of [[],[game('x','changed.example')]]){
  const disk=memory();let entries=[game('x')];
  const manager=Feeds.createManager({...disk,fetchCatalog:async()=>entries});
  const [installOffer]=await manager.catalog();entries=replacement;await manager.catalog();
  await manager.setConfig(config([]));await manager.pin('x',installOffer);
  assert.deepEqual(await manager.source('x'),Feeds.sourceOf(installOffer));
  assert.equal(await manager.updateOffer('x'),null);
 }
});
test('only unaltered source identities issued by this manager authorize pinning',async()=>{
 const disk=memory(),manager=Feeds.createManager({...disk,fetchCatalog:async()=>[game('x'),game('y')]});
 const [offer]=await manager.catalog();
 await assert.rejects(manager.pin('x',structuredClone(offer)),/not offered/);
 const other=Feeds.createManager({...memory(),fetchCatalog:async()=>[game('x')]});
 const [foreign]=await other.catalog();await assert.rejects(manager.pin('x',foreign),/not offered/);
 offer._source.feed_url=B;await assert.rejects(manager.pin('x',offer),/not offered/);offer._source.feed_url=A;
 // Even a source copied from another genuine catalog offer is not this offer.
 offer.id='y';offer.manifest_url=game('y').manifest_url;offer._source.manifest_url=offer.manifest_url;
 await assert.rejects(manager.pin('y',offer),/not offered/);
 assert.equal(await manager.source('x'),null);assert.equal(await manager.source('y'),null);
});
test('update offers also carry install provenance across later refreshes',async()=>{
 const disk=memory();let entries=[game('x')];
 const manager=Feeds.createManager({...disk,fetchCatalog:async()=>entries});
 const [first]=await manager.catalog();await manager.pin('x',first);
 const update=await manager.updateOffer('x');entries=[];await manager.catalog();
 await manager.pin('x',update);assert.deepEqual(await manager.source('x'),Feeds.sourceOf(first));
});
test('first catalog caller cancellation never cancels a concurrent caller or shared refresh',async()=>{
 const disk=memory(),controller=new AbortController();let finish,started,calls=0;
 const ready=new Promise(resolve=>started=resolve);
 const manager=Feeds.createManager({...disk,fetchCatalog:(_url,{signal})=>new Promise((resolve,reject)=>{
  calls++;finish=resolve;started();signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});
 })});
 const first=manager.catalog({signal:controller.signal});await ready;
 const second=manager.catalog();const rejected=assert.rejects(first,{name:'AbortError'});
 controller.abort();finish([game('x')]);await rejected;
 assert.deepEqual((await second).map(entry=>entry.id),['x']);assert.equal(calls,1);
 assert.deepEqual(disk.value().cache[A],[game('x')]);
});
test('cancellation settles one caller promptly without releasing ongoing shared work',async()=>{
 const disk=memory(),controller=new AbortController();let finish,started,calls=0;
 const ready=new Promise(resolve=>started=resolve);
 const manager=Feeds.createManager({...disk,fetchCatalog:()=>new Promise(resolve=>{calls++;finish=resolve;started();})});
 const first=manager.catalog({signal:controller.signal});await ready;
 const rejected=assert.rejects(first,{name:'AbortError'});controller.abort();
 // A stuck caller must not keep its UI waiting for unrelated bounded IO.
 let timer;
 try{await Promise.race([rejected,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Abort did not settle promptly')),100);})]);}
 finally{clearTimeout(timer);}
 const second=manager.catalog();finish([game('x')]);await second;assert.equal(calls,1);
});
test('transient feed status distinguishes successful loads, cached failures, first failures and disabled feeds',async()=>{
 const disk=memory(null);let fail=false;
 const manager=Feeds.createManager({...disk,fetchCatalog:async url=>{if(url===B||fail)throw Error('Failed to fetch');return [game('x')];}});
 await manager.setConfig(config([feed(A),feed(B)]));await manager.catalog();
 assert.deepEqual(await manager.status(),{[A]:{state:'loaded',count:1},[B]:{state:'unavailable',count:0,error:'Failed to fetch'}});
 fail=true;await manager.catalog();assert.deepEqual((await manager.status())[A],{state:'cached',count:1,error:'Failed to fetch'});
 const reload=Feeds.createManager({...disk,fetchCatalog:async()=>[]});assert.deepEqual((await reload.status())[A],{state:'cached',count:1});
 await manager.setConfig(config([feed(A,'Off',false)]));assert.deepEqual(await manager.status(),{[A]:{state:'disabled',count:1}});
 assert.equal(disk.value().status,undefined);
});

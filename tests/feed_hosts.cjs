// Exercise selected-source bytes through the actual storage/install adapters and
// actual native preload, not a policy-only fake bridge.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {webcrypto,createHash}=require('node:crypto');
const {createPlatform}=require('../runtime/core/platform.js'),{sweepGameUpdates}=require('../runtime/core/hub.js');
const {DEFAULT_URL}=require('../runtime/core/game-feeds.js'),{createBridge}=require('../runtime/core/browser-store.js');
const {FeedIO}=require('../desktop/feeds.cjs'),{GameLibrary}=require('../desktop/host.cjs'),{GameInstaller}=require('../desktop/installer.cjs');
const custom='https://other.test/catalog',origin='https://cubby.test';
const hash=b=>createHash('sha256').update(b).digest('hex');
function documents(){
 const docs=new Map(),requests=[];
 function publish(host,version){
  const payload={'play.html':host+' '+version,'art.svg':'<svg/>'},files={};
  for(const [name,body] of Object.entries(payload)){const url='https://'+host+'/'+version+'/'+name;docs.set(url,body);files[name]={url,size:Buffer.byteLength(body),sha256:hash(body)};}
  docs.set('https://'+host+'/manifest.json',JSON.stringify({schema_version:2,id:'demo',version,runtime:'web',entrypoint:'play.html',artwork:'art.svg',files}));
 }
 const offer=host=>({id:'demo',title:host,manifest_url:'https://'+host+'/manifest.json',artwork:'https://'+host+'/art.svg'});
 docs.set(DEFAULT_URL,JSON.stringify([offer('first.test')]));docs.set(custom,JSON.stringify([offer('other.test')]));publish('first.test','1');publish('other.test','1');
 const fetch=async(url,options={})=>{url=String(url);requests.push(url);assert.equal(options.redirect,'error');assert(options.signal,'adapter owns a timeout');const body=docs.get(url);if(body===undefined)throw Error('offline');return new Response(body);};
 return {docs,requests,publish,fetch};
}
function browserStorage(){
 const records=new Map(),cacheMap=new Map();
 const metadata={list:async()=>structuredClone([...records.values()]),get:async id=>structuredClone(records.get(id)||{id,generation:0,active:null,releases:[]}),async change(id,generation,fn){const before=await this.get(id);if(generation!==undefined&&generation!==before.generation)throw Error('Game changed during installation');const next=fn(before);records.set(id,structuredClone(next));return next;}};
 const caches={async open(name){if(!cacheMap.has(name))cacheMap.set(name,new Map());const c=cacheMap.get(name);return {async put(key,value){c.set(key,value.clone());},async match(key){return c.get(key)?.clone();}};},async delete(name){return cacheMap.delete(name);}};
 return {metadata,caches};
}
const config=feeds=>({schema:1,feeds:feeds.map(([url,enabled=true])=>({url,name:url,enabled}))});
async function exercise(make,d){
 let p=createPlatform({bridge:make()});
 await p.setFeedConfig(config([[custom],[DEFAULT_URL]]));assert.equal((await p.catalog())[0].title,'other.test');await p.install('demo');assert.equal((await p.library())[0].version,'1');
 await p.setFeedConfig(config([[DEFAULT_URL],[custom]]));assert.equal((await p.catalog())[0].title,'first.test');await assert.rejects(p.install('demo'),/source/);
 d.publish('other.test','2');d.requests.length=0;await sweepGameUpdates(p);assert.equal((await p.library())[0].version,'2');assert(d.requests.includes('https://other.test/manifest.json'));assert(!d.requests.includes('https://first.test/manifest.json'));
 // Recreate real adapter+platform: disk/browser raw state retains source despite reorder.
 p=createPlatform({bridge:make()});d.publish('other.test','3');await sweepGameUpdates(p);assert.equal((await p.library())[0].version,'3');
 await p.setFeedConfig(config([[DEFAULT_URL],[custom,false]]));d.publish('other.test','4');await sweepGameUpdates(p);assert.deepEqual(await p.library(),[]);assert.equal((await make().library())[0].version,'3');
 await p.setFeedConfig(config([[DEFAULT_URL]]));await sweepGameUpdates(p);assert.deepEqual(await p.library(),[]);assert.equal((await make().library())[0].version,'3');
 await p.useProfile('p_kid');assert.deepEqual((await p.feedConfig()).feeds.filter(feed=>feed.enabled).map(feed=>feed.url),[DEFAULT_URL]);assert.deepEqual(await p.library(),[]);await p.useProfile('p_first');
 // A failed feed must not erase its independent last-good catalog.
 await p.setFeedConfig(config([[custom],[DEFAULT_URL]]));d.docs.delete(custom);assert.equal((await p.catalog())[0].title,'other.test');
 await p.uninstall('demo');await p.setFeedConfig(config([[DEFAULT_URL]]));await p.catalog();await p.install('demo');assert.equal((await p.library())[0].version,'1');
}
test('browser real bytes follow source pins across collision, restart, disable and removal',async()=>{
 const d=documents(),storage=browserStorage();await exercise(()=>createBridge({...storage,origin,fetch:d.fetch,crypto:webcrypto}),d);
});
test('desktop real preload/FeedIO/installer follow selected sources and reject unchecked URLs',async t=>{
 const d=documents(),root=fs.mkdtempSync(path.join(os.tmpdir(),'cubby-feed-host-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const site=path.join(root,'web');fs.mkdirSync(site);fs.writeFileSync(path.join(site,'library'),'[]');const library=new GameLibrary(site,path.join(root,'games'));
 const installer=new GameInstaller(library,{fetch:d.fetch});
 function make(){
  const io=new FeedIO(path.join(root,'feeds.json'),{fetch:d.fetch});let exposed;
  const invoke=async(channel,...args)=>{
   if(channel==='hub:feeds-read')return io.read();if(channel==='hub:feeds-write')return io.write(args[0]);if(channel==='hub:feeds-fetch')return io.catalog(args[0]);
   if(channel==='hub:profile')return;
   if(channel==='hub:library')return library.entries();if(channel==='hub:uninstall')return installer.uninstall(args[0]);
   assert(['hub:install','hub:update'].includes(channel));const [id,{offer}]=args;
   if(channel==='hub:update'&&!library.entries().some(game=>game.id===id))return;
   return installer.install(id,{offer:io.offer(id,offer)});
  };
  const load=Module._load;Module._load=function(name,...rest){return name==='electron'?{contextBridge:{exposeInMainWorld(_key,value){exposed=value;}},ipcRenderer:{invoke,on(){},removeListener(){}}}:load.call(this,name,...rest);};
  try{delete require.cache[require.resolve('../desktop/preload.cjs')];require('../desktop/preload.cjs');}finally{Module._load=load;}
  return exposed.bridge;
 }
 await exercise(make,d);
 const io=new FeedIO(path.join(root,'feeds.json'),{fetch:d.fetch});await io.read();
 const offer={id:'demo',title:'Bad',manifest_url:'https://unchecked.test/m.json',artwork:'https://a.test/a.png',_source:{feed_url:DEFAULT_URL,manifest_url:'https://unchecked.test/m.json'}};
 assert.throws(()=>io.offer('demo',offer),/source/);await assert.rejects(io.catalog('http://a.test/catalog'),/HTTPS/);
});

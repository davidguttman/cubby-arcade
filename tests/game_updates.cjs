// Game updates are one piece of shared core code. Every host below is the real bridge it
// ships with, so a host that can install but doesn't update fails here.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),Module=require('node:module');
const {startGameUpdates,sweepGameUpdates}=require('../runtime/core/hub.js');
const {createPlatform}=require('../runtime/core/platform.js');
const {createBridge}=require('../runtime/core/browser-store.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const installed=[{id:'installed-game'},{id:'other-installed'},{id:'unlisted-game'}];
const offers=[{id:'installed-game',manifest_url:'https://a.test/m.json'},{id:'other-installed',manifest_url:'https://b.test/m.json'},{id:'not-installed',manifest_url:'https://c.test/m.json'}];
for(const offer of offers){offer.title=offer.id;offer.artwork='https://a.test/art.png';}
const wanted=['installed-game','other-installed'];
function target(){const listeners=new Map();return {addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},emit(name){for(const fn of [...listeners.get(name)||[]])fn();},count(){return [...listeners.values()].reduce((n,set)=>n+set.size,0);}};}
function hub(){const document={...target(),hidden:false},timers=new Map();let next=0;const win={...target(),document,AbortController,setInterval(fn,ms){assert.equal(ms,300000);timers.set(++next,fn);return next;},clearInterval(id){timers.delete(id);}};return {win,tick(){for(const fn of timers.values())fn();},timerCount:()=>timers.size};}
function platform(update){return {library:async()=>installed,catalog:async()=>offers,update};}

test('a sweep updates exactly the installed games the catalog offers, one at a time',async()=>{
 const calls=[];let active=0,most=0;
 await sweepGameUpdates(platform(async id=>{calls.push(id);most=Math.max(most,++active);await settle();active--;}));
 assert.deepEqual(calls,wanted);assert.equal(most,1);
});
test('one failed update leaves the rest to run, and an unreachable catalog is not fatal to the hub',async()=>{
 const calls=[];await sweepGameUpdates(platform(async id=>{calls.push(id);throw Error('offline');}));assert.deepEqual(calls,wanted);
 const s=hub();const updates=startGameUpdates(s.win,{library:async()=>installed,catalog:async()=>{throw Error('offline');},update:async()=>assert.fail('nothing to update')});
 await updates.idle();updates.stop();
});
test('checks run on hub entry, every five minutes, on return and on reconnect, whatever the browser claims',async()=>{
 const s=hub();let sweeps=0;const updates=startGameUpdates(s.win,{library:async()=>{sweeps++;return [];},catalog:async()=>[],update:async()=>{}});
 await settle();assert.equal(sweeps,1);
 s.tick();await settle();assert.equal(sweeps,2);
 // A kiosk browser that reports itself hidden or offline must not silently stop updates.
 s.win.document.hidden=true;s.tick();await settle();assert.equal(sweeps,3);
 s.win.document.emit('visibilitychange');await settle();assert.equal(sweeps,3);
 s.win.document.hidden=false;s.win.document.emit('visibilitychange');await settle();assert.equal(sweeps,4);
 s.win.emit('online');await settle();assert.equal(sweeps,5);updates.stop();
});
test('overlapping triggers share a sweep, idle waits for it, and stop aborts and removes everything',async()=>{
 const s=hub();let sweeps=0,finish,signal;const gate=new Promise(resolve=>finish=resolve);
 const updates=startGameUpdates(s.win,{library:async()=>{sweeps++;return [{id:'installed-game'}];},catalog:async()=>offers,update:async(id,options)=>{signal=options.signal;await gate;}});
 await settle();s.tick();s.win.emit('online');await settle();assert.equal(sweeps,1);
 let idle=false;updates.idle().then(()=>idle=true);await settle();assert.equal(idle,false);
 updates.stop();assert.equal(signal.aborted,true);assert.equal(s.timerCount(),0);assert.equal(s.win.count()+s.win.document.count(),0);
 finish();await settle();assert.equal(idle,true);s.tick();await settle();assert.equal(sweeps,1);
});
test('a host that cannot install has nothing to update',async()=>{
 const s=hub(),updates=startGameUpdates(s.win,createPlatform({bridge:{}}));assert.equal(s.timerCount(),0);await updates.idle();updates.stop();
});
test('a brand new host gets updates from install alone',async()=>{
 const calls=[];await sweepGameUpdates(createPlatform({bridge:{library:async()=>installed,catalog:async()=>offers,install:async id=>calls.push(id)}}));
 assert.deepEqual(calls,wanted);
});
test('the handheld host updates through its real bridge',async()=>{
 const posts=[],hooks={};
 const win={CubbyDeviceToken:'token',addEventListener(){},
  async fetch(path,options={}){
   const json=value=>({ok:true,json:async()=>value});
   if(path==='/api/library')return json(installed);if(path==='/api/catalog'||path==='/api/feeds/fetch')return json(offers);
   if(path==='/api/feeds/read')return json(null);if(path==='/api/feeds/write')return json({saved:true});
   if(path==='/api/status')return json(Object.fromEntries(posts.map(id=>[id,{phase:'pending'}])));
   assert.equal(path,'/api/install');assert.equal(options.headers['X-Cubby-Session'],'token');posts.push(JSON.parse(options.body).id);return json({accepted:true});
  }};
 vm.runInNewContext(fs.readFileSync('rocknix/bridge.js','utf8'),{window:win,setTimeout,setInterval,clearInterval,JSON,Error,Set,Promise,hooks});
 await sweepGameUpdates(createPlatform(win.HandheldPlatformOptions));
 assert.deepEqual(posts,wanted);
});
test('the desktop host updates through its real preload bridge',async()=>{
 const load=Module._load;let exposed;const invoked=[];
 Module._load=function(name,...rest){return name==='electron'?{contextBridge:{exposeInMainWorld(_key,value){exposed=value;}},ipcRenderer:{invoke:async(channel,...args)=>{invoked.push([channel,...args]);if(channel==='hub:feeds-read')return null;if(channel==='hub:feeds-fetch')return offers;return [];},on(){},removeListener(){},sendSync(){return {};}}}:load.call(this,name,...rest);};
 try{delete require.cache[require.resolve('../desktop/preload.cjs')];require('../desktop/preload.cjs');}finally{Module._load=load;}
 const options={...exposed,fetch:async()=>({ok:true,json:async()=>offers})};
 options.bridge={...options.bridge,library:async()=>installed};
 await sweepGameUpdates(createPlatform(options));
 assert.deepEqual(invoked.filter(([channel])=>channel==='hub:update').map(([channel,id,options])=>[channel,id,options.offer._source.feed_url]),wanted.map(id=>['hub:update',id,'https://cubby.david.app/catalog']));
});
// tests/browser_store.cjs drives the browser host's real downloads through the same core.
test('the browser host never reinstalls a game removed before its update starts',async()=>{
 const started=[],bridge=createBridge({caches:{},crypto:{},fetch:async()=>assert.fail('stubbed below'),origin:'https://x.test',metadata:{list:async()=>[],get:async id=>{started.push(id);return {active:false,generation:0};},change:async()=>{}}});
 await bridge.update('installed-game');assert.deepEqual(started,['installed-game']);assert.deepEqual(Object.keys(await bridge.installStatus()),[]);
});
test('hub.js is the only place that schedules game updates, and every host mounts it',()=>{
 const hubSource=fs.readFileSync('runtime/core/hub.js','utf8');
 assert.match(hubSource,/const gameUpdates=startGameUpdates\(win,platform\);/);
 for(const file of ['rocknix/bridge.js','rocknix/server.py','desktop/main.cjs','desktop/installer.cjs','desktop/preload.cjs','runtime/core/browser-store.js','runtime/core/browser-bootstrap.js'])
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/checkUpdates|startUpdateChecks/,file);
 assert.match(fs.readFileSync('runtime/core/browser-bootstrap.js','utf8'),/HandheldHub\.mount\(host\)/);
 assert.match(fs.readFileSync('runtime/index.html','utf8'),/hub\.js/);
 assert.match(fs.readFileSync('rocknix/server.py','utf8'),/runtime\/index\.html/);
});

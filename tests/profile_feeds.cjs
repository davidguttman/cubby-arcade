const test=require('node:test'),assert=require('node:assert/strict');
const {createPlatform}=require('../runtime/core/platform.js'),Profiles=require('../runtime/core/profiles.js'),Feeds=require('../runtime/core/game-feeds.js');
const A=Feeds.DEFAULT_URL,B='https://cubby.david.app/beta/catalog';
const config=(beta=false)=>({schema:1,feeds:[{url:A,name:'Cubby',enabled:true},{url:B,name:'Beta',enabled:beta}]});
const game=id=>({id,title:id,manifest_url:`https://games.test/${id}/manifest.json`,artwork:`https://games.test/${id}/cover.png`});
function fixture(saved=null){let disk=saved,games=[];const writes=[],installs=[];const values=new Map([[Profiles.REGISTRY_KEY,JSON.stringify({profiles:[{id:'p_first',avatar:'fox'},{id:'p_kid',avatar:'frog'}],active:'p_first'})]]);const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};const bridge={readFeedState:async()=>structuredClone(disk),writeFeedState:async v=>{disk=structuredClone(v);writes.push(v);},fetchCatalog:async url=>[game(url===A?'stable':'early')],library:async()=>structuredClone(games),install:async(id)=>{installs.push(id);games.push(game(id));}};return {storage,bridge,writes,installs,disk:()=>disk,games};}
test('profile feed selection hides installed beta games without deleting them or leaking offers after switches/restart',async()=>{const f=fixture(),p=createPlatform(f);await p.setFeedConfig(config(true));await p.catalog();await p.install('early');assert.deepEqual((await p.library()).map(g=>g.id),['early']);await p.useProfile('p_kid');assert.deepEqual((await p.catalog()).map(g=>g.id),['stable']);assert.deepEqual(await p.library(),[]);await assert.rejects(p.install('early'),/offered/);assert.equal(f.games.length,1);await p.useProfile('p_first');assert.deepEqual((await p.library()).map(g=>g.id),['early']);await p.setFeedConfig(config(false));assert.deepEqual(await p.library(),[]);await p.setFeedConfig(config(true));assert.equal((await p.library()).length,1);const q=createPlatform(f);await q.useProfile('p_kid');assert.deepEqual(await q.library(),[]);await q.useProfile('p_first');assert.equal((await q.library()).length,1);});
test('migration snapshots legacy feed choices for existing profiles, not profiles created later',async()=>{const f=fixture({schema:1,config:{schema:1,feeds:[{url:A,name:'Stable',enabled:true},{url:'https://custom.test/catalog',name:'Custom',enabled:true}]},cache:{},sources:{}}),p=createPlatform(f);assert.equal((await p.feedConfig()).feeds.find(f=>f.name==='Custom').enabled,true);await p.useProfile('p_kid');assert.equal((await p.feedConfig()).feeds.find(f=>f.name==='Custom').enabled,true);await p.useProfile('p_new');assert.equal((await p.feedConfig()).feeds.some(f=>f.name==='Custom'),false);assert.equal((await p.feedConfig()).feeds.find(f=>f.url===B).enabled,false);const q=createPlatform(f);await q.useProfile('p_kid');assert.equal((await q.feedConfig()).feeds.find(f=>f.name==='Custom').enabled,true);});
test('profile changes reject stale catalog and library completions',async()=>{const f=fixture(),p=createPlatform(f);await p.setFeedConfig(config(true));let finish,started;const ready=new Promise(r=>started=r);const gate=new Promise(r=>finish=r);f.bridge.fetchCatalog=async()=>{started();await gate;return [game('early')];};const pending=p.catalog();await ready;await p.useProfile('p_kid');finish();await assert.rejects(pending,/profile/i);});

test('beta bytes exposed during an in-flight install stay hidden after switching to a child',async()=>{
 const f=fixture(),p=createPlatform(f);await p.setFeedConfig(config(true));await p.catalog();let finish,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>finish=r);
 f.bridge.install=async id=>{f.games.push(game(id));started();await gate;};const installing=p.install('early');await ready;await p.useProfile('p_kid');assert.deepEqual(await p.library(),[]);finish();await installing;assert.deepEqual(await p.library(),[]);await p.useProfile('p_first');assert.equal((await p.library()).length,1);
});
test('a stale raw library response is rejected and removed profile feed choices reset',async()=>{
 const f=fixture(),p=createPlatform(f);await p.setFeedConfig(config(true));await p.catalog();await p.install('early');let finish,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>finish=r);f.bridge.library=async()=>{started();await gate;return f.games;};const pending=p.library();await ready;await p.useProfile('p_kid');finish();await assert.rejects(pending,/profile/i);await p.removeProfile('p_first');await p.useProfile('p_first');assert.equal((await p.feedConfig()).feeds.find(f=>f.url===B).enabled,false);
});
test('source persistence failure cannot expose beta bytes to a child, including after restart',async()=>{
 const f=fixture(),p=createPlatform(f);await p.setFeedConfig(config(true));await p.catalog();
 const write=f.bridge.writeFeedState;f.bridge.writeFeedState=async()=>{throw Error('write failed');};
 await assert.rejects(p.install('early'),/write failed/);assert.equal(f.installs.length,0);
 f.bridge.writeFeedState=write;await p.useProfile('p_kid');assert.deepEqual(await p.library(),[]);
 const q=createPlatform(f);await q.useProfile('p_kid');assert.deepEqual(await q.library(),[]);
});
test('partial native install failure retains durable beta provenance across restart',async()=>{
 const f=fixture(),p=createPlatform(f);await p.setFeedConfig(config(true));await p.catalog();
 f.bridge.install=async id=>{f.games.push(game(id));throw Error('activation failed');};
 await assert.rejects(p.install('early'),/activation failed/);assert.equal(f.disk().sources.early.feed_url,B);
 await p.useProfile('p_kid');assert.deepEqual(await p.library(),[]);
 const q=createPlatform(f);await q.useProfile('p_kid');assert.deepEqual(await q.library(),[]);
});
test('failed native install without bytes does not reserve an unused source',async()=>{
 const f=fixture(),p=createPlatform(f);await p.setFeedConfig(config(true));await p.catalog();
 f.bridge.install=async()=>{throw Error('download failed');};
 await assert.rejects(p.install('early'),/download failed/);assert.equal(f.disk().sources.early,undefined);
});
test('duplicate installs share native work and source cleanup on failure',async()=>{
 const f=fixture(),p=createPlatform(f);await p.setFeedConfig(config(true));await p.catalog();
 let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);let calls=0;
 f.bridge.install=async()=>{calls++;started();await gate;throw Error('download failed');};
 const first=p.install('early');await ready;const duplicate=p.install('early');
 const settled=Promise.allSettled([first,duplicate]);await new Promise(r=>setImmediate(r));release();
 for(const result of await settled){assert.equal(result.status,'rejected');assert.match(result.reason.message,/download failed/);}
 assert.equal(calls,1);assert.equal(f.disk().sources.early,undefined);
});

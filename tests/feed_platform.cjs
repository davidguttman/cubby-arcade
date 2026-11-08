const test=require('node:test'),assert=require('node:assert/strict');
const {createPlatform}=require('../runtime/core/platform.js');
const {DEFAULT_URL}=require('../runtime/core/game-feeds.js');
const custom='https://custom.test/catalog';
const entry=(url,title)=>({id:'demo',title,manifest_url:url,artwork:'https://assets.test/art.png'});
test('shared platform pins successful installs and updates hidden sources, pausing removed feeds',async()=>{
 let saved=null,games=[],calls=[],offers={[DEFAULT_URL]:[entry('https://first.test/m.json','First')],[custom]:[entry('https://custom.test/m.json','Custom')]};
 const bridge={readFeedState:async()=>saved,writeFeedState:async value=>{saved=structuredClone(value);},fetchCatalog:async url=>offers[url],library:async()=>games,
 install:async(id,{offer})=>{calls.push(offer);games=[{id}];},uninstall:async()=>{games=[];}};
 let p=createPlatform({bridge});await p.setFeedConfig({schema:1,feeds:[{url:custom,name:'Custom',enabled:true},{url:DEFAULT_URL,name:'Cubby',enabled:true}]});
 await p.catalog();await p.install('demo');assert.equal(calls[0].title,'Custom');
 await p.setFeedConfig({schema:1,feeds:[{url:DEFAULT_URL,name:'Cubby',enabled:true},{url:custom,name:'Custom',enabled:true}]});
 assert.equal((await p.catalog())[0].title,'First');await assert.rejects(p.install('demo'),/source/);
 await p.update('demo');assert.equal(calls[1].title,'Custom');
 p=createPlatform({bridge});await p.catalog();await p.update('demo');assert.equal(calls[2].title,'Custom');
 await p.setFeedConfig({schema:1,feeds:[{url:DEFAULT_URL,name:'Cubby',enabled:true}]});await p.catalog();await p.update('demo');assert.equal(calls.length,3);assert.equal(games.length,1);
 await p.uninstall('demo');await p.catalog();await p.install('demo');assert.equal(calls[3].title,'First');
});
test('failed native install never pins; legacy installs only migrate from default feed',async()=>{
 let saved=null,called=0,games=[{id:'demo'}];
 const p=createPlatform({bridge:{readFeedState:async()=>saved,writeFeedState:async s=>{saved=s;},fetchCatalog:async url=>[entry('https://'+(url===DEFAULT_URL?'first':'custom')+'.test/m.json','Demo')],library:async()=>games,install:async()=>{called++;throw Error('failed');}}});
 await p.setFeedConfig({schema:1,feeds:[{url:custom,name:'Custom',enabled:true}]});await p.catalog();await p.update('demo');assert.equal(called,0);
 await assert.rejects(p.install('demo'),/source/);games=[];await assert.rejects(p.install('demo'),/failed/);assert.deepEqual(saved.sources,{});
});
test('in-flight install pins the original issued offer after catalog removal, never the native clone',async()=>{
 let saved=null,games=[],finish,started;const gate=new Promise(resolve=>finish=resolve),began=new Promise(resolve=>started=resolve);
 const p=createPlatform({bridge:{readFeedState:async()=>saved,writeFeedState:async s=>{saved=structuredClone(s);},fetchCatalog:async()=>[entry('https://first.test/m.json','Demo')],library:async()=>games,
 install:async(id,{offer})=>{started();await gate;games=[{id}];return structuredClone(offer);}}});
 await p.catalog();const install=p.install('demo');await began;
 await p.setFeedConfig({schema:1,feeds:[]});await p.catalog();finish();await install;
 assert.equal(saved.sources.demo.feed_url,DEFAULT_URL);assert.equal(saved.sources.demo.manifest_url,'https://first.test/m.json');
});
test('catalog refresh cannot migrate a newly exposed custom install to the default publisher',async()=>{
 let saved=null,games=[],p;
 const bridge={readFeedState:async()=>saved,writeFeedState:async s=>{saved=structuredClone(s);},library:async()=>games,
  fetchCatalog:async url=>[entry(url===DEFAULT_URL?'https://first.test/m.json':'https://custom.test/m.json','Demo')],
  install:async id=>{games=[{id}];await p.catalog();}};
 p=createPlatform({bridge});
 await p.setFeedConfig({schema:1,feeds:[{url:custom,name:'Custom',enabled:true},{url:DEFAULT_URL,name:'Cubby',enabled:true}]});
 await p.catalog();await p.install('demo');
 assert.equal(saved.sources.demo.feed_url,custom);
 p=createPlatform({bridge});await p.catalog();
 assert.equal((await p.updateOffer('demo'))._source.feed_url,custom);
 assert.equal(saved.sources.demo.manifest_url,'https://custom.test/m.json');
});
test('a removed legacy game never becomes eligible for migration on custom reinstall',async()=>{
 let saved=null,games=[{id:'demo'}],p;
 const bridge={readFeedState:async()=>saved,writeFeedState:async s=>{saved=structuredClone(s);},library:async()=>games,
  fetchCatalog:async url=>[entry(url===DEFAULT_URL?'https://first.test/m.json':'https://custom.test/m.json','Demo')],
  uninstall:async()=>{games=[];},install:async id=>{games=[{id}];await p.catalog();}};
 p=createPlatform({bridge});await p.catalog();assert.equal(saved.sources.demo.feed_url,DEFAULT_URL);
 await p.uninstall('demo');
 await p.setFeedConfig({schema:1,feeds:[{url:custom,name:'Custom',enabled:true},{url:DEFAULT_URL,name:'Cubby',enabled:true}]});
 await p.catalog();assert.equal(saved.sources.demo,undefined);
 await p.install('demo');assert.equal(saved.sources.demo.feed_url,custom);
 p=createPlatform({bridge});await p.catalog();assert.equal((await p.updateOffer('demo'))._source.feed_url,custom);
});

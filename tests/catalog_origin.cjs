const test=require('node:test'),assert=require('node:assert/strict');
const Feeds=require('../runtime/core/game-feeds.js');
const OLD='https://cubby.david.app/catalog',NEW='https://play.cubbyarcade.com/catalog';
const offer={id:'demo',title:'Demo',manifest_url:'https://game.test/manifest.json',artwork:'https://game.test/cover.png'};
test('fresh feeds and desktop cloud use the interactive origin',()=>{
 assert.equal(Feeds.DEFAULT_URL,NEW);
 assert.equal(Feeds.BETA_URL,'https://play.cubbyarcade.com/beta/catalog');
 assert.equal(require('../desktop/cloud.cjs').DEFAULT_ORIGIN,'https://play.cubbyarcade.com');
});
test('old configured feed, cached offer and pinned source survive loading and refresh',async()=>{
 const config={schema:1,feeds:[{url:OLD,name:'My Cubby',enabled:true}]};
 let saved={schema:1,config,profiles:{p_first:config},cache:{[OLD]:[offer]},sources:{demo:{feed_url:OLD,manifest_url:offer.manifest_url}}};
 const calls=[],manager=Feeds.createManager({read:async()=>structuredClone(saved),write:async value=>{saved=structuredClone(value);},fetchCatalog:async url=>{calls.push(url);return [offer];}});
 assert.deepEqual(await manager.config(),config);
 await manager.catalog();
 assert.deepEqual(calls,[OLD]);
 assert.equal((await manager.updateOffer('demo'))._source.feed_url,OLD);
 assert.equal((await manager.source('demo')).feed_url,OLD);
 assert.equal((await manager.config('p_new')).feeds[0].url,NEW);
});
test('untracked old installs retain their original built-in provenance, not a custom collision',()=>{
 const other={...offer,manifest_url:'https://other.test/manifest.json'};
 assert.deepEqual(Feeds.legacySource('demo',{[OLD]:[offer],[NEW]:[other]}),{feed_url:OLD,manifest_url:offer.manifest_url});
 assert.equal(Feeds.legacySource('demo',{'https://custom.test/catalog':[offer]}),null);
});
test('legacy pre-profile migration does not add a second beta identity',async()=>{
 const beta='https://cubby.david.app/beta/catalog',config={schema:1,feeds:[{url:OLD,name:'Cubby',enabled:true},{url:beta,name:'Beta',enabled:true}]};
 let saved={schema:1,config,cache:{},sources:{}};
 const manager=Feeds.createManager({read:async()=>saved,write:async v=>{saved=v;},fetchCatalog:async()=>[]});
 assert.deepEqual(await manager.config(),config);
});

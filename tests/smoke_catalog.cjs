const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {FeedIO}=require('../desktop/feeds.cjs');
const {createPlatform}=require('../runtime/core/platform.js');
const {DEFAULT_URL}=require('../runtime/core/game-feeds.js');
const {setCatalog}=require('../desktop/install-smoke.cjs');

test('native smoke offers survive repeated catalog refreshes through validated discovery',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'smoke-catalog-'));
 try{
  const file=path.join(root,'feeds.json'),io=new FeedIO(file,{fetch:async()=>{throw Error('Smoke offline');}});
  const platform=feeds=>createPlatform({bridge:{readFeedState:()=>feeds.read(),writeFeedState:value=>feeds.write(value),fetchCatalog:url=>feeds.catalog(url),library:async()=>[]}});
  const p=platform(io),original=await p.catalog(),entry={id:'demo',title:'Demo',manifest_url:'https://smoke.invalid/manifest.json',artwork:'https://smoke.invalid/cover.png'};
  let installed;
  await setCatalog(io,{setCatalog:entries=>installed=entries},[entry]);
  assert.deepEqual(installed,[entry]);assert.deepEqual(original,[]);
  installed=[]; // The native registry is replaceable; discovery cannot depend on its old array.
  const expected={...entry,_source:{feed_url:DEFAULT_URL,manifest_url:entry.manifest_url}};
  assert.deepEqual(await p.catalog(),[expected]);
  assert.deepEqual(await p.catalog(),[expected]);
  await assert.rejects(io.fetch('https://cubby.david.app/other'),/Smoke offline/);
  const offline=new FeedIO(file,{fetch:async()=>{throw Error('offline');}});
  assert.deepEqual(await platform(offline).catalog(),[expected]);
  assert.deepEqual(offline.offer('demo',expected),expected);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

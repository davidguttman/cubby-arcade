const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {CloudHub}=require('../desktop/cloud.cjs');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(word){const files={'/index.html':Buffer.from(word),'/runtime/core/hub.js':Buffer.from('script'),'/catalog':Buffer.from('[]')};return {files,manifest:{schema_version:1,bridge_version:1,files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,{size:b.length,sha256:digest(b)}]))}};}
function transport(f){return async url=>{const name=new URL(url).pathname;return new Response(name==='/hub-manifest.json'?JSON.stringify(f.manifest):f.files[name],{status:name==='/hub-manifest.json'||f.files[name]?200:404});};}
test('healthy refresh repairs corrupt same-version cache and repaired snapshot survives offline',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-hub-'));
 try{
  const good=fixture('healthy');let hub=new CloudHub(root,{fetch:transport(good)});await hub.refresh();
  const version=await fs.readFile(path.join(root,'current'),'utf8');
  await fs.writeFile(path.join(root,version,'index.html'),'corrupt');
  hub=new CloudHub(root,{fetch:transport(good)});await hub.refresh();
  assert.equal(hub.source,'cloud');assert.equal((await hub.read('/')).toString(),'healthy');
  assert.equal(await fs.readFile(path.join(root,'current'),'utf8'),version);
  hub=new CloudHub(root,{fetch:async()=>{throw Error('offline');}});await hub.refresh();
  assert.equal(hub.source,'cache');assert.equal((await hub.read('/')).toString(),'healthy');
  assert.deepEqual((await fs.readdir(root)).sort(),['current',version].sort());
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('cloud snapshot refresh changes UI without touching local games; bad refresh and offline retain coherent cache',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-hub-'));
 try{const one=fixture('one'),two=fixture('two');
 let hub=new CloudHub(root,{fetch:transport(one)});await hub.refresh();assert.equal(hub.source,'cloud');assert.equal((await hub.read('/')).toString(),'one');
 hub=new CloudHub(root,{fetch:transport(two)});await hub.refresh();assert.equal((await hub.read('/')).toString(),'two');
 const bad=fixture('bad');bad.files['/runtime/core/hub.js']=Buffer.from('wrong hash');
 hub=new CloudHub(root,{fetch:transport(bad)});await hub.refresh();assert.equal(hub.source,'cache');assert.equal((await hub.read('/')).toString(),'two');
 hub=new CloudHub(root,{fetch:async()=>{throw Error('offline');}});await hub.refresh();assert.equal(hub.source,'cache');assert.equal((await hub.read('/')).toString(),'two');assert.equal(await hub.read('/games/one/play.html'),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('first launch offline uses bundle, and invalid manifests cannot escape shell paths',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-hub-'));
 try{const hub=new CloudHub(root,{fetch:async()=>{throw Error('offline');}});await hub.refresh();assert.equal(hub.source,'bundle');assert.equal(await hub.read('/'),null);
 for(const name of ['/../outside','/games/demo/play.html','/runtime/core/../host.cjs']){const bad=fixture('bad');bad.manifest.files[name]={size:1,sha256:digest('x')};const rejected=new CloudHub(root,{fetch:transport(bad)});await rejected.refresh();assert.equal(rejected.source,'bundle');}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('invalid catalog or bridge version cannot replace last verified snapshot',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-hub-'));
 try{
  const good=fixture('good');let hub=new CloudHub(root,{fetch:transport(good)});await hub.refresh();
  const bad=fixture('bad');bad.files['/catalog']=Buffer.from(JSON.stringify([{id:'../escape',artwork:'file:///etc/passwd'}]));bad.manifest.files['/catalog']={size:bad.files['/catalog'].length,sha256:digest(bad.files['/catalog'])};
  hub=new CloudHub(root,{fetch:transport(bad)});await hub.refresh();assert.equal(hub.source,'cache');assert.equal((await hub.read('/')).toString(),'good');
  bad.manifest.bridge_version=2;hub=new CloudHub(root,{fetch:transport(bad)});await hub.refresh();assert.equal(hub.source,'cache');assert.equal((await hub.read('/')).toString(),'good');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('registry discovery accepts independent HTTPS media without requiring a local game entrypoint',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-registry-'));
 const entry={id:'demo',title:'Demo',manifest_url:'https://games.example/store/demo/manifest.json',artwork:'https://games.example/store/demo/1/cover.png',attract:'https://games.example/store/demo/1/trailer.webm',screenshots:['https://games.example/store/demo/1/screen.png']};
 function registryFixture(value){const f=fixture('registry');f.files['/catalog']=Buffer.from(JSON.stringify(value));f.manifest.files['/catalog']={size:f.files['/catalog'].length,sha256:digest(f.files['/catalog'])};return f;}
 try{
  let hub=new CloudHub(root,{fetch:transport(registryFixture([entry]))});await hub.refresh();assert.equal(hub.source,'cloud');
  for(const entries of [[{...entry,manifest_url:'http://example.com/release'}],[{...entry,artwork:'file:///etc/passwd'}],[{...entry,screenshots:['https://u:p@example.com/secret']}],[entry,entry]]){
   hub=new CloudHub(root,{fetch:transport(registryFixture(entries))});await hub.refresh();assert.equal(hub.source,'cache');assert.deepEqual(JSON.parse(await hub.read('/catalog')),[entry]);
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('landing page cannot replace native launcher; native route and legacy host both work',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-landing-'));
 try{
  const good=fixture('native arcade');const requested=[];
  const fetch=async url=>{const name=new URL(url).pathname;requested.push(name);if(name==='/index.html')return new Response('public landing');if(name==='/native/index.html')return new Response(good.files['/index.html']);return transport(good)(url);};
  let hub=new CloudHub(root,{fetch});await hub.refresh();assert.equal(hub.source,'cloud');assert.equal((await hub.read('/')).toString(),'native arcade');assert.ok(requested.includes('/native/index.html'));assert.ok(!requested.includes('/index.html'));
  hub=new CloudHub(root,{fetch:transport(good)});await hub.refresh();assert.equal(hub.source,'cloud');assert.equal((await hub.read('/')).toString(),'native arcade');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('catalog changes independently of shell; invalid/offline retain last-known-good including empty',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'live-catalog-'));
 const entry=id=>({id,title:id,manifest_url:`https://games.example/${id}/manifest.json`,artwork:`https://games.example/${id}/cover.png`});
 try{
  const shell=fixture('unchanged');let offers=[],requests=[];
  const fetch=async(url,options)=>{requests.push([new URL(url).pathname,options]);return new URL(url).pathname==='/catalog'?new Response(JSON.stringify(offers)):transport(shell)(url);};
  const hub=new CloudHub(root,{fetch});await hub.refresh();const directory=hub.directory;requests=[];offers=[entry('one')];
  assert.deepEqual(await hub.catalog([]),offers);
  offers=[entry('two')];assert.deepEqual(await hub.catalog([]),offers);
  offers=[{...entry('bad'),manifest_url:'file:///bad'}];assert.deepEqual(await hub.catalog([]),[entry('two')]);
  offers=[];assert.deepEqual(await hub.catalog([entry('fallback')]),[]);
  assert.equal(hub.directory,directory);assert.equal((await hub.read('/')).toString(),'unchanged');assert.equal((await hub.read('/catalog')).toString(),'[]');
  assert.ok(requests.every(([name,opts])=>name==='/catalog'&&opts.cache==='no-store'&&opts.redirect==='error'));
  const offline=new CloudHub(root,{fetch:async()=>{throw Error('offline');}});assert.deepEqual(await offline.catalog([entry('fallback')]),[]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('independent catalog bounds responses and coalesces concurrent fetches',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'live-catalog-'));let count=0,release;
 try{
  const hub=new CloudHub(root,{fetch:()=>{count++;return new Promise(resolve=>release=resolve);}});
  const a=hub.catalog([]),b=hub.catalog([]);while(!release)await new Promise(setImmediate);release(new Response('[]'));assert.deepEqual(await a,[]);assert.deepEqual(await b,[]);assert.equal(count,1);
  hub.fetch=async()=>new Response('x'.repeat(2*1024*1024+1));assert.deepEqual(await hub.catalog([]),[]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

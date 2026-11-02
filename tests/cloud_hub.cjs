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

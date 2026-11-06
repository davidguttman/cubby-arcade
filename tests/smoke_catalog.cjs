const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {CloudHub}=require('../desktop/cloud.cjs');
const {setCatalog}=require('../desktop/install-smoke.cjs');

test('native smoke offers survive repeated catalog refreshes through validated discovery',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'smoke-catalog-'));
 try{
  const cloud=new CloudHub(root,{fetch:async()=>{throw Error('Smoke offline');}});
  const original=await cloud.catalog([]),entry={id:'demo',title:'Demo',manifest_url:'https://smoke.invalid/manifest.json',artwork:'https://smoke.invalid/cover.png'};
  let installed;
  await setCatalog(cloud,{setCatalog:entries=>installed=entries},[entry]);
  assert.deepEqual(installed,[entry]);assert.deepEqual(original,[]);
  installed.length=0;
  assert.deepEqual(await cloud.catalog([]),[entry]);
  assert.deepEqual(await cloud.catalog([]),[entry]);
  await assert.rejects(cloud.fetch('https://cubby.david.app/other'),/Smoke offline/);
  const offline=new CloudHub(root,{fetch:async()=>{throw Error('offline');}});
  assert.deepEqual(await offline.catalog([]),[entry]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

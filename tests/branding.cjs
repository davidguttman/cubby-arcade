const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {userDataPath}=require('../desktop/profile.cjs');
const defaults={appData:'/profiles',temp:'/scratch',packaged:true,smoke:false};
test('branding preserves either historical profile regardless of packaging',()=>{
 for(const packaged of [true,false])for(const name of ['handheld-os-desktop','HandheldHub']){
  const old=path.join('/profiles',name);
  assert.equal(userDataPath({...defaults,packaged},p=>p===old),old);
 }
});
test('canonical profile wins; historical package name precedes product-name fallback',()=>{
 const known=new Set(['/profiles/handheld-os-desktop','/profiles/HandheldHub']);
 assert.equal(userDataPath(defaults,p=>known.has(p)),'/profiles/handheld-os-desktop');
 known.add('/profiles/CubbyArcade');
 assert.equal(userDataPath(defaults,p=>known.has(p)),'/profiles/CubbyArcade');
});
test('new profile and smoke use Cubby Arcade names; explicit profile wins',()=>{
 assert.equal(userDataPath(defaults,()=>false),'/profiles/CubbyArcade');
 assert.equal(userDataPath(defaults,()=>true),'/profiles/CubbyArcade');
 assert.equal(userDataPath({...defaults,smoke:true}),'/scratch/cubby-arcade-smoke-profile');
 assert.equal(userDataPath({...defaults,smoke:true,override:'/chosen'}),'/chosen');
});

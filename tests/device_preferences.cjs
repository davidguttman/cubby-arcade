const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('runtime/core/preferences.js','utf8');
function load(profile, saved){
 const entries=new Map(saved?[['handheld:preferences:v1',JSON.stringify(saved)]]:[]);
 const target={CubbyDeviceProfile:profile,navigator:{maxTouchPoints:5},matchMedia:()=>({matches:true}),
   localStorage:{getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v)}};
 vm.createContext(target);vm.runInContext(source,target);return target;
}
test('RG353V profile defaults touchscreen overlay off and resets to device default',()=>{
 const target=load('rg353v'),p=target.HandheldPreferences.preferences;
 assert.equal(p.get().touchOverlay,'off');assert.equal(p.showTouchControls(target),false);
 p.set({touchOverlay:'on'});assert.equal(p.showTouchControls(target),false);
 p.reset();assert.equal(p.get().touchOverlay,'off');
});
test('legacy touch modes cannot override physical handheld policy',()=>{
 const keyboard=load().HandheldPreferences.DEFAULT_KEYBOARD;
 for(const touchOverlay of ['on','off','auto']){
  const target=load('rg353v',{keyboard,touchOverlay}),p=target.HandheldPreferences.preferences;
  assert.equal(p.get().touchOverlay,'off');
  assert.equal(p.showTouchControls(target),false);
 }
});
test('ordinary browsers and unrecognized profiles retain touchscreen auto',()=>{
 for(const profile of [undefined,'other',{name:'rg353v'}]){
  const target=load(profile),p=target.HandheldPreferences.preferences;
  assert.equal(p.get().touchOverlay,'auto');assert.equal(p.showTouchControls(target),true);
 }
});

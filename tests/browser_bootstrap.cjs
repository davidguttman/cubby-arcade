const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=()=>fs.readFileSync('runtime/core/browser-bootstrap.js','utf8');
function env(extra={}){let mounted=0,disposed=0;const listeners=new Map(),host={replaceChildren(){},appendChild(){}};const win={addEventListener(name,fn){listeners.set(name,fn);},document:{getElementById:()=>host,createElement:()=>({setAttribute(){}})},HandheldHub:{mount(){mounted++;return {dispose(){disposed++;}};}},...extra};return {win,emit:(name,event)=>listeners.get(name)?.(event),run:()=>vm.runInNewContext(source(),{window:win,Promise,setTimeout,clearTimeout,URLSearchParams}),mounted:()=>mounted,disposed:()=>disposed};}
test('native bridge bypasses worker and browser storage entirely',async()=>{const e=env({HandheldPlatformOptions:{kind:'desktop',bridge:{}}});await e.run();assert.equal(e.mounted(),1);});
test('browser waits for worker control and storage readiness, then restarts hub on BFCache restore',async()=>{let ready=false;const controller={};const e=env({isSecureContext:true,navigator:{serviceWorker:{controller,register:async()=>({}),ready:Promise.resolve({})}},HandheldBrowserStore:{createBridge(){return {async ready(){ready=true;}};}}});await e.run();assert(ready);assert.equal(e.win.HandheldPlatformOptions.kind,'web');assert.equal(e.mounted(),1);
 e.emit('pageshow',{persisted:false});assert.equal(e.mounted(),1);e.emit('pageshow',{persisted:true});assert.equal(e.mounted(),2);assert.equal(e.disposed(),1);
});
test('unsupported browser reports accessible failure instead of fake install capability',async()=>{let label='';const e=env();e.win.document.createElement=()=>({setAttribute(k,v){if(k==='aria-label')label=v;}});await e.run();assert.match(label,/storage unavailable/i);assert.equal(e.mounted(),0);});

test('explicit loopback kiosk host mounts without browser storage or worker',async()=>{const options={kind:'kiosk'};const e=env({HandheldPlatformOptions:options});await e.run();assert.equal(e.mounted(),1);assert.equal(e.win.HandheldPlatformOptions,options);});

test('only valid handheld embed explicitly opts into Line Cutter starter',async()=>{
 for(const [embed,query,expected] of [[{},'?starter=line-cutter','line-cutter'],[{},'?starter=other',undefined],[null,'?starter=line-cutter',undefined]]){
  const e=env({CubbyHandheldEmbed:embed,location:{search:query},isSecureContext:true,navigator:{serviceWorker:{controller:{},register:async()=>{},ready:Promise.resolve()}},HandheldBrowserStore:{createBridge:()=>({ready:async()=>{}})}});
  await e.run();assert.equal(e.win.HandheldPlatformOptions.starterGame,expected);
 }
});

test('handheld starter pack accepts only known games, deduplicates and remains embed-only',async()=>{
 const query='?starter=line-cutter&starter=fox-barrister&starter=owl-the-way-home&starter=spell-castle&starter=fox-barrister&starter=other';
 for(const embed of [{},null]){
  const e=env({CubbyHandheldEmbed:embed,location:{search:query},isSecureContext:true,navigator:{serviceWorker:{controller:{},register:async()=>{},ready:Promise.resolve()}},HandheldBrowserStore:{createBridge:()=>({ready:async()=>{}})}});
  await e.run();assert.deepEqual(Array.from(e.win.HandheldPlatformOptions.starterGames||[]),embed?['line-cutter','fox-barrister','owl-the-way-home','spell-castle']:[]);
 }
});

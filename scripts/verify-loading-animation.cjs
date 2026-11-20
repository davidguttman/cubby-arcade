// Uses the managed browser, actual hub/CSS, and a controlled slow installer.
// No server is started; run with Playwright available via NODE_PATH.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:18800');
 try{for(const width of [640,390]){
  const context=await browser.newContext({viewport:{width,height:width===640?480:844},reducedMotion:'no-preference'}),page=await context.newPage();
  await page.setContent('<!doctype html><body class="hub"><main id="hub"></main></body>');
  for(const file of ['screen.css','hub.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,'runtime/core',file),'utf8')});
  await page.evaluate(()=>{
   const installed=[];
   const saved=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,String(value))}});
   window.HandheldPreferences={preferences:{subscribe:()=>()=>{},get:()=>({touchOverlay:'auto'})}};
   window.HandheldInput={createInput:()=>({dispose(){}})};
   window.HandheldPlatformOptions={starterGame:'line-cutter'};
   window.HandheldPlatform={createPlatform:()=>({capabilities:{install:true},library:async()=>installed,catalog:()=>new Promise(resolve=>{window.finishCatalog=()=>resolve([]);}),onInstallState:fn=>{window.emitInstall=fn;return ()=>{};},install:()=>new Promise(resolve=>{window.finishInstall=()=>{installed.push({id:'line-cutter',artwork:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',entrypoint:'/line-cutter'});resolve();};})})};
  });
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'runtime/core/hub.js'),'utf8')});
  await page.evaluate(()=>{window.hub=HandheldHub.mount(document.querySelector('#hub'));});
  await page.waitForFunction(()=>window.finishInstall&&document.querySelector('.loading svg')?.getAnimations().length);
  const result=await page.evaluate(async()=>{
   const svg=document.querySelector('.loading svg'),dot=document.querySelector('.status-dots i'),progress=document.querySelector('.install-progress'),animation=svg.getAnimations()[0],duration=animation.effect.getTiming().duration;
   const start=animation.currentTime,samples=[],quadrants=new Set();let updates=0;
   const timer=setInterval(()=>{emitInstall({'line-cutter':{phase:'downloading',received:++updates,total:1000}});if(updates===8)finishCatalog();},65);
   try{while(animation.currentTime-start<duration*2.3){
    await new Promise(requestAnimationFrame);
    if(document.querySelector('.loading svg')!==svg||document.querySelector('.status-dots i')!==dot||document.querySelector('.install-progress')!==progress)throw Error('Loading subtree was remounted');
    if(svg.getAnimations()[0]!==animation)throw Error('Rotation animation was replaced');
    const matrix=new DOMMatrix(getComputedStyle(svg).transform),angle=(Math.atan2(matrix.b,matrix.a)+2*Math.PI)%(2*Math.PI);quadrants.add(Math.floor(angle/(Math.PI/2)));samples.push(animation.currentTime);
   }}finally{clearInterval(timer);}
   const elapsed=animation.currentTime-start;
   return {duration,elapsed,updates,quadrants:[...quadrants],continuous:samples.every((value,index)=>!index||value>=samples[index-1])};
  });
  assert.ok(result.continuous,'animation time must never reset');assert.ok(result.elapsed>result.duration*2,'rotation must complete twice');assert.equal(result.quadrants.length,4);assert.ok(result.updates>=20);
  await page.screenshot({path:`/tmp/cubby-loading-animation-${width}.png`});await page.evaluate(()=>finishInstall());
  await page.waitForSelector('.game-card');
  console.log(JSON.stringify({width,...result}));await page.evaluate(()=>hub.dispose());await context.close();
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

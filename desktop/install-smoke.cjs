/* Self-terminating native smoke: legacy ZIP install followed by file releases. */
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function run(win,installer,library,registry,options={}){
 const fixture=(process.env.CUBBY_ARCADE_SMOKE_INSTALL_DIR??process.env.HUB_SMOKE_INSTALL_DIR);if(!fixture)throw Error('HUB_SMOKE_INSTALL_DIR required');
 const first=await fs.readFile(path.join(fixture,'demo-1.zip'));
 const origin='https://install-smoke.invalid';
 const release=(version,bytes)=>({schema_version:1,id:'demo',version,runtime:'web',entrypoint:'index.html',package:{url:origin+'/demo.zip',size:bytes.length,sha256:hash(bytes)}});
 let current=release('1',first),payload=first,fail=true,releaseDownload;const documents=new Map(),fileRequests=[];
 const fileRelease=(version,html)=>{
  const files=Object.fromEntries(Object.entries({'index.html':html,'art.svg':'<svg xmlns="http://www.w3.org/2000/svg"/>','empty.txt':''}).map(([name,body])=>{
   const url=origin+'/releases/'+version+'/'+name;documents.set(url,body);return [name,{url,size:Buffer.byteLength(body),sha256:hash(body)}];
  }));
  return {schema_version:2,id:'demo',version,runtime:'web',entrypoint:'index.html',artwork:'art.svg',files};
 };
 const originalFetch=installer.fetch;
 installer.fetch=async(url,settings)=>{
  if(String(url)===origin+'/manifest.json')return new Response(JSON.stringify(current));
  if(documents.has(String(url))){fileRequests.push(String(url));return new Response(documents.get(String(url)));}
  if(String(url)===origin+'/demo.zip'){
   if(fail)throw Error('Smoke interrupted download');
   if(releaseDownload!==false)await new Promise(resolve=>releaseDownload=resolve);
   return new Response(payload);
  }
  return originalFetch(url,settings);
 };
 const entry={id:'demo',title:'Demo',manifest_url:origin+'/manifest.json',artwork:options.origin+'/games/line-cutter/cover.png',screenshots:[]};
 registry.push(entry);installer.setCatalog(registry);
 async function wait(check,label){const deadline=Date.now()+10000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,30));}throw Error('Smoke timed out: '+label);}
 async function evaluate(fn){return win.webContents.executeJavaScript(fn);}
 async function settleUpdates(){if(installer.checking)await installer.checking;if(installer.jobs.has('demo'))await installer.jobs.get('demo');}
 async function capture(name){if(!options.output)return;await fs.mkdir(options.output,{recursive:true});await new Promise(r=>setTimeout(r,300));await fs.writeFile(path.join(options.output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
 await win.loadURL('hub://app/');await wait(()=>evaluate('!!document.querySelector(".game-card")'),'hub');
 await evaluate(`document.querySelector('[aria-label=store]').click()`);
 await wait(()=>evaluate('!!document.querySelector("[data-game-id=demo]")'),'store demo card');
 await evaluate(`document.querySelector('[data-game-id=demo]').click()`);
 await wait(()=>evaluate('!!document.querySelector(".download-game")'),'download control');
 await evaluate(`document.querySelector('.download-game').click()`);
 await wait(()=>evaluate('document.querySelector(".download-game")?.getAttribute("aria-label")==="Retry download"'),'retry');await capture('download-retry');
 fail=false;await evaluate('document.querySelector(".download-game").click()');
 await wait(()=>typeof releaseDownload==='function','pending download');
 if(!await evaluate('document.querySelector(".download-game").disabled'))throw Error('Duplicate download not disabled');await capture('download-progress');
 win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await capture('mobile-download-progress');await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');win.webContents.debugger.detach();
 releaseDownload();releaseDownload=false;
 await wait(()=>library.entries().some(e=>e.id==='demo'),'installed');
 await wait(()=>evaluate('!!document.querySelector(".play-game")'),'play control');
 await capture('download-installed');
 await evaluate('document.querySelector(".play-game").click()');
 await wait(()=>win.webContents.getURL().includes('/games/demo/'),'launch');
 if(!await evaluate('!!document.querySelector("canvas")'))throw Error('Installed game not playable');
 if(!await evaluate('HandheldPlatformOptions.bridge.install("demo").then(()=>false,()=>true)'))throw Error('Game allowed install IPC');
 await settleUpdates();current=fileRelease('2','<canvas id="screen" width="100" height="100"></canvas>');await installer.checkUpdates();
 if(library.entries().find(e=>e.id==='demo').version!=='1'||installer.status().demo.phase!=='pending')throw Error('Update not deferred: '+JSON.stringify({game:library.entries().find(e=>e.id==='demo'),state:installer.status().demo}));
 await win.loadURL('hub://app/');await wait(()=>library.entries().find(e=>e.id==='demo').version==='2','idle activation');
 await settleUpdates();fileRequests.length=0;current=fileRelease('3','<canvas id="screen" width="120" height="100"></canvas>');await installer.checkUpdates();
 if(library.entries().find(e=>e.id==='demo').version!=='3'||fileRequests.length!==1||!fileRequests[0].endsWith('/index.html'))throw Error('File update failed to reuse unchanged bytes');
 await win.loadURL('hub://app/');await wait(()=>evaluate('!!document.querySelector("[data-game-id=demo]")'),'updated demo card');
 await evaluate(`document.querySelector('[data-game-id=demo]').click()`);
 await wait(()=>evaluate('!!document.querySelector(".play-game")'),'updated play control');
 await evaluate(`document.querySelector('.play-game').click()`);await wait(()=>win.webContents.getURL().includes('/games/demo/'),'file game launch');
 if(!await evaluate('document.querySelector("canvas").width===120'))throw Error('File-installed game not playable');
 await win.loadURL('hub://app/');
 await settleUpdates();current=fileRelease('4','corrupt expected');current.files['index.html'].sha256='0'.repeat(64);await installer.checkUpdates();
 if(library.entries().find(e=>e.id==='demo').version!=='3')throw Error('Corrupt update replaced current');
 installer.fetch=async()=>{throw Error('Smoke offline');};await installer.checkUpdates();
 if(library.entries().find(e=>e.id==='demo').version!=='3')throw Error('Offline removed installed game');
 await capture('updated-library');
 console.log(JSON.stringify({nativeInstall:true,retry:true,progress:true,play:true,fileManifest:true,unchangedFilesReused:true,fileGamePlayable:true,deferredUpdate:true,corruptPreserved:true,offlinePlayable:true,versions:library.entries().map(e=>({id:e.id,version:e.version}))}));
}
module.exports={run};

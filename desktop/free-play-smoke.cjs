/* Offline, disposable-profile check of tokenless native launch and real hub UI. */
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {passGate}=require('./hub-smoke.cjs');
async function run(win,launcher,installer,feeds,userData,options={}){
 const id='line-cutter',origin='https://free-play-smoke.invalid',library=installer.library;
 const bytes=await fs.readFile(options.package||path.join(__dirname,'../hosting/releases/line-cutter/0.2.1/line-cutter-0.2.1.game.zip'));
 const manifest={schema_version:1,id,version:'0.2.1',runtime:'web',entrypoint:'play.html',package:{url:origin+'/game.zip',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}};
 await require('./install-smoke.cjs').setCatalog(feeds,installer,[{id,title:'Line Cutter',manifest_url:origin+'/manifest.json',artwork:origin+'/cover.png'}]);
 installer.fetch=async url=>new Response(String(url)===origin+'/manifest.json'?JSON.stringify(manifest):bytes);
 await installer.install(id);
 const game=library.entries()[0],account=path.join(userData,'account.json');
 const evaluate=script=>win.webContents.executeJavaScript(script);
 async function wait(check,label){const until=Date.now()+12000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Free-play smoke timeout: '+label);}
 async function capture(name){if(options.output){await fs.mkdir(options.output,{recursive:true});await new Promise(r=>setTimeout(r,300));await fs.writeFile(path.join(options.output,name+'.png'),(await win.webContents.capturePage()).toPNG());}}
 async function home(){await win.loadURL('hub://app/');await wait(()=>evaluate('!!document.querySelector(".game-card")'),'hub');await evaluate('document.querySelector("[aria-label=library]").click();document.querySelector(".game-card").click()');}
 async function play(){await evaluate('document.querySelector(".play-game").click();document.querySelector(".play-game")?.click()');await wait(()=>!launcher.pending&&win.webContents.getURL().includes('/games/')&&!win.webContents.isLoading(),'game');}
 async function direct(url){await evaluate(`location.href=${JSON.stringify(url)}`);await wait(()=>!launcher.pending&&win.webContents.getURL().includes('/games/')&&!win.webContents.isLoading(),'direct game');await wait(()=>evaluate('!!window.HandheldGameShell'),'direct shell');}
 assert.equal(await fs.stat(account).then(()=>true,()=>false),false,'Fresh desktop created token account');
 await home();assert(await evaluate('document.querySelector(".token-budget").hidden&&!document.querySelector(".refill-tokens")&&!document.querySelector(".play-game").disabled&&document.querySelector(".play-game").getAttribute("aria-label")==="Play game"'),'Token UI present');
 assert(await evaluate('!("account" in HandheldPlatformOptions.bridge)&&!("refillTokens" in HandheldPlatformOptions.bridge)&&!("onAccountState" in HandheldPlatformOptions.bridge)'),'Token bridge exposed');
 await capture('free-play-desktop');
 await evaluate(`document.querySelector('[aria-label=options]').click();(${passGate})(document)`);assert(await evaluate('!document.querySelector(".refill-tokens")'),'Refill still offered');await capture('free-play-settings');
 for(const data of ['{"schema_version":1,"balance":0}','broken']){
  await fs.writeFile(account,data);
  for(let i=0;i<12;i++){await home();await play();}
  assert.equal(await fs.readFile(account,'utf8'),data,'Legacy token account changed');
 }
 assert(await evaluate(`HandheldPlatformOptions.bridge.launch(${JSON.stringify(id)}).then(()=>false,()=>true)`),'Game frame launch IPC authorized');
 await evaluate('HandheldGameShell.open();HandheldGameShell.resume()');await win.webContents.reload();await wait(()=>!win.webContents.isLoading(),'reload');
 const aliases=[game.entrypoint.replace('/games/','/%67ames/'),game.entrypoint.replace('/'+id+'/', '/%'+id.charCodeAt(0).toString(16)+id.slice(1)+'/'),game.entrypoint.replace(/\/([^/])([^/]*)$/,(_all,first,rest)=>'/%'+first.charCodeAt(0).toString(16)+rest)];
 for(const alias of aliases){await home();await direct('hub://app'+alias);assert(launcher.inSession(win.webContents.getURL()));}
 assert(await evaluate(`(()=>{const saves=HandheldPlatformOptions.bridge.saves(${JSON.stringify(id)});saves.set('free-play',{ok:true});return saves.get('free-play').ok;})()`),'Save scope failed');
 await home();assert(await evaluate('HandheldPlatformOptions.bridge.launch("missing").then(()=>false,()=>true)'),'Missing launch accepted');await play();await home();await capture('free-play-after-24-launches');
 assert.equal(await fs.readFile(account,'utf8'),'broken');
 const report={tokenUIAbsent:true,tokenBridgeAbsent:true,freshAccountAbsent:true,unlimitedLaunches:24,zeroAccountIgnored:true,corruptAccountPreserved:true,duplicateActivation:true,gameIPCRejected:true,resumeReload:true,encodedNavigation:true,savesPreserved:true,missingLaunchRejected:true};
 if(options.output)await fs.writeFile(path.join(options.output,'free-play-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
module.exports={run};

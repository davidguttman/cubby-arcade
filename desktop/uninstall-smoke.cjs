/* Offline, isolated, self-terminating smoke using a checked-in historical ZIP. */
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
async function run(win,installer,library,registry,store,account,options={}){
 const id='line-cutter',origin='https://uninstall-smoke.invalid';
 win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
 const bytes=await fs.readFile(path.join(__dirname,'../hosting/releases/line-cutter/0.2.1/line-cutter-0.2.1.game.zip'));
 const manifest={schema_version:1,id,version:'0.2.1',runtime:'web',entrypoint:'play.html',package:{url:origin+'/game.zip',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}};
 registry.splice(0,registry.length,{id,title:'Line Cutter',manifest_url:origin+'/manifest.json',artwork:origin+'/cover.png'});installer.setCatalog(registry);
 installer.fetch=async url=>new Response(String(url)===origin+'/manifest.json'?JSON.stringify(manifest):bytes);
 const evaluate=script=>win.webContents.executeJavaScript(script);
 async function wait(check,label){const until=Date.now()+12000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,30));}throw Error('Uninstall smoke timed out: '+label);}
 async function capture(name){if(!options.output)return;await fs.mkdir(options.output,{recursive:true});await new Promise(r=>setTimeout(r,300));await fs.writeFile(path.join(options.output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
 async function home(){await win.loadURL('hub://app/');if(installer.checking)await installer.checking;await wait(()=>evaluate('!!document.querySelector(".game-card")'),'installed library');await evaluate('document.querySelector(".game-card").click()');}
 async function open(){await evaluate('document.querySelector(".uninstall-game").click()');assert(await evaluate('document.querySelector(".uninstall-confirm").open'));assert(await evaluate('document.activeElement.classList.contains("cancel-uninstall")'));assert(await evaluate('(()=>{const style=getComputedStyle(document.activeElement);return style.outlineStyle!=="none"&&parseFloat(style.outlineWidth)>=3;})()'));}
 async function key(code,repeat=false){await evaluate("window.dispatchEvent(new Event('focus'))");await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:${JSON.stringify(code)},repeat:${repeat}}));`);if(!repeat)await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:${JSON.stringify(code)}}));`);}
 await installer.install(id);store.set(id,'uninstall-test',{level:9});await home();
 await evaluate('document.querySelector(".favorite").click()');const favorites=await evaluate('localStorage.getItem("handheld:favorites:v1")'),balance=account.balance;
 await capture('uninstall-detail-desktop');await open();assert(await evaluate('document.querySelector(".uninstall-picture img").getAttribute("src").includes("/games/line-cutter/")'));
 await capture('uninstall-confirm-desktop');
 await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await capture('uninstall-confirm-mobile');await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
 // Held confirm cannot jump to destruction: focus is Cancel and input latches repeats.
 await key('KeyZ',true);assert(await evaluate('document.querySelector(".uninstall-confirm").open'));await key('KeyZ');assert(!await evaluate('document.querySelector(".uninstall-confirm").open'));assert.equal(library.entries().length,1);
 await open();await key('Escape');assert(!await evaluate('document.querySelector(".uninstall-confirm").open'));assert.equal(library.entries().length,1);
 await open();await evaluate('document.querySelector(".cancel-uninstall").click()');assert.equal(library.entries().length,1);
 // A host failure keeps the selected game and exposes a retry, with safe focus.
 const disk=require('node:fs'),remove=disk.rmSync;disk.rmSync=function(target,...args){if(target===path.join(library.games,id))throw Error('Smoke temporary failure');return remove.call(this,target,...args);};
 await open();await evaluate('document.querySelector(".confirm-uninstall").click()');await wait(()=>evaluate('!!document.querySelector(".uninstall-error")'),'retry error');assert(await evaluate('document.activeElement.classList.contains("cancel-uninstall")'));await capture('uninstall-retry');disk.rmSync=remove;await evaluate('document.querySelector(".cancel-uninstall").click()');assert(!await evaluate('document.querySelector(".uninstall-game").disabled'));await open();
 // Navigate confirmation with the shared keyboard/controller action path.
 await key('ArrowRight');assert(await evaluate('document.activeElement.classList.contains("confirm-uninstall")'));await key('KeyZ');
 await wait(()=>evaluate('!document.querySelector(".uninstall-confirm").open'),'removed');assert.equal(library.entries().length,0);assert.equal(await fs.stat(path.join(library.games,id)).then(()=>true,()=>false),false);assert.deepEqual(store.get(id,'uninstall-test'),{level:9});assert.equal(account.balance,balance);assert.equal(await evaluate('localStorage.getItem("handheld:favorites:v1")'),favorites);
 assert(!await evaluate('!!document.querySelector(".play-game")'));await capture('uninstall-empty-library');
 await evaluate('document.querySelector("[aria-label=store]").click();document.querySelector(".game-card").click()');assert(await evaluate('!!document.querySelector(".download-game")'));assert(!await evaluate('!!document.querySelector(".uninstall-game")'));assert(!await evaluate('document.querySelector(".preview-media").getAttribute("src").startsWith("/games/")'));
 await evaluate('document.querySelector(".download-game").click()');await wait(()=>evaluate('!!document.querySelector(".play-game")'),'reinstalled');assert.deepEqual(store.get(id,'uninstall-test'),{level:9});
 await evaluate('document.querySelector(".play-game").click()');await wait(()=>win.webContents.getURL().includes('/games/line-cutter/'),'game');
 assert(await evaluate('HandheldPlatformOptions.bridge.uninstall("line-cutter").then(()=>false,()=>true)'));assert.equal(library.entries().length,1);
 const report={uninstall:true,cancelDefault:true,repeatSafe:true,backCancels:true,retry:true,reopenAfterFailure:true,libraryRefresh:true,storeRefresh:true,bytesRemoved:true,savesPreserved:true,favoritesPreserved:true,tokensPreserved:true,reinstall:true,gameIPCRejected:true};
 if(options.output)await fs.writeFile(path.join(options.output,'uninstall-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
module.exports={run};

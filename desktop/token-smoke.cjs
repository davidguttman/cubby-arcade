/* Isolated, self-terminating family-budget verification; never use a family profile. */
const fs=require('node:fs/promises'),path=require('node:path');
const {TokenAccount}=require('./tokens.cjs');
async function run(win,launcher,account,library,options={}){
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const evaluate=script=>win.webContents.executeJavaScript(script);
 async function wait(check,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Token smoke timeout: '+label);}
 async function capture(name){if(options.output){await fs.mkdir(options.output,{recursive:true});await new Promise(r=>setTimeout(r,350));await fs.writeFile(path.join(options.output,name+'.png'),(await win.webContents.capturePage()).toPNG());}}
 if((process.env.CUBBY_ARCADE_TOKEN_RESTART_EXPECT??process.env.HUB_TOKEN_RESTART_EXPECT)){assert(account.status().balance===Number((process.env.CUBBY_ARCADE_TOKEN_RESTART_EXPECT??process.env.HUB_TOKEN_RESTART_EXPECT)),'Balance reset at restart');console.log(JSON.stringify({restartPersisted:account.status().balance}));return;}
 assert(account.status().balance===10,'Use a fresh token smoke profile');
 const game=library.entries()[0];assert(game,'Bundled game missing');
 await wait(()=>evaluate('document.querySelectorAll(".token-budget span").length===10'),'ten pictorial coins');await capture('ten-tokens');
 await evaluate(`document.querySelector('.game-card').click();document.querySelector('.play-game').click();document.querySelector('.play-game')?.click()`);
 await wait(()=>account.status().balance===9,'first launch debit');assert(win.webContents.getURL().includes('/games/'),'First launch failed');
 assert(await evaluate('HandheldPlatformOptions.bridge.refillTokens().then(()=>false,()=>true)'),'Game refill authorized');
 assert(await evaluate('HandheldPlatformOptions.bridge.launch("line-cutter").then(()=>false,()=>true)'),'Game launch authorized');
 assert(await evaluate('HandheldPlatformOptions.bridge.account().then(()=>false,()=>true)'),'Game account authorized');
 await evaluate('HandheldGameShell.open();HandheldGameShell.resume()');assert(account.status().balance===9,'Resume charged');
 await win.webContents.reload();await wait(()=>evaluate('!!window.HandheldGameShell'),'reload');assert(account.status().balance===9,'Reload charged');
 async function home(){await win.loadURL('hub://app/');await wait(()=>evaluate('!!document.querySelector(".game-card")'),'home');}
 async function play(){await evaluate(`document.querySelector('.game-card').click();document.querySelector('.play-game').click()`);await wait(()=>!launcher.pending&&win.webContents.getURL().includes('/games/'),'play');}
 async function direct(url){const attempted=new Promise(resolve=>win.webContents.once('will-navigate',()=>setImmediate(resolve)));await evaluate(`location.href=${JSON.stringify(url)}`);await attempted;await wait(()=>!launcher.pending&&!win.webContents.isLoading(),'direct navigation settled');}
 await home();await play();assert(account.status().balance===8,'Second launch debit');
 await home();assert(await evaluate('HandheldPlatformOptions.bridge.launch("missing").then(()=>false,()=>true)'),'Missing launch accepted');assert(account.status().balance===8,'Failed launch charged');await capture('launch-failed');
 // Legacy cached UI uses direct navigation; the native window still accounts for it.
 await evaluate(`location.href=${JSON.stringify('hub://app'+game.entrypoint)}`);await wait(()=>account.status().balance===7,'legacy direct launch');
 const aliases=[game.entrypoint.replace('/games/','/%67ames/'),game.entrypoint.replace('/'+game.id+'/', '/%'+game.id.charCodeAt(0).toString(16)+game.id.slice(1)+'/'),game.entrypoint.replace(/\/([^/])([^/]*)$/,(_all,first,rest)=>'/%'+first.charCodeAt(0).toString(16)+rest)];
 const encodedFailures=[];
 for(const alias of aliases){
  await home();const before=account.status().balance;await direct('hub://app'+alias);
  if(account.status().balance!==before-1||!await evaluate('!!window.HandheldGameShell'))encodedFailures.push('Encoded launch escaped accounting or shell: '+alias+' (balance '+before+' → '+account.status().balance+')');
 }
 // Encoded reload within an already paid game session stays free.
 const paidBalance=account.status().balance;await direct('hub://app'+aliases[0]);
 await wait(()=>evaluate('!!window.HandheldGameShell'),'encoded session shell');
 assert(await evaluate(`(()=>{const saves=HandheldPlatformOptions.bridge.saves(${JSON.stringify(game.id)});saves.set('encoded-session',{ok:true});return saves.get('encoded-session').ok;})()`),'Encoded session save scope failed');
 assert(await evaluate('HandheldPlatformOptions.bridge.refillTokens().then(()=>false,()=>true)'),'Encoded game refill authorized');
 await win.webContents.reload();await wait(()=>!win.webContents.isLoading(),'encoded reload');
 await wait(()=>evaluate('!!window.HandheldGameShell'),'encoded reload shell');await capture('encoded-session');
 assert(account.status().balance===paidBalance,'Encoded session reload charged');
 while(account.status().balance>0){await home();await play();}
 assert(account.status().balance===0,'Budget not exhausted');await home();await evaluate('document.querySelector(".game-card").click()');
 assert(await evaluate('document.querySelector(".play-game").disabled'),'Zero balance Play enabled');
 assert(await evaluate(`HandheldPlatformOptions.bridge.launch(${JSON.stringify(game.id)}).then(()=>false,()=>true)`),'Zero balance native launch accepted');await capture('empty-tokens');
 for(const alias of aliases){
  await home();await direct('hub://app'+alias);
  if(!['/','/index.html'].includes(new URL(win.webContents.getURL()).pathname)||await evaluate('!!document.getElementById("screen")'))encodedFailures.push('Encoded launch opened at zero: '+alias);
  assert(account.status().balance===0,'Encoded zero launch changed balance');
 }
 assert(!encodedFailures.length,encodedFailures.join('; '));
 await evaluate(`document.querySelector('[aria-label=options]').click();document.querySelector('[aria-label="Adult keyboard setup"]').click()`);await capture('adult-refill');
 await evaluate('document.querySelector(".refill-tokens").click()');await wait(()=>account.status().balance===10,'adult refill');
 await evaluate(`document.querySelector('dialog.adult-setup').dispatchEvent(new Event('cancel',{cancelable:true}));document.querySelector('[aria-label=library]').click()`);
 await play();assert(account.status().balance===9,'Refilled launch did not debit');await home();
 assert(new TokenAccount(account.file).status().balance===9,'Disk balance differs');
 win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await capture('mobile-nine-tokens');win.webContents.debugger.detach();
 console.log(JSON.stringify({initial:10,first:9,resume:9,reload:9,second:8,failedLaunchPreserved:true,directNavigationCharged:true,encodedNavigationCharged:true,encodedSessionReloadFree:true,encodedZeroBlocked:true,zeroBlocked:true,adultRefill:true,persisted:9}));
}
module.exports={run};

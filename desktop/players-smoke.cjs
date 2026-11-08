/* Isolated, self-terminating check that players keep their saves apart through the real
 * desktop host: the hub picks the player, the main process saves to that player's
 * directory, and an installed game page reads only its launching player's storage. */
const fs=require('node:fs/promises'),path=require('node:path');
const {passGate}=require('./hub-smoke.cjs');
async function run(win,launcher,library,userData,options={}){
 const assert=(ok,message)=>{if(!ok)throw Error('Players smoke: '+message);};
 const evaluate=script=>win.webContents.executeJavaScript(script);
 async function wait(check,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Players smoke timeout: '+label);}
 async function capture(name){if(options.output){await fs.mkdir(options.output,{recursive:true});await new Promise(r=>setTimeout(r,450));await fs.writeFile(path.join(options.output,name+'.png'),(await win.webContents.capturePage()).toPNG());}}
 const readJSON=file=>fs.readFile(file,'utf8').then(JSON.parse,()=>null);
 const game=library.entries()[0];assert(game,'Explicitly installed smoke game missing');
 async function home(restart=false){
  // A restart is a new session: nothing pins the player, so Cubby asks again.
  if(restart)await evaluate('sessionStorage.clear()');
  await win.loadURL('hub://app/');await wait(()=>evaluate('!!document.querySelector(".game-card")'),'home');
 }
 async function play(){await evaluate(`document.querySelector('.game-card').click();document.querySelector('.play-game').click()`);await wait(()=>!launcher.pending&&win.webContents.getURL().includes('/games/')&&!win.webContents.isLoading(),'play');await wait(()=>evaluate('!!window.HandheldPlatform'),'game platform');}
 // Exactly how a game saves: its own frozen platform from the injected options, plus
 // direct localStorage the way Line Cutter's engine writes.
 const save=value=>evaluate(`(()=>{const s=HandheldPlatform.createPlatform(window.HandheldPlatformOptions).saves(${JSON.stringify(game.id)});const before={save:s.get('players-smoke'),direct:localStorage.getItem('players-smoke-direct')};s.set('players-smoke',${JSON.stringify(value)});localStorage.setItem('players-smoke-direct',${JSON.stringify(value)});return before;})()`);
 const report={};
 await home();
 // A fresh Cubby: one player, Cubby, in the logo's place; no picker.
 assert(await evaluate('!document.querySelector(".player-button").hidden&&document.querySelector(".player-button").dataset.avatar==="cubby"&&document.querySelector(".player-picker").hidden'),'Fresh Cubby chip missing');
 await capture('one-player');
 await play();assert(JSON.stringify(await save('first'))===JSON.stringify({save:null,direct:null}),'Fresh first player had saves');
 const firstFile=path.join(userData,'saves',game.id,'players-smoke.json');
 assert(await readJSON(firstFile)==='first','First player did not save to the original directory');report.firstPlayerOriginalDirectory=true;
 assert(await evaluate('HandheldPlatformOptions.bridge.useProfile("p_first").then(()=>false,()=>true)'),'Game page switched player');
 assert(await evaluate('HandheldPlatformOptions.bridge.removeProfile("p_first").then(()=>false,()=>true)'),'Game page removed a player');report.gameCannotSwitchOrRemove=true;
 // A child's +: the chip, +, an animal, then a name typed for real and ✓. No adult question.
 async function plus(name,picture){
  await evaluate(`document.querySelector('.player-button').click();document.querySelector('.picker-plus').click()`);if(picture)await capture(picture);
  await evaluate(`document.querySelector('.kid-animals .picker-face').click();document.querySelector('.player-name-field').focus()`);
  await win.webContents.insertText(name);
  assert(await evaluate(`document.querySelector('.player-name-field').value===${JSON.stringify(name)}&&!document.querySelector('.save-name').disabled`),'Typed name not accepted');
  if(picture)await capture('kid-name');
  await evaluate(`document.querySelector('.save-name').click()`);
  await wait(()=>evaluate(`document.querySelector('.player-picker').hidden&&document.querySelector('.player-label').textContent===${JSON.stringify(name)}`),'named '+name);
 }
 await home();await plus('Theo','kid-animal');
 const renamed=await evaluate('JSON.parse(localStorage.getItem("cubby:profiles:v1")).profiles');
 assert(renamed.length===1&&renamed[0].id==='p_first'&&renamed[0].name==='Theo','The first + did not rename Cubby in place');await capture('hub-renamed');
 await play();assert(JSON.stringify(await save('first'))===JSON.stringify({save:'first',direct:'first'}),'Renaming Cubby lost its saves');report.firstPlusRenamesInPlace=true;
 await home();await plus('Maya');
 const registry=await evaluate('JSON.parse(localStorage.getItem("cubby:profiles:v1"))');assert(registry.profiles.length===2&&registry.profiles[1].name==='Maya','The second + did not add a player');
 const second=registry.profiles[1].id;report.namesSaved=true;
 await home(true);assert(await evaluate('!document.querySelector(".player-picker").hidden'),'Cubby did not ask who is playing');
 assert(await evaluate(`[...document.querySelectorAll('.face-name')].map(n=>n.textContent).filter(Boolean).join()`)==='Theo,Maya','Picker names missing');await capture('picker');
 await evaluate(`[...document.querySelectorAll('.picker-face')].find(face=>face.dataset.profile===${JSON.stringify(second)}).click()`);
 await wait(()=>evaluate('document.querySelector(".player-picker").hidden'),'second player chosen');
 assert(await evaluate(`document.querySelector('.player-label').textContent`)==='Maya','Hub does not show the player’s name');await capture('hub-player');
 await play();assert(JSON.stringify(await save('second'))===JSON.stringify({save:null,direct:null}),'Second player saw the first player’s saves');
 const secondFile=path.join(userData,'profile-saves',second,game.id,'players-smoke.json');
 assert(await readJSON(secondFile)==='second'&&await readJSON(firstFile)==='first','Second player saves were not kept apart on disk');report.secondPlayerOwnDirectory=true;
 await win.webContents.reload();await wait(()=>evaluate('!!window.HandheldPlatform'),'reload');
 assert(await evaluate(`localStorage.getItem('players-smoke-direct')`)==='second','A reloaded game changed player');report.reloadKeepsPlayer=true;
 await home();await evaluate(`document.querySelector('.player-button').click();[...document.querySelectorAll('.picker-face')].find(face=>face.dataset.profile==='p_first').click()`);
 await wait(()=>evaluate('document.querySelector(".player-picker").hidden'),'first player chosen again');
 await play();assert(JSON.stringify(await save('first'))===JSON.stringify({save:'first',direct:'first'}),'First player lost their saves');report.firstPlayerKept=true;
 await home();
 await evaluate(`document.querySelector('[aria-label=options]').click();(${passGate})(document);document.querySelector('.manage-players').click()`);await capture('adult-players');
 await evaluate(`document.querySelectorAll('.rename-player')[0].click()`);await capture('adult-name-entry');await evaluate(`document.querySelector('.cancel-player').click()`);
 await evaluate(`document.querySelectorAll('.remove-player')[1].click();document.querySelector('.remove-confirm').click()`);
 await wait(()=>evaluate('JSON.parse(localStorage.getItem("cubby:profiles:v1")).profiles.length===1'),'player removed');
 assert(await fs.stat(path.join(userData,'profile-saves',second)).then(()=>false,()=>true),'Removed player’s directory remains');
 assert(await readJSON(firstFile)==='first','Removing a player touched the first player');
 assert(await evaluate(`Object.keys(localStorage).every(key=>!key.includes(${JSON.stringify(second)}))`),'Removed player’s browser storage remains');report.removeOnlyThatPlayer=true;
 console.log(JSON.stringify(report));
 if(options.output)await fs.writeFile(path.join(options.output,'players-report.json'),JSON.stringify(report,null,2));
 return report;
}
module.exports={run};

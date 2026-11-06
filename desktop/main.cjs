const {app,BrowserWindow,protocol,ipcMain}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {CloudHub}=require('./cloud.cjs');
const {GameInstaller}=require('./installer.cjs');
const {TokenAccount,GameLauncher}=require('./tokens.cjs');
const {assetName,assetPath,gameScope,requireHubFrame,SaveStore,GameLibrary}=require('./host.cjs');
protocol.registerSchemesAsPrivileged([{scheme:'hub',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const tokenSmoke=process.argv.includes('--token-smoke');
const installSmoke=process.argv.includes('--install-smoke');
const uninstallSmoke=process.argv.includes('--uninstall-smoke');
const smoke=process.argv.includes('--smoke')||installSmoke||tokenSmoke||uninstallSmoke;
let explicitSmokeExit=false;
function exitSmoke(code){explicitSmokeExit=true;app.exit(code);}
const env=name=>process.env['CUBBY_ARCADE_'+name]??process.env['HUB_'+name];
const {userDataPath}=require('./profile.cjs');
app.setName('Cubby Arcade');
app.setPath('userData',userDataPath({appData:app.getPath('appData'),temp:app.getPath('temp'),packaged:app.isPackaged,smoke,override:env('USER_DATA')}));
// One writer per local profile keeps its test budget and game selectors coherent.
if(!app.requestSingleInstanceLock())exitSmoke(0);
app.whenReady().then(async()=>{
  const site=smoke&&env('SMOKE_SITE')?path.resolve(env('SMOKE_SITE')):app.isPackaged?path.join(process.resourcesPath,'web'):path.join(__dirname,'../.cache/web');
  const store=new SaveStore(path.join(app.getPath('userData'),'saves'));
  const library=new GameLibrary(site,env('GAMES_DIR')?path.resolve(env('GAMES_DIR')):path.join(app.getPath('userData'),'games'));
  const cloud=new CloudHub(path.join(app.getPath('userData'),'hub-cache'),{origin:env('CLOUD_ORIGIN'),...(uninstallSmoke||(smoke&&env('SMOKE_OFFLINE')==='1')?{fetch:async()=>{throw Error('Smoke network offline');}}:{})});
  await cloud.refresh();
  console.log('Hub shell: '+cloud.source);
  let hubActive=true,win,launcher,servedDocuments=new Set();
  const account=new TokenAccount(path.join(app.getPath('userData'),'account.json'));
  const installer=new GameInstaller(library,{canActivate:()=>hubActive&&!launcher?.pending,onChange:states=>{
    if(win&&!win.isDestroyed()&&hubActive)win.webContents.send('hub:install-state',states);
  }});
  let registry=JSON.parse((await cloud.read('/catalog')||await fs.readFile(path.join(site,'catalog'))).toString('utf8'));
  async function refreshRegistry(){registry=await cloud.catalog(registry);installer.setCatalog(registry);return registry;}
  await refreshRegistry();
  installer.setCatalog(registry);
  protocol.handle('hub',async request=>{
    try{
      const pathname=assetName(request.url);
      if(pathname==='/report'&&request.method==='POST')return new Response(null,{status:204});
      if(request.method!=='GET'&&request.method!=='HEAD')return new Response(null,{status:405});
      assetPath(request.url,site);
      const file=library.file(request.url);
      let data=await cloud.read(pathname);
      if(pathname==='/catalog'){
        if(hubActive)await refreshRegistry();
        const local=library.entries();
        data=Buffer.from(JSON.stringify(registry.map(entry=>{
          const installed=local.find(game=>game.id===entry.id);
          return {...entry,artwork:installed?.artwork||new URL(entry.artwork,cloud.origin).href,
            ...(entry.attract?{attract:installed?.attract||new URL(entry.attract,cloud.origin).href}:{})};
        })));
      }
      if(!data)data=['/library','/catalog'].includes(pathname)?Buffer.from(JSON.stringify(library.entries())):await fs.readFile(file);
      if(pathname.startsWith('/games/')&&path.extname(file).toLowerCase()==='.html'){
        let html=data.toString('utf8');const tag='<script src="/runtime/core/preferences.js"></script><script data-cubby-controller src="/runtime/core/host-osd.js"></script><script data-handheld-system src="/runtime/core/game-shell.js"></script>';
        if(!html.includes(tag)){const match=/<!doctype[^>]*>/i.exec(html),at=match?match.index+match[0].length:0;data=Buffer.from(html.slice(0,at)+tag+html.slice(at));}
      }
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.webm':'video/webm','.mp4':'video/mp4','.mp3':'audio/mpeg','.png':'image/png'};
      const headers={'Content-Type':mime[path.extname(file)]||(['/library','/catalog'].includes(pathname)?'application/json':'application/octet-stream'),'Accept-Ranges':'bytes','Cache-Control':'no-store'};
      let body=data,status=200;
      const range=request.headers.get('range');
      if(range){
        const m=/^bytes=(\d+)-(\d*)$/.exec(range);
        const start=m?Number(m[1]):-1,end=m&&m[2]?Math.min(Number(m[2]),data.length-1):data.length-1;
        if(!m||!Number.isSafeInteger(start)||start<0||start> end||start>=data.length)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${data.length}`}});
        body=data.subarray(start,end+1);status=206;headers['Content-Range']=`bytes ${start}-${end}/${data.length}`;
      }
      headers['Content-Length']=String(body.length);
      if(request.method==='GET'&&pathname.startsWith('/games/')&&path.extname(file).toLowerCase()==='.html')servedDocuments.add(pathname);
      return new Response(request.method==='HEAD'?null:body,{status,headers});
    }catch{return new Response(null,{status:404});}
  });
  ipcMain.on('hub:save',(event,message)=>{
    try{
      if(event.senderFrame!==event.sender.mainFrame)throw Error('Main game frame required');
      const game=gameScope(event.senderFrame.url);
      if(message.game!==game)throw Error('Save scope mismatch');
      if(!['get','set','remove'].includes(message.operation))throw Error('Invalid operation');
      event.returnValue={value:store[message.operation](game,message.key,message.value)??null};
    }catch{event.returnValue={error:'Save operation rejected'};}
  });
  win=new BrowserWindow({show:!smoke,width:960,height:640,fullscreen:!smoke,autoHideMenuBar:true,backgroundColor:'#101614',
    webPreferences:{offscreen:smoke,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  launcher=new GameLauncher(account,library,{navigate:async url=>{
    servedDocuments.clear();hubActive=false;await win.loadURL(url);
    if(!servedDocuments.has(assetName(url)))throw Error('Game document unavailable');
  },onChange:state=>{if(hubActive&&!win.isDestroyed())win.webContents.send('hub:account-state',state);}});
  async function launchGame(id){try{return await launcher.launch(id);}catch(error){if(!hubActive&&!win.isDestroyed())await win.loadURL('hub://app/');throw error;}}
  function authorizeHub(event){requireHubFrame(event);if(event.sender!==win.webContents)throw Error('Unknown hub window');}
  ipcMain.handle('hub:account',event=>{authorizeHub(event);return launcher.status();});
  ipcMain.handle('hub:refill',event=>{authorizeHub(event);const state=account.refill();win.webContents.send('hub:account-state',state);return state;});
  ipcMain.handle('hub:launch',(event,id)=>{authorizeHub(event);return launchGame(id);});
  ipcMain.handle('hub:saved-games',event=>{authorizeHub(event);return store.savedGames();});
  ipcMain.handle('hub:reset-game-saves',(event,id)=>{authorizeHub(event);if(!hubActive||launcher.pending)throw Error('Game active');store.resetGameSaves(id);});
  ipcMain.handle('hub:library',event=>{authorizeHub(event);return library.entries();});
  ipcMain.handle('hub:install',async(event,id)=>{authorizeHub(event);await installer.install(id);return library.entries();});
  ipcMain.handle('hub:uninstall',async(event,id)=>{authorizeHub(event);await installer.uninstall(id);return library.entries();});
  ipcMain.handle('hub:install-status',event=>{authorizeHub(event);return installer.status();});
  ipcMain.handle('hub:quit',event=>{
    requireHubFrame(event);
    if(event.sender!==win.webContents)throw Error('Unknown hub window');
    win.close();
  });
  win.webContents.on('did-start-navigation',(_event,url,_inPlace,isMainFrame)=>{
    if(isMainFrame)hubActive=false;
  });
  win.webContents.on('did-navigate',(_event,url)=>{
    try{hubActive=['/','/index.html'].includes(assetName(url));}catch{hubActive=false;}
    if(hubActive)launcher.home();
    if(hubActive)refreshRegistry().then(()=>installer.checkUpdates()).catch(error=>console.error('Game update check:',error.message));
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  function guardNavigation(event,url){try{assetPath(url,site);
    const pathname=assetName(url);
    if(pathname.startsWith('/games/')){
      if(!launcher.inSession(url)){
        event.preventDefault();
        const source=assetName(win.webContents.getURL());
        if(['/', '/index.html'].includes(source)){const entry=library.entries().find(game=>assetName('hub://app'+game.entrypoint)===pathname);if(entry)setImmediate(()=>launchGame(entry.id).catch(()=>{}));}
      }else{
        // Keep browser-relative assets and the shared system shell on the same
        // canonical URL as disk identity, without starting/charging a session.
        const canonical=new URL(url);canonical.pathname=pathname.split('/').map(encodeURIComponent).join('/');
        if(canonical.href!==url){event.preventDefault();setImmediate(()=>win.loadURL(canonical.href).catch(()=>{}));}
      }
    }
  }catch{event.preventDefault();}}
  win.webContents.on('will-navigate',guardNavigation);
  win.webContents.on('will-redirect',guardNavigation);
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  win.on('blur',()=>win.webContents.executeJavaScript('document.querySelectorAll("video").forEach(v=>v.pause()); window.handheldAudio?.suspend();').catch(()=>{}));
  win.on('focus',()=>win.webContents.executeJavaScript('document.querySelectorAll("video").forEach(v=>v.play().catch(()=>{})); window.handheldAudio?.resume().catch(()=>{});').catch(()=>{}));
  await win.loadURL('hub://app/');
  if(uninstallSmoke){
    try{await require('./uninstall-smoke.cjs').run(win,installer,library,registry,store,account,{cloud,output:env('SMOKE_DIR'),package:env('SMOKE_UNINSTALL_PACKAGE')});exitSmoke(0);}
    catch(error){console.error(error);exitSmoke(1);}return;
  }
  if(installSmoke){
    try{await require('./install-smoke.cjs').run(win,installer,library,registry,{cloud,origin:cloud.origin,output:env('SMOKE_DIR')});exitSmoke(0);}
    catch(error){console.error(error);exitSmoke(1);}return;
  }
  if(smoke){
    const output=env('SMOKE_DIR');
    try{
      await new Promise(resolve=>setTimeout(resolve,1500));
      const shell={source:cloud.source,...await win.webContents.executeJavaScript(`(()=>{const previous=localStorage.getItem('cloud-smoke-visits');localStorage.setItem('cloud-smoke-visits',String(Number(previous||0)+1));return {marker:document.documentElement.dataset.cloudSmoke||null,previousVisits:previous};})()`)};
      // A smoke profile starts empty too: install explicitly through the same
      // verified Store path a user invokes, never by importing bundle bytes.
      const initialLibrary=installer.library.entries();
      if(!initialLibrary.length){
        const store=await win.webContents.executeJavaScript('document.querySelector("[aria-current=page]")?.getAttribute("aria-label")==="store" && !!document.querySelector(".game-card")');
        if(!store)throw Error('Fresh empty Library did not start on Store');
        if(output){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'empty-library-store.png'),(await win.webContents.capturePage()).toPNG());}
        if(!registry.length)throw Error('Smoke needs an explicit Store offer');
        await installer.install(registry[0].id);
        await win.loadURL('hub://app/');
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(tokenSmoke){
        await require('./token-smoke.cjs').run(win,launcher,account,installer.library,{output});
        exitSmoke(0);return;
      }
      const hub=await require('./hub-smoke.cjs').checkHub(win,output);
      const library=await win.webContents.executeJavaScript('fetch("/library").then(r=>r.json())');
      if(!library.length)throw Error('Empty smoke library');
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label=library]').click();document.querySelector('.game-card').click();`);
      await new Promise(resolve=>setTimeout(resolve,3000));
      const trailer=await win.webContents.executeJavaScript('[...document.querySelectorAll("video")].map(v=>({time:v.currentTime,error:v.error?.message,paused:v.paused}))');
      if(output){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'title.png'),(await win.webContents.capturePage()).toPNG());}
      await win.webContents.executeJavaScript(`document.querySelector('.play-game').click();`);
      await new Promise(resolve=>setTimeout(resolve,1000));
      const report=await win.webContents.executeJavaScript(`(()=>{const p=HandheldPlatform.createPlatform(window.HandheldPlatformOptions);const s=p.saves('line-cutter');s.set('desktop-smoke',{ok:true});return {kind:p.kind,save:s.get('desktop-smoke'),node:typeof require,url:location.href,canvas:!!document.getElementById('screen'),video:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,error:v.error?.message,paused:v.paused}))};})()`);
      if(output){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'desktop.png'),(await win.webContents.capturePage()).toPNG());await fs.writeFile(path.join(output,'report.json'),JSON.stringify({shell,hub,library,trailer,report},null,2));}
      console.log(JSON.stringify({shell,hub,library,trailer,report}));
      if(report.kind!=='desktop'||!report.save?.ok||report.node!=='undefined'||!report.canvas||report.video.length||!report.url.endsWith(library[0].entrypoint)||!trailer.some(v=>v.time>0&&!v.paused&&!v.error))throw Error('Desktop bridge smoke failed');
      const gameQuit=await win.webContents.executeJavaScript("HandheldPlatformOptions.bridge.quit().then(()=>false,()=>true)");
      if(!gameQuit)throw Error('Game page was allowed to quit the app');
      // Exercise the host-owned menu, not the game's optional Quit callback.
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      await new Promise(resolve=>setTimeout(resolve,200));
      if(!await win.webContents.executeJavaScript('HandheldGameShell.isOpen()'))throw Error('System menu did not open');
      if(output)await fs.writeFile(path.join(output,'system-menu.png'),(await win.webContents.capturePage()).toPNG());
      // Pointer activation on the resume picture must return to the same game.
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Resume game"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));`);
      if(await win.webContents.executeJavaScript('HandheldGameShell.isOpen()'))throw Error('System menu resume failed');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      await new Promise(resolve=>setTimeout(resolve,400));
      if(!await win.webContents.executeJavaScript('!!document.querySelector(".game-card")'))throw Error('System menu did not return to library');
      win.once('closed',()=>console.log('Desktop Quit closed window'));
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label=options]').click();document.querySelector('.quit-app').click();document.querySelector('[aria-label=\"Confirm quit\"]').click();`);
    }catch(error){console.error(error);exitSmoke(1);}
  }
});
// Explicit smoke exits must retain their status as the windows close; a normal
// pictorial Quit still follows Electron's regular last-window shutdown path.
app.on('window-all-closed',()=>{if(!explicitSmokeExit)app.quit();});
